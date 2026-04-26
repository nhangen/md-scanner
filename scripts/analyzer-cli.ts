import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import {
  loadIndex,
  saveIndex,
  loadNewPendingFiles,
  isObserverSession,
  buildProjectAggregates,
  resolveReportDir,
  writeReport,
  computeTrend,
  detectRepeatedFileReads,
  detectCommandErrors,
  detectFilePairCoOccurrence,
  detectCrossProjectPaths,
  detectUserMessageFrequency,
  detectSkillCandidates,
  detectContextBloat,
  detectAllowlistGaps,
} from "./analyzer";
import { loadExistingAllowlist } from "./allowlist";
import type { DetectorFinding, ProjectAggregate } from "./types";

const STATE_DIR = join(process.env.HOME ?? "~", ".claude", "context-gaps");
const INDEX_PATH = join(STATE_DIR, "analyzer-index.json");
const LOG_PATH = join(STATE_DIR, "analyzer.log");

function log(message: string): void {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // silent
  }
}

function parseMode(): "hook" | "cron" {
  for (const arg of process.argv.slice(2)) {
    if (arg === "--mode=cron") return "cron";
  }
  return "hook";
}

function buildTimestampMap(aggregates: Map<string, ProjectAggregate>): Map<string, string> {
  const m = new Map<string, string>();
  for (const agg of aggregates.values()) {
    for (let i = 0; i < agg.session_ids.length; i++) {
      m.set(agg.session_ids[i], agg.timestamps[i]);
    }
  }
  return m;
}

function applyTrendToFindings(
  findings: DetectorFinding[],
  tsMap: Map<string, string>,
): DetectorFinding[] {
  return findings.map((f) => ({
    ...f,
    trend: computeTrend(f.session_ids, tsMap),
  }));
}

function fetchContextBloatData(): Array<{ sessionId: string; cwd: string; bloatRatio: number }> {
  try {
    const bunPath = (() => {
      const home = process.env.HOME ?? "~";
      const candidate = join(home, ".bun", "bin", "bun");
      if (existsSync(candidate)) return candidate;
      const which = spawnSync("which", ["bun"], { encoding: "utf8", timeout: 2000 });
      if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
      return "bun";
    })();

    const tokenScopePath = (() => {
      const home = process.env.HOME ?? "~";
      const pluginBase = join(home, ".claude", "plugins", "cache", "nhangen-tools", "md-scanner");
      try {
        const { readdirSync } = require("fs");
        const versions = readdirSync(pluginBase).filter((e: string) => /^\d+\.\d+\.\d+$/.test(e)).sort();
        if (versions.length > 0) {
          return join(pluginBase, versions[versions.length - 1], "scripts", "token-scope.ts");
        }
      } catch {}
      return join(pluginBase, "..", "..", "..", "..", "..", "ML-AI", "claude", "md-scanner", "scripts", "token-scope.ts");
    })();

    const result = spawnSync(bunPath, [tokenScopePath, "--context", "--json"], {
      encoding: "utf8",
      timeout: 10_000,
    });

    if (result.status !== 0 || !result.stdout) return [];

    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((entry: any) => entry.sessionId && entry.cwd && typeof entry.bloatRatio === "number")
      .map((entry: any) => ({
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        bloatRatio: entry.bloatRatio,
      }));
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }

  const mode = parseMode();
  log(`start mode=${mode}`);

  const index = loadIndex(INDEX_PATH);

  const shouldForceAll =
    mode === "cron" &&
    (!index.last_run || Date.now() - new Date(index.last_run).getTime() > 24 * 60 * 60 * 1000);

  const { extracts: newExtracts, updatedIndex: scanIndex } = loadNewPendingFiles(STATE_DIR, index, false);

  if (newExtracts.length === 0 && !shouldForceAll) {
    scanIndex.last_run = new Date().toISOString();
    saveIndex(INDEX_PATH, scanIndex);
    log(`exit early: no new files since last run`);
    return;
  }

  const { extracts, updatedIndex } = loadNewPendingFiles(STATE_DIR, index, true);
  log(`loaded ${extracts.length} pending files (forceAll=true, triggered by ${newExtracts.length} new files)`);

  const filtered = extracts.filter((e) => !isObserverSession(e));
  log(`after observer filter: ${filtered.length} sessions`);

  if (filtered.length < 2) {
    updatedIndex.last_run = new Date().toISOString();
    saveIndex(INDEX_PATH, updatedIndex);
    log(`exit early: fewer than 2 sessions after filtering`);
    return;
  }

  const aggregates = buildProjectAggregates(filtered);
  log(`built aggregates for ${aggregates.size} projects`);

  const tsMap = buildTimestampMap(aggregates);

  const reportDir = resolveReportDir();
  log(`report dir: ${reportDir}`);

  let bloatData: Array<{ sessionId: string; cwd: string; bloatRatio: number }> = [];
  if (mode === "cron") {
    bloatData = fetchContextBloatData();
    log(`fetched ${bloatData.length} context bloat entries`);
  }

  let reportsWritten = 0;
  let totalFindings = 0;
  const pendingFileCount = Object.keys(updatedIndex.processed_files).length;

  for (const [canonical, agg] of aggregates) {
    if (agg.session_count < 2) continue;

    const existingAllowlist = loadExistingAllowlist(canonical);

    const rawFindings: DetectorFinding[] = [
      ...detectRepeatedFileReads(agg),
      ...detectCommandErrors(agg),
      ...detectAllowlistGaps(agg, existingAllowlist),
      ...detectFilePairCoOccurrence(agg),
      ...detectCrossProjectPaths(agg),
      ...detectUserMessageFrequency(agg),
      ...detectSkillCandidates(agg),
      ...detectContextBloat(canonical, bloatData),
    ];

    const findings = applyTrendToFindings(rawFindings, tsMap);

    writeReport(canonical, agg, findings, reportDir, pendingFileCount);
    reportsWritten++;
    totalFindings += findings.length;
    log(`wrote report for ${canonical}: ${findings.length} findings`);
  }

  updatedIndex.last_run = new Date().toISOString();
  saveIndex(INDEX_PATH, updatedIndex);

  log(`done: ${reportsWritten} reports, ${totalFindings} total findings, mode=${mode}`);
}

main().catch((err) => {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] FATAL ${String(err)}\n`);
  } catch {
    // silent
  }
});
