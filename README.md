# md-scanner

Scans your markdown documentation (CLAUDE.md, rules, memory files) against actual behavioral data to find what's missing. Recommends specific additions via a guided walkthrough.

## The Problem

You keep telling Claude the same things session after session. You re-read the same files. You retry the same commands. Your CLAUDE.md has good structure but is missing the context that would actually save time.

Existing tools check if your docs are well-formed. md-scanner checks if they're **useful** — by analyzing what actually happens during sessions.

## How It Works

**Session tagger** (Stop hook) — after each session, parses the JSONL transcript and extracts:
- Files read and how often
- Bash commands and which ones failed
- User messages (what you kept telling Claude)
- Files edited together
- Tool call sequences
- Out-of-project path access

**`/md-scanner` skill** — on demand, correlates patterns across sessions:
- Cross-references with token-scope (context bloat), RTK (command failures), and claude-mem (recurring concepts)
- Diffs findings against your current CLAUDE.md, rules, and memory files
- Routes each recommendation to the right surface
- Walks you through approve/skip/edit/defer for each one

## What It Detects

| Pattern | Signal | Example |
|---------|--------|---------|
| Repeated file reads | Same file read in 5+ sessions | "AnalyticsResource.php read in 11 of 15 sessions" |
| Command trial-and-error | Same binary fails across sessions | "npm run build fails in 3 sessions, npm run build:dev succeeds" |
| Repeated user statements | You keep saying the same thing | "update obsidian" said in 7 of 18 sessions |
| Context bloat | Sessions start expensive | "bloatRatio > 2.0 in 4 sessions, CLAUDE.md is 30 lines" |
| Undocumented concepts | Concepts in observations but not in docs | "Mozart vendoring in 10 observations, not in CLAUDE.md" |
| File pair co-occurrence | Files always edited together | "Checkout.php + PlanResource.php in 5 sessions" |
| Cross-project confusion | Wrong repo paths accessed | "/other/wp-content/file.php from this project in 3 sessions" |
| Skill candidates | Repeated tool sequences | "Read x4, Grep x2, Edit, Bash x3 in 4 sessions" |

## Where It Routes

| Condition | Target |
|-----------|--------|
| Single project pattern | Project CLAUDE.md |
| Cross-project pattern | `~/.claude/CLAUDE.md` |
| Behavioral constraint | `~/.claude/rules/<name>.md` |
| Environment/tool context | Memory file |
| Repeated workflow | Skill candidate (flagged for review) |

## Usage

```
/md-scanner              Full guided walkthrough
/md-scanner review       Deferred items only
/md-scanner report       Non-interactive summary table
```

### Example walkthrough

```
--- Recommendation 1 of 6 ---

Pattern: Repeated user statement
Evidence: "update obsidian" instruction in 7 of 18 sessions
Cost: ~12,000 tokens on repeated instructions
Trend: -> steady

Target: ~/.claude/CLAUDE.md

Proposed addition:

  ## Obsidian Session Capture
  At the end of every session that involves meaningful work,
  update Obsidian using /obsidian:save. Do not wait to be asked.

Approve, skip, edit, defer, or quit (defers remaining)?
```

## Install

### As a global skill (recommended)

```bash
# Copy the skill
mkdir -p ~/.claude/skills/md-scanner
cp skill/SKILL.md ~/.claude/skills/md-scanner/SKILL.md

# Install tagger dependencies
bun install

# Add Stop hook to settings.json (add to hooks.Stop array)
# {
#   "type": "command",
#   "command": "bash \"/path/to/md-scanner/hooks/context-gaps-tagger.sh\"",
#   "timeout": 5000
# }
```

### Data sources (optional, enhance detection)

- **token-scope** — context bloat detection (`token-scope --context --json`)
- **RTK** — command failure patterns (`rtk discover`)
- **claude-mem** — recurring concepts and feedback observations

The skill degrades gracefully if any are missing.

## State

All state lives in `~/.claude/context-gaps/`:

```
pending-<session_id>.jsonl   — raw session extracts (one per session)
applied.jsonl                — accepted recommendations (won't re-suggest)
dismissed.jsonl              — skipped recommendations (won't re-suggest)
deferred.jsonl               — saved for /md-scanner review
```

Records auto-expire after 90 days.

## Requirements

- Bun 1.1.0+
- Claude Code with Stop hook support

## License

MIT
