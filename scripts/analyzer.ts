import { spawnSync } from "child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  statSync,
  mkdirSync,
} from "fs";
import { join, basename, dirname } from "path";
import {
  ANALYZER_SCHEMA_VERSION,
  type SessionExtract,
  type UserMessage,
  type AnalyzerIndex,
  type ProjectAggregate,
  type DetectorFinding,
  type TrendDirection,
  type RecommendedSurface,
} from "./types";
import {
  commandToAllowlistKey,
  formatAllowPattern,
  isAutoAllowed,
  isArbitraryCode,
  isWriteShaped,
} from "./allowlist";
import {
  parseClaudeMdSections,
  sectionHasCommandUsage,
  sectionHasPathUsage,
  pathIsDocumented,
} from "./claudemd";

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

const OBSERVER_PATH_MARKERS = ["observer-sessions", ".claude-mem"];
const OBSERVER_TOOLS = new Set(["ToolSearch", "TaskCreate", "TaskUpdate", "Skill"]);

export function isObserverSession(extract: SessionExtract): boolean {
  if (OBSERVER_PATH_MARKERS.some((m) => extract.project_path.includes(m))) return true;
  return extract.extracts.tool_sequence.some((t) => OBSERVER_TOOLS.has(t));
}

const NOISE_WORDS = new Set(["yes", "no", "sure", "go", "ok", "1", "2", "3"]);

export function cleanUserMessages(messages: UserMessage[]): UserMessage[] {
  return messages.filter((m) => {
    const t = m.text;
    if (t.startsWith("Stop hook feedback:")) return false;
    if (t.includes("<local-command-caveat>")) return false;
    if (t.includes("<command-name>")) return false;
    if (t.includes("<local-command-stdout>")) return false;
    if (NOISE_WORDS.has(t.trim().toLowerCase())) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Path utilities
// ---------------------------------------------------------------------------

const canonCache = new Map<string, string>();

export function canonicalizePath(projectPath: string): string {
  const cached = canonCache.get(projectPath);
  if (cached !== undefined) return cached;

  try {
    const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: projectPath,
      timeout: 500,
    });
    if (result.status === 0 && result.stdout) {
      const resolved = result.stdout.toString().trim();
      canonCache.set(projectPath, resolved);
      return resolved;
    }
  } catch {
    // fall through
  }
  canonCache.set(projectPath, projectPath);
  return projectPath;
}

export function fnv1aHash4(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  return hex.slice(-4);
}

/**
 * Convert a canonical path to the directory id Claude Code uses under
 * `~/.claude/projects/<id>/`. The convention is leading `-` followed by the
 * absolute path with `/` and ` ` (space) replaced with `-`.
 *
 * Example: `/Users/foo/Local Sites/bar/baz` →
 *   `-Users-foo-Local-Sites-bar-baz`.
 *
 * Distinct from `projectSlug()`, which uses `basename + hash` for md-scanner's
 * own report file naming.
 */
export function claudeProjectDirId(canonicalPath: string): string {
  return canonicalPath.replace(/[/ ]/g, "-");
}

export function projectSlug(canonicalPath: string): string {
  const base = basename(canonicalPath)
    .replace(/[^a-z0-9]/gi, "-")
    .toLowerCase();
  return `${base}-${fnv1aHash4(canonicalPath)}`;
}

export function rleCompress(sequence: string[]): string {
  if (sequence.length === 0) return "";
  const parts: string[] = [];
  let current = sequence[0];
  let count = 1;
  for (let i = 1; i < sequence.length; i++) {
    if (sequence[i] === current) {
      count++;
    } else {
      parts.push(count > 1 ? `${current}*${count}` : current);
      current = sequence[i];
      count = 1;
    }
  }
  parts.push(count > 1 ? `${current}*${count}` : current);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Index management
// ---------------------------------------------------------------------------

export function loadIndex(indexPath: string): AnalyzerIndex {
  try {
    const raw = readFileSync(indexPath, "utf-8");
    return JSON.parse(raw) as AnalyzerIndex;
  } catch {
    return {
      schema_version: ANALYZER_SCHEMA_VERSION,
      last_run: "",
      processed_files: {},
    };
  }
}

export function saveIndex(indexPath: string, index: AnalyzerIndex): void {
  const tmp = indexPath + `.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(index, null, 2));
  renameSync(tmp, indexPath);
}

// ---------------------------------------------------------------------------
// Pending file loading
// ---------------------------------------------------------------------------

export function loadNewPendingFiles(
  stateDir: string,
  index: AnalyzerIndex,
  forceAll: boolean,
): { extracts: SessionExtract[]; updatedIndex: AnalyzerIndex } {
  const extracts: SessionExtract[] = [];
  const updatedIndex: AnalyzerIndex = {
    ...index,
    processed_files: { ...index.processed_files },
  };

  let files: string[];
  try {
    files = readdirSync(stateDir).filter((f) => f.startsWith("pending-") && f.endsWith(".jsonl"));
  } catch {
    return { extracts, updatedIndex };
  }

  for (const file of files) {
    const fullPath = join(stateDir, file);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    const mtime = Math.floor(stat.mtimeMs);
    const size = stat.size;
    const prev = index.processed_files[file];
    if (!forceAll && prev && prev.mtime === mtime && prev.size === size) {
      continue;
    }

    try {
      const raw = readFileSync(fullPath, "utf-8");
      const firstLine = raw.split("\n")[0];
      if (firstLine.trim()) {
        const extract = JSON.parse(firstLine) as SessionExtract;
        extracts.push(extract);
      }
    } catch {
      continue;
    }

    updatedIndex.processed_files[file] = { mtime, size };
  }

  return { extracts, updatedIndex };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export function buildProjectAggregates(
  extracts: SessionExtract[],
): Map<string, ProjectAggregate> {
  const map = new Map<string, ProjectAggregate>();

  for (const ext of extracts) {
    const canonical = canonicalizePath(ext.project_path);
    let agg = map.get(canonical);
    if (!agg) {
      agg = {
        project_path: ext.project_path,
        canonical_path: canonical,
        session_count: 0,
        session_ids: [],
        timestamps: [],
        file_read_sessions: {},
        bash_error_sessions: {},
        bash_command_pair_sessions: {},
        edit_sets: [],
        out_of_project_sessions: {},
        user_message_corpus: [],
        high_cost_sessions: [],
      };
      map.set(canonical, agg);
    }

    agg.session_count++;
    agg.session_ids.push(ext.session_id);
    agg.timestamps.push(ext.timestamp);

    for (const [filePath, _count] of Object.entries(ext.extracts.file_read_counts)) {
      if (!agg.file_read_sessions[filePath]) agg.file_read_sessions[filePath] = [];
      if (!agg.file_read_sessions[filePath].includes(ext.session_id)) {
        agg.file_read_sessions[filePath].push(ext.session_id);
      }
    }

    for (const cmd of ext.extracts.bash_commands) {
      if (cmd.is_error) {
        const firstWord = cmd.cmd.trim().split(/\s+/)[0];
        if (!agg.bash_error_sessions[firstWord]) agg.bash_error_sessions[firstWord] = [];
        if (!agg.bash_error_sessions[firstWord].includes(ext.session_id)) {
          agg.bash_error_sessions[firstWord].push(ext.session_id);
        }
      }

      const pairKey = commandToAllowlistKey(cmd.cmd);
      if (pairKey) {
        if (!agg.bash_command_pair_sessions[pairKey]) agg.bash_command_pair_sessions[pairKey] = [];
        if (!agg.bash_command_pair_sessions[pairKey].includes(ext.session_id)) {
          agg.bash_command_pair_sessions[pairKey].push(ext.session_id);
        }
      }
    }

    if (ext.extracts.file_edit_set.length > 0) {
      agg.edit_sets.push({ session_id: ext.session_id, files: ext.extracts.file_edit_set });
    }

    for (const oopPath of ext.extracts.out_of_project_paths) {
      if (!agg.out_of_project_sessions[oopPath]) agg.out_of_project_sessions[oopPath] = [];
      if (!agg.out_of_project_sessions[oopPath].includes(ext.session_id)) {
        agg.out_of_project_sessions[oopPath].push(ext.session_id);
      }
    }

    const cleaned = cleanUserMessages(ext.extracts.user_messages);
    for (const msg of cleaned) {
      agg.user_message_corpus.push({ session_id: ext.session_id, text: msg.text });
    }

    let totalInput = 0;
    let totalOutput = 0;
    for (const tt of ext.extracts.turn_tokens) {
      totalInput += tt.input_tokens;
      totalOutput += tt.output_tokens;
    }
    agg.high_cost_sessions.push({
      session_id: ext.session_id,
      total_input: totalInput,
      total_output: totalOutput,
      tool_sequence: ext.extracts.tool_sequence,
    });
  }

  return map;
}

// ---------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------

export function computeTrend(
  sessionIds: string[],
  allTimestamps: Map<string, string>,
): TrendDirection {
  if (sessionIds.length < 3) return "steady";

  const allTimes = [...allTimestamps.values()].sort();
  if (allTimes.length < 3) return "steady";

  const earliest = new Date(allTimes[0]).getTime();
  const latest = new Date(allTimes[allTimes.length - 1]).getTime();
  const range = latest - earliest;
  if (range === 0) return "steady";

  const oldBoundary = earliest + range / 3;
  const recentBoundary = earliest + (2 * range) / 3;

  let oldCount = 0;
  let recentCount = 0;
  for (const id of sessionIds) {
    const ts = allTimestamps.get(id);
    if (!ts) continue;
    const t = new Date(ts).getTime();
    if (t <= oldBoundary) oldCount++;
    if (t >= recentBoundary) recentCount++;
  }

  if (recentCount > sessionIds.length * 0.5) return "up";
  if (oldCount > sessionIds.length * 0.5) return "down";
  return "steady";
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

function buildTimestampMap(agg: ProjectAggregate): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < agg.session_ids.length; i++) {
    m.set(agg.session_ids[i], agg.timestamps[i]);
  }
  return m;
}

export function detectRepeatedFileReads(agg: ProjectAggregate): DetectorFinding[] {
  const threshold = agg.session_count < 10 ? 3 : 5;
  const tsMap = buildTimestampMap(agg);
  const findings: DetectorFinding[] = [];

  for (const [filePath, sessions] of Object.entries(agg.file_read_sessions)) {
    if (sessions.length < threshold) continue;
    if (filePath.includes(".claude-mem") || filePath.includes(".claude/plugins")) continue;

    findings.push({
      pattern_type: "repeated-file-read",
      evidence: `File read in ${sessions.length} sessions: ${filePath}`,
      session_ids: sessions,
      session_count: sessions.length,
      trend: computeTrend(sessions, tsMap),
      estimated_tokens: sessions.length * 200,
      recommended_surface: "memory",
      fingerprint: {
        pattern_type: "repeated-file-read",
        target_file: filePath,
        primary_key: filePath,
      },
    });
  }

  return findings.sort((a, b) => b.session_count - a.session_count);
}

export function detectCommandErrors(agg: ProjectAggregate): DetectorFinding[] {
  const tsMap = buildTimestampMap(agg);
  const findings: DetectorFinding[] = [];

  for (const [cmd, sessions] of Object.entries(agg.bash_error_sessions)) {
    if (sessions.length < 2) continue;

    findings.push({
      pattern_type: "command-error",
      evidence: `Command "${cmd}" errored in ${sessions.length} sessions`,
      session_ids: sessions,
      session_count: sessions.length,
      trend: computeTrend(sessions, tsMap),
      estimated_tokens: 0,
      recommended_surface: "project-claude-md",
      fingerprint: {
        pattern_type: "command-error",
        target_file: "",
        primary_key: cmd,
      },
    });
  }

  return findings.sort((a, b) => b.session_count - a.session_count);
}

export function detectAllowlistGaps(
  agg: ProjectAggregate,
  existingAllowlist: Set<string>,
): DetectorFinding[] {
  const tsMap = buildTimestampMap(agg);
  const findings: DetectorFinding[] = [];

  for (const [key, sessions] of Object.entries(agg.bash_command_pair_sessions)) {
    if (sessions.length < 3) continue;
    if (isAutoAllowed(key)) continue;
    if (isArbitraryCode(key)) continue;
    if (isWriteShaped(key)) continue;

    const pattern = formatAllowPattern(key);
    if (existingAllowlist.has(pattern)) continue;

    const exact = `Bash(${key})`;
    if (existingAllowlist.has(exact)) continue;

    findings.push({
      pattern_type: "allowlist-gap",
      evidence: `Command "${key}" ran in ${sessions.length} sessions; not auto-allowed and not in project allowlist. Suggested entry: ${pattern}`,
      session_ids: sessions,
      session_count: sessions.length,
      trend: computeTrend(sessions, tsMap),
      estimated_tokens: 0,
      recommended_surface: "settings-allowlist",
      fingerprint: {
        pattern_type: "allowlist-gap",
        target_file: ".claude/settings.local.json",
        primary_key: pattern,
      },
    });
  }

  return findings.sort((a, b) => b.session_count - a.session_count);
}

export function detectClaudeMdUnusedSections(
  agg: ProjectAggregate,
  claudeMdPath: string,
): DetectorFinding[] {
  const findings: DetectorFinding[] = [];
  const sections = parseClaudeMdSections(claudeMdPath);
  if (sections.length === 0) return findings;

  const minSessions = 10;
  if (agg.session_count < minSessions) return findings;

  const bashCommandKeys = new Set(Object.keys(agg.bash_command_pair_sessions));
  const observedPaths = new Set<string>([
    ...Object.keys(agg.file_read_sessions),
    ...agg.edit_sets.flatMap((e) => e.files),
  ]);

  const tsMap = buildTimestampMap(agg);

  for (const section of sections) {
    if (section.commands.length === 0 && section.paths.length === 0) continue;

    const cmdUsed = sectionHasCommandUsage(section, bashCommandKeys);
    const pathUsed = sectionHasPathUsage(section, observedPaths);
    if (cmdUsed || pathUsed) continue;

    findings.push({
      pattern_type: "claudemd-unused-section",
      evidence: `CLAUDE.md section "${section.title}" references commands/paths never observed across ${agg.session_count} sessions in this project. Candidate for archival.`,
      session_ids: agg.session_ids,
      session_count: agg.session_count,
      trend: computeTrend(agg.session_ids, tsMap),
      estimated_tokens: 0,
      recommended_surface: "project-claude-md",
      fingerprint: {
        pattern_type: "claudemd-unused-section",
        target_file: claudeMdPath,
        primary_key: section.title,
      },
    });
  }

  return findings;
}

export function detectClaudeMdUndocumentedRepeat(
  agg: ProjectAggregate,
  projectPath: string,
  memoryDir: string | null,
): DetectorFinding[] {
  const findings: DetectorFinding[] = [];
  const threshold = agg.session_count < 10 ? 3 : 5;
  const tsMap = buildTimestampMap(agg);

  for (const [filePath, sessions] of Object.entries(agg.file_read_sessions)) {
    if (sessions.length < threshold) continue;
    if (filePath.includes(".claude-mem") || filePath.includes(".claude/plugins")) continue;
    if (!pathIsDocumented(filePath, projectPath, memoryDir)) continue;

    findings.push({
      pattern_type: "claudemd-undocumented-repeat",
      evidence: `File ${filePath} read in ${sessions.length} sessions despite being mentioned in CLAUDE.md or memory. Doc exists but isn't being followed — either the reference doesn't surface in-context, or the cached value is stale.`,
      session_ids: sessions,
      session_count: sessions.length,
      trend: computeTrend(sessions, tsMap),
      estimated_tokens: sessions.length * 200,
      recommended_surface: "memory",
      fingerprint: {
        pattern_type: "claudemd-undocumented-repeat",
        target_file: filePath,
        primary_key: filePath,
      },
    });
  }

  return findings.sort((a, b) => b.session_count - a.session_count);
}

export function detectFilePairCoOccurrence(agg: ProjectAggregate): DetectorFinding[] {
  const tsMap = buildTimestampMap(agg);
  const pairSessions = new Map<string, string[]>();

  for (const editSet of agg.edit_sets) {
    const filtered = editSet.files.filter((f) => !f.includes("Documents/Obsidian"));
    const sorted = [...filtered].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}|${sorted[j]}`;
        if (!pairSessions.has(key)) pairSessions.set(key, []);
        const sessions = pairSessions.get(key)!;
        if (!sessions.includes(editSet.session_id)) {
          sessions.push(editSet.session_id);
        }
      }
    }
  }

  const findings: DetectorFinding[] = [];
  for (const [pair, sessions] of pairSessions) {
    if (sessions.length < 3) continue;

    findings.push({
      pattern_type: "file-pair-co-occurrence",
      evidence: `Files edited together in ${sessions.length} sessions: ${pair.replaceAll("|", " + ")}`,
      session_ids: sessions,
      session_count: sessions.length,
      trend: computeTrend(sessions, tsMap),
      estimated_tokens: 0,
      recommended_surface: "skill-candidate",
      fingerprint: {
        pattern_type: "file-pair-co-occurrence",
        target_file: pair.split("|")[0],
        primary_key: pair,
      },
    });
  }

  return findings.sort((a, b) => b.session_count - a.session_count);
}

export function detectCrossProjectPaths(agg: ProjectAggregate): DetectorFinding[] {
  const tsMap = buildTimestampMap(agg);
  const findings: DetectorFinding[] = [];

  for (const [path, sessions] of Object.entries(agg.out_of_project_sessions)) {
    if (sessions.length < 2) continue;

    findings.push({
      pattern_type: "cross-project-path",
      evidence: `Out-of-project path accessed in ${sessions.length} sessions: ${path}`,
      session_ids: sessions,
      session_count: sessions.length,
      trend: computeTrend(sessions, tsMap),
      estimated_tokens: 0,
      recommended_surface: "memory",
      fingerprint: {
        pattern_type: "cross-project-path",
        target_file: path,
        primary_key: path,
      },
    });
  }

  return findings.sort((a, b) => b.session_count - a.session_count);
}

export function detectUserMessageFrequency(agg: ProjectAggregate): DetectorFinding[] {
  const tsMap = buildTimestampMap(agg);
  const textSessions = new Map<string, string[]>();

  for (const msg of agg.user_message_corpus) {
    if (!textSessions.has(msg.text)) textSessions.set(msg.text, []);
    const sessions = textSessions.get(msg.text)!;
    if (!sessions.includes(msg.session_id)) {
      sessions.push(msg.session_id);
    }
  }

  const findings: DetectorFinding[] = [];
  for (const [text, sessions] of textSessions) {
    if (sessions.length < 2) continue;

    findings.push({
      pattern_type: "user-message-frequency",
      evidence: `Message repeated in ${sessions.length} sessions: "${text.slice(0, 80)}"`,
      session_ids: sessions,
      session_count: sessions.length,
      trend: computeTrend(sessions, tsMap),
      estimated_tokens: 0,
      recommended_surface: "rules",
      fingerprint: {
        pattern_type: "user-message-frequency",
        target_file: "",
        primary_key: text,
      },
    });
  }

  return findings.sort((a, b) => b.session_count - a.session_count);
}

export function detectSkillCandidates(agg: ProjectAggregate): DetectorFinding[] {
  const tsMap = buildTimestampMap(agg);
  const sorted = [...agg.high_cost_sessions].sort(
    (a, b) => b.total_input + b.total_output - (a.total_input + a.total_output),
  );

  const topCount = Math.max(1, Math.ceil(sorted.length * 0.25));
  const top = sorted.slice(0, topCount);

  const findings: DetectorFinding[] = [];
  for (const session of top) {
    if (session.tool_sequence.length < 5) continue;
    const compressed = rleCompress(session.tool_sequence);

    findings.push({
      pattern_type: "skill-candidate",
      evidence: `High-cost session (${session.total_input + session.total_output} tokens): ${compressed.slice(0, 120)}`,
      session_ids: [session.session_id],
      session_count: 1,
      trend: computeTrend([session.session_id], tsMap),
      estimated_tokens: session.total_input + session.total_output,
      recommended_surface: "skill-candidate",
      fingerprint: {
        pattern_type: "skill-candidate",
        target_file: "",
        primary_key: session.session_id,
      },
    });
  }

  return findings.sort((a, b) => b.session_count - a.session_count);
}

export function detectContextBloat(
  canonicalPath: string,
  bloatData: Array<{ sessionId: string; cwd: string; bloatRatio: number }>,
): DetectorFinding[] {
  const matching = bloatData.filter((d) => {
    try {
      return canonicalizePath(d.cwd) === canonicalPath;
    } catch {
      return d.cwd === canonicalPath;
    }
  });

  const bloated = matching.filter((d) => d.bloatRatio > 2.0);
  if (bloated.length < 3) return [];

  const claudeMdPath = join(canonicalPath, "CLAUDE.md");
  let claudeMdLines = 0;
  if (existsSync(claudeMdPath)) {
    try {
      claudeMdLines = readFileSync(claudeMdPath, "utf-8").split("\n").length;
    } catch {}
  }

  if (claudeMdLines >= 50) return [];

  const avgRatio = bloated.reduce((sum, d) => sum + d.bloatRatio, 0) / bloated.length;
  const sessionIds = bloated.map((d) => d.sessionId);

  return [{
    pattern_type: "context-bloat",
    evidence: `${bloated.length} sessions with bloatRatio > 2.0 (avg ${avgRatio.toFixed(1)}), CLAUDE.md ${claudeMdLines === 0 ? "missing" : `${claudeMdLines} lines`}`,
    session_ids: sessionIds,
    session_count: bloated.length,
    trend: "steady" as TrendDirection,
    estimated_tokens: 0,
    recommended_surface: "project-claude-md" as RecommendedSurface,
    fingerprint: {
      pattern_type: "context-bloat",
      target_file: claudeMdPath,
      primary_key: canonicalPath,
    },
  }];
}

// ---------------------------------------------------------------------------
// Vault detection
// ---------------------------------------------------------------------------

export function resolveVaultPath(): string | null {
  try {
    const pluginDir = join(
      process.env.HOME ?? "~",
      ".claude",
      "plugins",
      "cache",
      "nhangen",
      "obsidian",
    );
    const entries = readdirSync(pluginDir);
    const versionDirs = entries.filter((e) => /^\d+\.\d+\.\d+$/.test(e));

    if (versionDirs.length === 0) return null;

    versionDirs.sort((a, b) => {
      const ap = a.split(".").map(Number);
      const bp = b.split(".").map(Number);
      for (let i = 0; i < 3; i++) {
        if (ap[i] !== bp[i]) return ap[i] - bp[i];
      }
      return 0;
    });

    const latest = versionDirs[versionDirs.length - 1];
    const localMd = readFileSync(join(pluginDir, latest, "obsidian.local.md"), "utf-8");
    const match = localMd.match(/^vault_path:\s*(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Report output
// ---------------------------------------------------------------------------

export function resolveReportDir(): string {
  const vault = resolveVaultPath();
  let dir: string;
  if (vault) {
    dir = join(vault, "Projects", "Development", "md-scanner");
  } else {
    dir = join(process.env.HOME ?? "~", ".claude", "context-gaps", "reports");
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

function tildefy(p: string): string {
  const home = process.env.HOME ?? "";
  if (home && p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

function findingsOfType(findings: DetectorFinding[], type: string): DetectorFinding[] {
  return findings.filter((f) => f.pattern_type === type);
}

function trendArrow(trend: TrendDirection): string {
  if (trend === "up") return "^";
  if (trend === "down") return "v";
  return "->";
}

function formatRepeatedFileReads(items: DetectorFinding[]): string {
  const title = "Repeated File Reads";
  if (items.length === 0) return `## ${title}\n\n(none)\n`;
  const header = "| File | Sessions | Est. Tokens | Trend |\n|------|----------|-------------|-------|";
  const rows = items.map(
    (f) => `| ${tildefy(f.fingerprint.primary_key)} | ${f.session_count} | ~${f.estimated_tokens.toLocaleString()} | ${trendArrow(f.trend)} |`,
  );
  return `## ${title}\n\n${header}\n${rows.join("\n")}\n`;
}

function formatCommandErrors(items: DetectorFinding[]): string {
  const title = "Command Errors";
  if (items.length === 0) return `## ${title}\n\n(none)\n`;
  const header = "| Command | Sessions | Trend |\n|---------|----------|-------|";
  const rows = items.map(
    (f) => `| ${f.fingerprint.primary_key} | ${f.session_count} | ${trendArrow(f.trend)} |`,
  );
  return `## ${title}\n\n${header}\n${rows.join("\n")}\n`;
}

function formatFilePairCoOccurrence(items: DetectorFinding[]): string {
  const title = "File Pair Co-occurrence";
  if (items.length === 0) return `## ${title}\n\n(none)\n`;
  const header = "| Files | Sessions | Trend |\n|-------|----------|-------|";
  const rows = items.map(
    (f) => `| ${tildefy(f.fingerprint.primary_key.replaceAll("|", " + "))} | ${f.session_count} | ${trendArrow(f.trend)} |`,
  );
  return `## ${title}\n\n${header}\n${rows.join("\n")}\n`;
}

function formatCrossProjectPaths(items: DetectorFinding[]): string {
  const title = "Cross-Project Paths";
  if (items.length === 0) return `## ${title}\n\n(none)\n`;
  const header = "| Path | Sessions | From Project |\n|------|----------|--------------| ";
  const rows = items.map(
    (f) => `| ${tildefy(f.fingerprint.primary_key)} | ${f.session_count} | ${tildefy(f.fingerprint.target_file)} |`,
  );
  return `## ${title}\n\n${header}\n${rows.join("\n")}\n`;
}

function formatUserMessageFrequency(items: DetectorFinding[]): string {
  const title = "User Message Frequency";
  if (items.length === 0) return `## ${title}\n\n(none)\n`;
  const header = "| Message | Sessions |\n|---------|----------|";
  const rows = items.map(
    (f) => `| "${f.fingerprint.primary_key.slice(0, 80)}" | ${f.session_count} |`,
  );
  return `## ${title}\n\n${header}\n${rows.join("\n")}\n`;
}

function formatSkillCandidates(items: DetectorFinding[]): string {
  const title = "Skill Candidates";
  if (items.length === 0) return `## ${title}\n\n(none)\n`;
  const header = "| Tool Sequence (RLE) | Sessions | Est. Cost |\n|---------------------|----------|-----------|";
  const rows = items.map(
    (f) => `| ${f.evidence.replace(/^High-cost session \(\d+ tokens\): /, "").slice(0, 120)} | ${f.session_count} | ~${f.estimated_tokens.toLocaleString()} |`,
  );
  return `## ${title}\n\n${header}\n${rows.join("\n")}\n`;
}

function formatAllowlistGaps(items: DetectorFinding[]): string {
  const title = "Allowlist Gaps";
  if (items.length === 0) return `## ${title}\n\n(none)\n`;
  const header = "| Suggested Pattern | Sessions | Trend |\n|-------------------|----------|-------|";
  const rows = items.map(
    (f) => `| \`${f.fingerprint.primary_key}\` | ${f.session_count} | ${trendArrow(f.trend)} |`,
  );
  return `## ${title}\n\n${header}\n${rows.join("\n")}\n`;
}

function formatClaudeMdUnusedSections(items: DetectorFinding[]): string {
  const title = "CLAUDE.md Unused Sections";
  if (items.length === 0) return `## ${title}\n\n(none)\n`;
  const header = "| Section | Sessions Analyzed |\n|---------|-------------------|";
  const rows = items.map(
    (f) => `| "${f.fingerprint.primary_key}" | ${f.session_count} |`,
  );
  return `## ${title}\n\n${header}\n${rows.join("\n")}\n`;
}

function formatClaudeMdUndocumentedRepeat(items: DetectorFinding[]): string {
  const title = "CLAUDE.md: Doc Exists But Isn't Followed";
  if (items.length === 0) return `## ${title}\n\n(none)\n`;
  const header = "| File | Re-read Sessions | Est. Tokens | Trend |\n|------|------------------|-------------|-------|";
  const rows = items.map(
    (f) => `| ${tildefy(f.fingerprint.primary_key)} | ${f.session_count} | ~${f.estimated_tokens.toLocaleString()} | ${trendArrow(f.trend)} |`,
  );
  return `## ${title}\n\n${header}\n${rows.join("\n")}\n`;
}

function formatRuleDrift(items: DetectorFinding[]): string {
  const title = "Rule Drift (cron only)";
  if (items.length === 0) return `## ${title}\n\n(none)\n`;
  const header = "| Rule | Status |\n|------|--------|";
  const rows = items.map(
    (f) => `| ${f.fingerprint.primary_key} | ${f.evidence.split(".")[0]} |`,
  );
  return `## ${title}\n\n${header}\n${rows.join("\n")}\n`;
}

function formatContextBloat(items: DetectorFinding[]): string {
  const title = "Context Bloat (cron only)";
  if (items.length === 0) return `## ${title}\n\n(none)\n`;
  const header = "| Sessions >2.0 bloat | Avg Ratio | CLAUDE.md Lines |\n|---------------------|-----------|-----------------|";
  const rows = items.map((f) => {
    const match = f.evidence.match(/^(\d+) sessions.*avg ([\d.]+)\).*?(\d+ lines|missing)$/);
    const count = match ? match[1] : String(f.session_count);
    const avg = match ? match[2] : "?";
    const lines = match ? match[3] : "?";
    return `| ${count} | ${avg} | ${lines} |`;
  });
  return `## ${title}\n\n${header}\n${rows.join("\n")}\n`;
}

export function writeReport(
  canonical: string,
  agg: ProjectAggregate,
  findings: DetectorFinding[],
  outputDir: string,
  pendingFileCount?: number,
): string {
  const slug = projectSlug(canonical);
  const filePath = join(outputDir, `${slug}.md`);

  const sections = [
    formatRepeatedFileReads(findingsOfType(findings, "repeated-file-read")),
    formatCommandErrors(findingsOfType(findings, "command-error")),
    formatAllowlistGaps(findingsOfType(findings, "allowlist-gap")),
    formatClaudeMdUnusedSections(findingsOfType(findings, "claudemd-unused-section")),
    formatClaudeMdUndocumentedRepeat(findingsOfType(findings, "claudemd-undocumented-repeat")),
    formatFilePairCoOccurrence(findingsOfType(findings, "file-pair-co-occurrence")),
    formatCrossProjectPaths(findingsOfType(findings, "cross-project-path")),
    formatUserMessageFrequency(findingsOfType(findings, "user-message-frequency")),
    formatSkillCandidates(findingsOfType(findings, "skill-candidate")),
    formatContextBloat(findingsOfType(findings, "context-bloat")),
    formatRuleDrift(findingsOfType(findings, "rule-drift")),
  ];

  const pendingLine = pendingFileCount !== undefined ? `\npending_files: ${pendingFileCount}` : "";

  const content = `---
generated: ${new Date().toISOString()}
project: ${tildefy(canonical)}
sessions_analyzed: ${agg.session_count}${pendingLine}
---

# Context Gaps -- ${basename(canonical)}

${sections.join("\n")}`;

  writeFileSync(filePath, content);
  return filePath;
}
