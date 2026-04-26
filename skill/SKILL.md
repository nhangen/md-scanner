---
name: md-scanner
description: Scans markdown documentation against actual behavioral data to find what's missing. Recommends additions to CLAUDE.md, rules, memory, and skills.
version: 1.0.0
author: nhangen
---

# md-scanner

Analyzes session history to find patterns where missing documentation caused wasted tokens — repeated file reads, command trial-and-error, recurring user corrections, context bloat, and more. Recommends specific additions to the right documentation surface.

## Usage

```
/context-gaps              Full walkthrough
/context-gaps review       Deferred items only
/context-gaps report       Non-interactive summary
```

## Data Sources

This skill reads from four existing systems. Run the load commands below, skip any that fail (optional dependencies).

### Step 1: Load pending session extracts

Read all files matching `~/.claude/context-gaps/pending-*.jsonl`. Each file is one session's structured extract containing file read counts, bash commands, tool sequences, user messages, file edit sets, and token usage.

Also read `~/.claude/context-gaps/applied.jsonl`, `~/.claude/context-gaps/dismissed.jsonl`, and `~/.claude/context-gaps/deferred.jsonl` if they exist. Each line is a JSON record with a `fingerprint` field. Build an exclusion set from applied + dismissed records. Build a deferred set from deferred records.

### Step 2: Load token-scope context data

Run via Bash (skip if token-scope not installed):
```bash
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH"
token-scope --context --json 2>/dev/null || echo '{"error": "token-scope not available"}'
```

This returns context bloat data per session (bloatRatio, input token growth). Group results by `cwd` to identify which projects have high bloat.

### Step 3: Load RTK missed optimizations

Run via Bash (skip if RTK not installed):
```bash
rtk discover 2>/dev/null || echo "RTK not available"
```

### Step 4: Load claude-mem observations

Use the claude-mem MCP `search` tool to find:
- Observations with type `feedback` (recurring corrections)
- Observations with frequently appearing `concepts` that may not be documented

Query: `search("feedback OR correction OR repeated", limit=50, type="feedback")`
Then: `search("", limit=100, orderBy="created_at_epoch DESC")` to get recent concept tags.

### Step 5: Load current documentation

Read these files (skip any that don't exist):
- Project CLAUDE.md (from the most common `project_path` in pending extracts)
- `~/.claude/CLAUDE.md` (global)
- All files in `~/.claude/rules/` directory
- `~/.claude/projects/*/memory/MEMORY.md` (memory index files)

## Analysis

### Aggregate pending extracts

Group all pending files by `project_path`. For each project, merge across sessions:
- **File read frequency**: `{filepath: [session_ids]}` — count how many sessions read each file
- **Bash error patterns**: group by command prefix (first word), list sessions with errors
- **User messages**: collect all, deduplicate exact matches
- **File edit sets**: count co-occurrence of file pairs across sessions
- **Out-of-project paths**: collect all, count frequency

### Detect patterns

Apply these detectors in order. For each, check the exclusion set — skip if fingerprint matches an applied or dismissed record.

**1. Repeated file reads** — Files read in 3+ sessions (cold start: < 10 sessions) or 5+ sessions (mature). Evidence: session count, estimated tokens (sum `turn_tokens` from turns containing that file's Read calls).

**2. Command trial-and-error** — Bash commands where the same binary (first word of command) has `is_error: true` in 2+ sessions. Cross-reference with RTK discover output if available. Evidence: session count, the failing and succeeding command variants.

**3. Repeated user statements** — Read the user message corpus (max 50 messages, most recent sessions first). Cluster semantically similar statements — you are the clustering engine. Look for messages where the user is telling Claude the same thing across sessions. If corpus exceeds 50 messages, flag: "Large message corpus — showing top 50 most recent. Some patterns may be missed." Evidence: the repeated statement, session count.

**4. Context bloat** — From token-scope data, find projects where 3+ sessions have bloatRatio > 2.0 AND the project's CLAUDE.md is either missing or under 50 lines. Evidence: average bloatRatio, session count, CLAUDE.md line count.

**5. Undocumented concepts** — From claude-mem observations, find concept tags appearing in 5+ observations that don't match any keyword in the project's CLAUDE.md (case-insensitive substring match). Evidence: concept name, observation count, sample observation titles.

**6. File pair co-occurrence** — File pairs appearing in the same edit set in 3+ sessions. Evidence: the two files, session count.

**7. Cross-project confusion** — Out-of-project paths appearing in 2+ sessions from the same project. Evidence: the wrong path, the project it was accessed from, session count.

**8. Skill candidates** — From sessions with high total token cost (top 25%), compress tool sequences via run-length encoding (e.g., `Read×4, Grep×2, Edit, Bash×3`). Present the compressed sequences for human review. Do not attempt automated similarity detection — just show the patterns. Evidence: the compressed sequence, session cost.

### Route recommendations

For each detected pattern, determine the target:

- Pattern in one project only → **project CLAUDE.md**
- Pattern across multiple projects → **`~/.claude/CLAUDE.md`** (global)
- Pattern is a behavioral constraint ("never X", "always Y") → **`~/.claude/rules/<name>.md`** (follow creating-rules process: YAML frontmatter with `description` and `globs`, matching section in `~/.claude/CLAUDE.md`)
- Pattern is environment/tool context → **memory file** in the project's memory directory
- Pattern is a read-only Bash command that prompts repeatedly (`allowlist-gap`) → **project `.claude/settings.local.json`** under `permissions.allow[]`. If the file doesn't exist, create it (gitignored convention). Don't write to the committed `.claude/settings.json` unless the project explicitly uses that path for personal allowlists. Note: this detector currently covers Bash only; MCP tool allowlisting is tracked as a follow-up.
- Pattern is a CLAUDE.md section whose commands/paths never appear in transcripts (`claudemd-unused-section`) → **project CLAUDE.md** — propose archival or rewrite. The section may have been written speculatively; behavioral data shows it's never exercised. User may reject if the section documents a future workflow not yet adopted.
- Pattern is a re-read file that IS documented but still gets re-read (`claudemd-undocumented-repeat`) → **memory file** — the doc exists but the routing/content isn't surfacing in-context. Cache the relevant values directly (e.g., resolved paths, taxonomies) rather than the file path/reference. Different fix from `repeated-file-read` (which assumes no doc exists).
- Pattern is a global rule out of sync between Cursor and Claude (`rule-drift`, cron-only) → **whichever rule directory** the user picks. Walkthrough offers Cursor → Claude or Claude → Cursor for each drifted rule; for `cursor-only` / `claude-only` cases, default action is to copy across (with frontmatter conversion: `.mdc` ↔ `.md`, `alwaysApply` ↔ `globs`). Only fires in cron mode — drift is rare and slow-changing, not worth running per-Stop.
- Pattern is a repeated workflow → **flag as skill candidate** (no auto-creation, just recommend)

### Rank

Sort by frequency (sessions affected), use estimated token cost as tiebreaker. Show trend as visual indicator:
- ↑ if more than 50% of occurrences are in the most recent third of sessions
- ↓ if more than 50% are in the oldest third
- → otherwise

## Walkthrough

If mode is `report`: print a markdown table of all findings grouped by pattern type (pattern, evidence summary, frequency, cost estimate, trend, target surface). No edits. Done.

If mode is `review`: filter to deferred items only, then proceed with walkthrough below.

If mode is default (full walkthrough):

Prompt: **"Found N recommendations. Walk through now, or save for later?"**
- If "save for later": write all findings to `deferred.jsonl` with action `"deferred"` and exit
- If "walk through": proceed below

For each recommendation, highest score first, present:

```
--- Recommendation N of M ---

Pattern: <pattern type in plain English>
Evidence: <primary evidence statement>
Cost: ~<token estimate> across <N> sessions
Trend: <↑/↓/→> <context>

Target: <file path>, under "<section name>"

Proposed addition:

  <the actual text to add, indented>

Approve, skip, edit, defer, or quit (defers remaining)?
```

Handle responses:
- **approve** → Apply the edit using the Edit tool (or Write for new files). Read the target file first to find the right insertion point. Append a record to `~/.claude/context-gaps/applied.jsonl`.
- **skip** → Append to `~/.claude/context-gaps/dismissed.jsonl`. Will not resurface.
- **edit** → User describes changes. Revise the proposed text. Present again for approval.
- **defer** → Append to `~/.claude/context-gaps/deferred.jsonl`. Resurfaces on `/context-gaps review`.
- **quit** → Defer all remaining recommendations.

For rules: follow the creating-rules process in `~/.cursor/rules/creating-rules.mdc` — create the `.md` file with frontmatter, add matching section to `~/.claude/CLAUDE.md`.

## Cleanup

After walkthrough completes:

1. For each `pending-<session_id>.jsonl` file: check if all recommendations that used data from that session have been resolved (applied, dismissed, or deferred). If yes, delete the pending file.

2. When reading `dismissed.jsonl` and `deferred.jsonl`, skip records where `timestamp` is more than 90 days old. These patterns may have become relevant again.

## Fingerprinting

A recommendation's fingerprint is `{pattern_type, target_file, primary_key}`:
- File patterns: `primary_key` = the file path
- Command patterns: `primary_key` = the command binary name
- User statements: `primary_key` = SHA-256 of lowercased, whitespace-collapsed cluster representative text, truncated to 16 hex chars
- Concepts: `primary_key` = the concept name
- File pairs: `primary_key` = both paths joined with `|`, sorted alphabetically
- Cross-project: `primary_key` = the wrong path
- Skill candidates: `primary_key` = `"skill-candidate"` (always show, never auto-dismiss)
