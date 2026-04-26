// CLAUDE.md behavioral mismatch helpers.
//
// Two detectors live in analyzer.ts that use this module:
//
//   detectClaudeMdUnusedSection — flags ## sections in the project's CLAUDE.md
//     whose content (commands, file paths, rule references) never appears in
//     transcripts. Candidate-for-archival signal.
//
//   detectClaudeMdUndocumentedRepeat — refines existing repeated-file-read
//     findings by checking whether the file is mentioned in CLAUDE.md or
//     memory files. If it IS mentioned but is still being re-read, the doc
//     isn't being followed (different fix from "doc is missing").
//
// Both are best-effort against arbitrary CLAUDE.md structure. Parse failures
// log and return empty rather than crashing the analyzer.

import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface ClaudeMdSection {
  title: string;
  body: string;
  // Tokens extracted from body for matching against transcript data:
  commands: string[]; // bash-shaped (`gh pr view`, `composer phpcs`)
  paths: string[];    // absolute or `~/`-prefixed paths
  rule_refs: string[]; // referenced rule names (`safety-invariant-scope`)
}

const COMMAND_PATTERN = /`([a-zA-Z][a-zA-Z0-9_-]*(?:\s+[a-zA-Z][a-zA-Z0-9_-]*)?(?:\s+[a-zA-Z][a-zA-Z0-9_-]*)?)`/g;
const PATH_PATTERN = /`((?:\/|~\/)[A-Za-z0-9_./~-]+)`/g;
const RULE_REF_PATTERN = /`([a-z][a-z0-9-]+(?:-[a-z0-9]+)+)`/g;

/**
 * Parse a CLAUDE.md (or any md file) into its `## ` sections. Each section
 * tracks the title, raw body, and extracted command/path/rule tokens for
 * downstream matching.
 *
 * Returns [] on read or parse failure — the analyzer's invariant is that
 * detectors never crash the run.
 */
export function parseClaudeMdSections(filePath: string): ClaudeMdSection[] {
  if (!existsSync(filePath)) return [];

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const sections: ClaudeMdSection[] = [];
  const lines = content.split("\n");

  let currentTitle: string | null = null;
  let currentBody: string[] = [];

  const flush = () => {
    if (currentTitle === null) return;
    const body = currentBody.join("\n");
    sections.push({
      title: currentTitle,
      body,
      commands: extractCommands(body),
      paths: extractPaths(body),
      rule_refs: extractRuleRefs(body),
    });
    currentTitle = null;
    currentBody = [];
  };

  for (const line of lines) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) {
      flush();
      currentTitle = m[1].trim();
      continue;
    }
    if (currentTitle !== null) currentBody.push(line);
  }
  flush();

  return sections;
}

function extractCommands(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(COMMAND_PATTERN)) {
    const cmd = m[1].trim();
    if (cmd.length < 2) continue;
    if (/^[A-Z_]+$/.test(cmd)) continue; // ENV_VAR shapes
    out.push(cmd);
  }
  return out;
}

function extractPaths(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(PATH_PATTERN)) {
    out.push(m[1].trim());
  }
  return out;
}

function extractRuleRefs(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(RULE_REF_PATTERN)) {
    const ref = m[1].trim();
    // hyphenated kebab-case-only — looks like a rule name (vs. `gh pr` which has space)
    if (ref.length < 5) continue;
    if (ref.includes(".")) continue; // file extensions, version numbers
    out.push(ref);
  }
  return out;
}

/**
 * Normalize a path by collapsing `~/` and `~/home/<user>` to a stable form for
 * substring matching. Handles the case where CLAUDE.md mentions `~/.claude/...`
 * and the transcript records `/Users/foo/.claude/...`.
 */
export function normalizePath(path: string, home: string = process.env.HOME ?? ""): string {
  if (path.startsWith("~/")) return path.slice(2);
  if (home && path.startsWith(home + "/")) return path.slice(home.length + 1);
  return path;
}

/**
 * Returns true if any of the section's commands appears as the leading 1-2
 * tokens of any session's bash commands. Cheap substring check (case-sensitive
 * for command tokens — case usually matters in shell).
 *
 * Returns false when the section has no extracted commands. The caller
 * (`detectClaudeMdUnusedSections`) treats this as "no command-usage signal"
 * and falls through to path matching, rather than masking a path-only
 * mismatch with a false-positive command-match. The early-return at the top
 * of the detector loop already skips prose-only sections (no commands AND no
 * paths), so this won't yield spurious flags.
 */
export function sectionHasCommandUsage(
  section: ClaudeMdSection,
  bashCommandKeys: Set<string>,
): boolean {
  if (section.commands.length === 0) return false;
  for (const cmd of section.commands) {
    if (bashCommandKeys.has(cmd)) return true;
    // tolerate single-token sections matching head of any pair
    const head = cmd.split(" ")[0];
    for (const key of bashCommandKeys) {
      if (key === head || key.startsWith(head + " ")) return true;
    }
  }
  return false;
}

/**
 * Returns true if any of the section's paths matches any read/edit file path
 * across sessions. Substring match after `~`-normalization.
 */
export function sectionHasPathUsage(
  section: ClaudeMdSection,
  observedPaths: Set<string>,
  home: string = process.env.HOME ?? "",
): boolean {
  if (section.paths.length === 0) return false;
  const normalizedObserved = new Set([...observedPaths].map((p) => normalizePath(p, home)));
  for (const sectionPath of section.paths) {
    const sectionNorm = normalizePath(sectionPath, home);
    for (const obs of normalizedObserved) {
      if (obs === sectionNorm) return true;
      if (obs.includes(sectionNorm) || sectionNorm.includes(obs)) return true;
    }
  }
  return false;
}

/**
 * Lightweight check: does any of the project's documentation (CLAUDE.md +
 * memory files) mention the given file path? Used by
 * detectClaudeMdUndocumentedRepeat to distinguish "doc missing" from
 * "doc exists but isn't followed".
 */
export function pathIsDocumented(
  filePath: string,
  projectPath: string,
  memoryDir: string | null,
): boolean {
  const candidates: string[] = [];
  const claudeMd = join(projectPath, "CLAUDE.md");
  if (existsSync(claudeMd)) candidates.push(claudeMd);
  if (memoryDir && existsSync(memoryDir)) {
    const memoryIndex = join(memoryDir, "MEMORY.md");
    if (existsSync(memoryIndex)) candidates.push(memoryIndex);
  }
  if (candidates.length === 0) return false;

  const home = process.env.HOME ?? "";
  const normalizedTarget = normalizePath(filePath, home);
  const basename = filePath.split("/").pop() ?? filePath;

  for (const path of candidates) {
    let content: string;
    try {
      content = readFileSync(path, "utf-8");
    } catch {
      continue;
    }
    if (content.includes(normalizedTarget)) return true;
    if (content.includes(filePath)) return true;
    if (basename.length > 4 && content.includes(basename)) return true;
  }
  return false;
}
