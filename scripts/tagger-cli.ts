import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { parseSessionJSONL, mergeExtracts } from "./tagger";

const STATE_DIR = join(process.env.HOME ?? "~", ".claude", "context-gaps");
const MAX_SUBAGENTS = 3;

function main() {
  const input = readFileSync("/dev/stdin", "utf-8");

  let payload: { transcript_path?: string; session_id?: string };
  try {
    payload = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const transcriptPath = payload.transcript_path;
  const sessionId = payload.session_id;

  if (!transcriptPath || !sessionId) {
    process.exit(0);
  }

  if (transcriptPath.includes("/.cursor/")) {
    process.exit(0);
  }

  try {
    const stat = statSync(transcriptPath);
    if (stat.size < 1024) {
      process.exit(0);
    }
  } catch {
    process.exit(0);
  }

  const content = readFileSync(transcriptPath, "utf-8");
  let extract = parseSessionJSONL(content, sessionId);

  const sessionDir = join(dirname(transcriptPath), sessionId);
  const subagentDir = join(sessionDir, "subagents");

  if (existsSync(subagentDir)) {
    try {
      const files = readdirSync(subagentDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => {
          const fullPath = join(subagentDir, f);
          return { path: fullPath, size: statSync(fullPath).size };
        })
        .sort((a, b) => b.size - a.size)
        .slice(0, MAX_SUBAGENTS);

      for (const file of files) {
        try {
          const subContent = readFileSync(file.path, "utf-8");
          const subExtract = parseSessionJSONL(subContent, sessionId);
          extract = mergeExtracts(extract, subExtract);
        } catch {
          // skip unreadable subagent files
        }
      }
    } catch {
      // skip if subagent dir is unreadable
    }
  }

  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }

  const outPath = join(STATE_DIR, `pending-${sessionId}.jsonl`);
  writeFileSync(outPath, JSON.stringify(extract) + "\n");
}

main();
