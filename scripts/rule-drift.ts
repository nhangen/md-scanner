// Rule-drift detection — pure config check, no transcript data.
//
// Compares ~/.cursor/rules/*.mdc against ~/.claude/rules/*.md. For each pair,
// strips YAML frontmatter and diffs the body. Surfaces drifted rules so the
// walkthrough can offer "keep Cursor side / keep Claude side / show diff."
//
// Cron-only — drift changes slowly and the detector touches the user's home
// directory; running it on every Stop hook would be wasteful. The CLI gates
// this detector behind --mode=cron.

import { existsSync, readdirSync } from "fs";
import { join } from "path";
import type { DetectorFinding } from "./types";
import { safeReadFile } from "./safe-read";

const CURSOR_RULES_DIR = join(process.env.HOME ?? "~", ".cursor", "rules");
const CLAUDE_RULES_DIR = join(process.env.HOME ?? "~", ".claude", "rules");

/**
 * Strip YAML frontmatter from a markdown file's contents. Identical to the
 * sync-rules skill's `strip_body` awk one-liner — wait for the second `---`
 * delimiter and return everything after it. Files without frontmatter return
 * unchanged.
 */
export function stripFrontmatter(content: string): string {
  const lines = content.split("\n");
  if (lines.length === 0) return content;
  if (lines[0].trim() !== "---") return content;

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return content;
  return lines.slice(endIdx + 1).join("\n");
}

/**
 * Normalize quote characters for diff purposes. The sync-rules skill discovered
 * twice today that smart quotes vs straight quotes generate spurious diffs.
 */
export function normalizeQuotes(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/—/g, "--")
    .replace(/–/g, "-");
}

export interface RuleDriftEntry {
  rule_name: string;
  status: "cursor-only" | "claude-only" | "differs" | "unreadable";
  cursor_path: string;
  claude_path: string;
}

/**
 * Compare the two rule directories. Returns one entry per drifted rule.
 * Pairs that match are not returned.
 */
export function detectRuleDriftEntries(
  cursorDir: string = CURSOR_RULES_DIR,
  claudeDir: string = CLAUDE_RULES_DIR,
): RuleDriftEntry[] {
  if (!existsSync(cursorDir) && !existsSync(claudeDir)) return [];

  const cursorNames = listRuleNames(cursorDir, ".mdc");
  const claudeNames = listRuleNames(claudeDir, ".md");

  const all = new Set([...cursorNames, ...claudeNames]);
  const entries: RuleDriftEntry[] = [];

  for (const name of all) {
    const cursorPath = join(cursorDir, `${name}.mdc`);
    const claudePath = join(claudeDir, `${name}.md`);
    const inCursor = cursorNames.has(name);
    const inClaude = claudeNames.has(name);

    if (inCursor && !inClaude) {
      entries.push({ rule_name: name, status: "cursor-only", cursor_path: cursorPath, claude_path: claudePath });
      continue;
    }
    if (!inCursor && inClaude) {
      entries.push({ rule_name: name, status: "claude-only", cursor_path: cursorPath, claude_path: claudePath });
      continue;
    }

    const cursorRead = safeReadFile(cursorPath);
    const claudeRead = safeReadFile(claudePath);
    if (!cursorRead.ok || !claudeRead.ok) {
      // At least one side exists (the listing said so) but read failed.
      // Surface as a finding so the user sees it; safeReadFile counts the
      // degradation. Without this, drift between two unreadable files would
      // be invisible to the analyzer.
      entries.push({
        rule_name: name,
        status: "unreadable",
        cursor_path: cursorPath,
        claude_path: claudePath,
      });
      continue;
    }

    const cursorBody = normalizeQuotes(stripFrontmatter(cursorRead.content));
    const claudeBody = normalizeQuotes(stripFrontmatter(claudeRead.content));

    if (cursorBody !== claudeBody) {
      entries.push({ rule_name: name, status: "differs", cursor_path: cursorPath, claude_path: claudePath });
    }
  }

  return entries.sort((a, b) => a.rule_name.localeCompare(b.rule_name));
}

function listRuleNames(dir: string, ext: string): Set<string> {
  if (!existsSync(dir)) return new Set();
  try {
    return new Set(
      readdirSync(dir)
        .filter((f) => f.endsWith(ext))
        .map((f) => f.slice(0, -ext.length)),
    );
  } catch {
    return new Set();
  }
}

/**
 * Wraps detectRuleDriftEntries as a DetectorFinding[]. One finding per drifted
 * rule. Session count is 1 (these are config-only findings, not session-derived).
 */
export function detectRuleDrift(): DetectorFinding[] {
  const entries = detectRuleDriftEntries();
  return entries.map((entry) => {
    let evidence: string;
    if (entry.status === "cursor-only") {
      evidence = `Rule "${entry.rule_name}" exists in ~/.cursor/rules/ but not ~/.claude/rules/. Copy it across (drop alwaysApply, add globs).`;
    } else if (entry.status === "claude-only") {
      evidence = `Rule "${entry.rule_name}" exists in ~/.claude/rules/ but not ~/.cursor/rules/. Copy it across (preserve globs, add alwaysApply if needed).`;
    } else if (entry.status === "unreadable") {
      evidence = `Rule "${entry.rule_name}" exists in both directories but at least one side is unreadable. Investigate file permissions; until resolved, drift detection is degraded for this rule.`;
    } else {
      evidence = `Rule "${entry.rule_name}" body differs between Cursor and Claude versions.`;
    }
    return {
      pattern_type: "rule-drift",
      evidence,
      session_ids: [],
      session_count: 1,
      trend: "steady",
      estimated_tokens: 0,
      recommended_surface: "rules",
      fingerprint: {
        pattern_type: "rule-drift",
        target_file: entry.status === "cursor-only" ? entry.claude_path : entry.cursor_path,
        primary_key: entry.rule_name,
      },
    };
  });
}
