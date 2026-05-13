# md-scanner

**Behavioral audit for your Claude Code markdown — finds what's missing from CLAUDE.md, rules, and memory by analyzing what actually happens during sessions.**

## Why

You keep telling Claude the same things session after session. You re-read the same files. You retry the same commands. Your CLAUDE.md has good structure but is missing the context that would actually save time.

Existing tools check if your docs are well-formed. md-scanner checks if they're useful — by parsing session transcripts, correlating with token-scope / RTK / claude-mem, and surfacing patterns that should have been documented.

## How it works

A `Stop` hook runs after every session, parses the JSONL transcript, and writes a structured extract to `~/.claude/context-gaps/pending-<session_id>.jsonl`. The `/md-scanner` skill correlates those extracts across sessions, diffs against your current docs, routes each finding to the right surface (project CLAUDE.md, global CLAUDE.md, rule file, memory, or skill candidate), and walks you through approve / skip / edit / defer.

## Skills

| Skill | Trigger | Purpose |
|-------|---------|---------|
| `md-scanner` | `/md-scanner` | Full guided walkthrough across all pending extracts |
| `md-scanner` | `/md-scanner review` | Re-surface previously deferred items only |
| `md-scanner` | `/md-scanner report` | Non-interactive summary table — no prompts |

## Hooks

| Event | Script | Purpose |
|-------|--------|---------|
| `Stop` | `hooks/context-gaps-tagger.sh` | Parse the session JSONL and write a per-session extract to `~/.claude/context-gaps/` |

## Detected patterns

| Pattern | Signal | Example |
|---------|--------|---------|
| Repeated file reads | Same file read in 5+ sessions | `AnalyticsResource.php` read in 11 of 15 sessions |
| Command trial-and-error | Same binary fails across sessions | `npm run build` fails in 3 sessions, `npm run build:dev` succeeds |
| Repeated user statements | Same instruction repeated | "update obsidian" said in 7 of 18 sessions |
| Context bloat | Sessions start expensive | `bloatRatio > 2.0` in 4 sessions, CLAUDE.md is 30 lines |
| Undocumented concepts | Concepts in observations but not in docs | "Mozart vendoring" in 10 observations, not in CLAUDE.md |
| File pair co-occurrence | Files always edited together | `Checkout.php` + `PlanResource.php` in 5 sessions |
| Cross-project confusion | Wrong repo paths accessed | `/other/wp-content/file.php` from this project in 3 sessions |
| Skill candidates | Repeated tool sequences | Read x4, Grep x2, Edit, Bash x3 in 4 sessions |

## Routing

| Condition | Target |
|-----------|--------|
| Single-project pattern | Project `CLAUDE.md` |
| Cross-project pattern | `~/.claude/CLAUDE.md` |
| Behavioral constraint | `~/.claude/rules/<name>.md` |
| Environment / tool context | Memory file |
| Repeated workflow | Skill candidate (flagged for review) |

## Examples

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

Via the Claude Code plugin marketplace:

```
/plugin install md-scanner@nhangen
```

Manual install (skill + hook only):

```bash
mkdir -p ~/.claude/skills/md-scanner
cp skill/SKILL.md ~/.claude/skills/md-scanner/SKILL.md
bun install
```

Then add the Stop hook to `~/.claude/settings.json`:

```json
{
  "type": "command",
  "command": "bash \"/path/to/md-scanner/hooks/context-gaps-tagger.sh\"",
  "timeout": 5000
}
```

## Development

```bash
bun install
bun test                 # tagger + analyzer tests
bun run typecheck        # tsc --noEmit
bun run analyze          # run analyzer-cli.ts against pending extracts
bun run setup-cron       # install a cron job to run the analyzer periodically
```

## Optional data sources

The analyzer degrades gracefully when these are missing — install them to enrich detection.

| Source | Adds |
|--------|------|
| [token-scope](https://github.com/nhangen/token-scope) | Context bloat per session (`token-scope --context --json`) |
| [RTK](https://github.com/nhangen/rtk) | Command failure patterns (`rtk discover`) |
| [claude-mem](https://github.com/thedotmack/claude-mem) | Recurring concepts and feedback observations |

## State

All state lives in `~/.claude/context-gaps/`:

| File | Purpose |
|------|---------|
| `pending-<session_id>.jsonl` | Raw session extracts, one file per session |
| `applied.jsonl` | Accepted recommendations (won't re-suggest) |
| `dismissed.jsonl` | Skipped recommendations (won't re-suggest) |
| `deferred.jsonl` | Saved for `/md-scanner review` |

Records auto-expire after 90 days.

## Known limitations

- Requires Bun 1.1.0+ — the tagger and analyzer are written in TypeScript executed via Bun.
- The Stop hook reads the full session JSONL; very large transcripts (>50MB) increase Stop-event latency.
- Skill candidate detection is conservative — it flags repeated tool sequences but doesn't auto-generate skill scaffolds.

## License

MIT
