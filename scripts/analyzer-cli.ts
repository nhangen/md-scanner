import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
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
} from "./analyzer";
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

  const { extracts, updatedIndex } = loadNewPendingFiles(STATE_DIR, index, true);
  log(`loaded ${extracts.length} pending files (forceAll=true)`);

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

  let reportsWritten = 0;
  let totalFindings = 0;

  for (const [canonical, agg] of aggregates) {
    if (agg.session_count < 2) continue;

    const rawFindings: DetectorFinding[] = [
      ...detectRepeatedFileReads(agg),
      ...detectCommandErrors(agg),
      ...detectFilePairCoOccurrence(agg),
      ...detectCrossProjectPaths(agg),
      ...detectUserMessageFrequency(agg),
      ...detectSkillCandidates(agg),
    ];

    const findings = applyTrendToFindings(rawFindings, tsMap);

    if (findings.length === 0) continue;

    writeReport(canonical, agg, findings, reportDir);
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
