#!/bin/bash
# context-gaps session tagger — extracts structured data from session JSONL
#
# Fires on Stop event. Parses transcript, emits gap candidates to
# ~/.claude/context-gaps/pending-<session_id>.jsonl
#
# Timeout: 5 seconds. On timeout, exits silently with no output.

set -euo pipefail

INPUT=$(cat)

BUN="${BUN_PATH:-$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")}"
if [ ! -x "$BUN" ]; then
  echo '{}'
  exit 0
fi

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_DIR="$(cd "$HOOK_DIR/../scripts" && pwd)"

echo "$INPUT" | "$BUN" "$SCRIPT_DIR/tagger-cli.ts" 2>/dev/null || true

echo '{}'
exit 0
