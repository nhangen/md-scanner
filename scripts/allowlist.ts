// Allowlist detection helpers — extracts command-pair frequencies and proposes
// project .claude/settings.local.json entries for read-only commands the user
// runs ≥N times that aren't already allowlisted and aren't auto-allowed by
// Claude Code's built-in rules.
//
// Source-of-truth for built-in auto-allows:
//   src/tools/BashTool/readOnlyValidation.ts (READONLY_COMMANDS, READONLY_NOARGS,
//   READONLY_EXACT, COMMAND_ALLOWLIST) and
//   src/utils/shell/readOnlyCommandValidation.ts (GIT_READ_ONLY_COMMANDS,
//   GH_READ_ONLY_COMMANDS, DOCKER_READ_ONLY_COMMANDS, RIPGREP_READ_ONLY_COMMANDS,
//   PYRIGHT_READ_ONLY_COMMANDS).
//
// Mirrored here so the analyzer can run without parsing the Claude Code source.

import { existsSync, readFileSync } from "fs";

// Always auto-allowed (any args).
const AUTO_ALLOW_ANY_ARGS = new Set([
  "cal", "uptime", "cat", "head", "tail", "wc", "stat", "strings", "hexdump",
  "od", "nl", "id", "uname", "free", "df", "du", "locale", "groups", "nproc",
  "basename", "dirname", "realpath", "cut", "paste", "tr", "column", "tac",
  "rev", "fold", "expand", "unexpand", "fmt", "comm", "cmp", "numfmt",
  "readlink", "diff", "true", "false", "sleep", "which", "type", "expr",
  "test", "getconf", "seq", "tsort", "pr", "echo", "printf", "ls", "cd", "find",
  // Validated read-only with safe flags
  "xargs", "file", "sed", "sort", "man", "help", "netstat", "ps", "base64",
  "grep", "egrep", "fgrep", "sha256sum", "sha1sum", "md5sum", "tree", "date",
  "hostname", "info", "lsof", "pgrep", "tput", "ss", "fd", "fdfind", "aki",
  "rg", "jq", "uniq", "history", "arch", "ifconfig", "pyright",
]);

// Auto-allowed git/gh/docker subcommands. Stored as "tool subcmd" keys.
const AUTO_ALLOW_PAIRS = new Set([
  // git read-only
  "git status", "git log", "git diff", "git show", "git blame", "git branch",
  "git tag", "git remote", "git ls-files", "git ls-remote", "git config",
  "git rev-parse", "git describe", "git stash", "git reflog", "git shortlog",
  "git cat-file", "git for-each-ref", "git worktree",
  // gh read-only
  "gh pr", "gh issue", "gh run", "gh workflow", "gh repo", "gh release",
  "gh api", "gh auth",
  // docker read-only
  "docker ps", "docker images", "docker logs", "docker inspect",
]);

// Equivalent to arbitrary code execution — never allowlist. Stripped from
// candidate list regardless of frequency.
const ARBITRARY_CODE_EXECUTORS = new Set([
  "python", "python3", "node", "bun", "deno", "ruby", "perl", "php", "lua",
  "bash", "sh", "zsh", "fish", "eval", "exec", "ssh",
  "npx", "bunx", "uvx", "make", "just",
  "/bin/bash", "/bin/sh", "/bin/zsh",
]);

// MCP write-pattern markers — surfaces with these substrings get filtered.
const MCP_WRITE_MARKERS = ["create", "update", "delete", "set", "remove", "add", "post", "patch", "put", "send"];

/**
 * Parse a Bash command into an allowlist key (the first 1-2 meaningful tokens).
 * Returns null if the command is empty, an interpreter, or otherwise unallowlistable.
 */
export function commandToAllowlistKey(rawCmd: string): string | null {
  let cmd = rawCmd.trim();
  if (!cmd) return null;

  // Strip leading env-var assignments: `export X=Y && cmd` or `X=Y cmd`
  cmd = cmd.replace(/^(export\s+\S+="?[^"]*"?\s*&&\s*)+/, "");
  cmd = cmd.replace(/^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+/, "");

  // Strip prefixes that don't change the underlying command identity
  while (true) {
    const m = cmd.match(/^(?:sudo|timeout\s+\S+|rtk|nohup)\s+(.*)$/);
    if (!m) break;
    cmd = m[1];
  }

  // Take leading pipeline/conjunction segment
  cmd = cmd.split(/\s*(?:\||&&|\|\||;|>|<)\s*/)[0].trim();
  if (!cmd) return null;

  const tokens = cmd.split(/\s+/);
  const head = tokens[0];

  // Reject arbitrary-code executors outright
  if (ARBITRARY_CODE_EXECUTORS.has(head)) return null;
  if (head.startsWith("/") && /\.(sh|bash|py|js|ts)$/.test(head)) {
    // Absolute-path scripts: allowlist by full path
    return head;
  }

  const second = tokens[1];
  if (!second || second.startsWith("-") || second.startsWith("$")) {
    return head;
  }
  // Skip dashed/quoted/path-like second tokens — those are args not subcommands
  if (second.startsWith("/") || second.startsWith("'") || second.startsWith('"')) {
    return head;
  }

  return `${head} ${second}`;
}

/**
 * Returns true if a command-pair key is auto-allowed by Claude Code's built-in
 * rules (no allowlist entry needed).
 */
export function isAutoAllowed(key: string): boolean {
  const head = key.split(" ")[0];
  if (AUTO_ALLOW_ANY_ARGS.has(head)) return true;
  if (AUTO_ALLOW_PAIRS.has(key)) return true;
  return false;
}

/**
 * Returns true if a command pair would grant arbitrary code execution if allowlisted.
 */
export function isArbitraryCode(key: string): boolean {
  const head = key.split(" ")[0];
  return ARBITRARY_CODE_EXECUTORS.has(head);
}

/**
 * Read existing allow patterns from a project's .claude/settings.json and
 * .claude/settings.local.json. Returns the union as a Set of literal pattern
 * strings (e.g., `Bash(gh pr view *)`).
 */
export function loadExistingAllowlist(projectPath: string): Set<string> {
  const result = new Set<string>();
  const candidates = [
    `${projectPath}/.claude/settings.json`,
    `${projectPath}/.claude/settings.local.json`,
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const data = JSON.parse(readFileSync(path, "utf-8"));
      const allow = data?.permissions?.allow;
      if (Array.isArray(allow)) {
        for (const entry of allow) {
          if (typeof entry === "string") result.add(entry);
        }
      }
    } catch {
      // malformed JSON — skip
    }
  }
  return result;
}

/**
 * Format a command-pair key as a Bash() allowlist pattern.
 * Two-token pairs use ` *` suffix (for variant args); single-token uses ` *` only
 * if not an exact invocation we'd want to match exactly.
 */
export function formatAllowPattern(key: string): string {
  return `Bash(${key} *)`;
}

/**
 * MCP tool name passes-through as its own allow pattern.
 * Filters out tools matching write markers in their name (heuristic).
 */
export function isReadOnlyMcp(toolName: string): boolean {
  if (!toolName.startsWith("mcp__")) return false;
  const lower = toolName.toLowerCase();
  for (const marker of MCP_WRITE_MARKERS) {
    if (lower.includes(marker)) return false;
  }
  return true;
}
