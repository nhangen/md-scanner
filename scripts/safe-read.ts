// safe-read — single-source helper for external-state file reads.
//
// The detectors operate against external state (project CLAUDE.md, ~/.cursor/rules/,
// ~/.claude/rules/, ~/.claude/projects/<id>/memory/, project .claude/settings*.json).
// Each call site needs to distinguish three failure modes:
//
//   missing     — file legitimately absent; degraded output is correct (e.g., no
//                 CLAUDE.md = no doc-quality findings)
//   unreadable  — file exists but read failed (perms, EISDIR, EIO); degraded
//                 output is silent data loss
//   parse-error — JSON.parse / structural parse failed; treat like unreadable
//
// Without this helper, callers wrap readFileSync in `try/catch {}` that swallows
// all three indistinguishably. The result is a degraded analyzer pass that the
// user can't tell from a clean one.
//
// safeReadFile() returns a discriminated union and increments a run-level
// degradation counter. The CLI flushes the counter to stderr at end-of-run so
// users see "analyzer ran with N degraded reads" instead of silent partial output.

import { existsSync, readFileSync } from "fs";

export type SafeReadResult =
  | { ok: true; content: string }
  | { ok: false; reason: "missing" | "unreadable"; path: string; error?: string };

let degradedReadCount = 0;
const degradedSamples: Array<{ path: string; reason: string; error?: string }> = [];
const SAMPLE_LIMIT = 10;

export function safeReadFile(path: string): SafeReadResult {
  if (!existsSync(path)) {
    return { ok: false, reason: "missing", path };
  }
  try {
    const content = readFileSync(path, "utf-8");
    return { ok: true, content };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    degradedReadCount++;
    if (degradedSamples.length < SAMPLE_LIMIT) {
      degradedSamples.push({ path, reason: "unreadable", error: msg });
    }
    return { ok: false, reason: "unreadable", path, error: msg };
  }
}

export function safeParseJson<T = unknown>(content: string, sourcePath: string): { ok: true; value: T } | { ok: false; reason: "parse-error"; error: string } {
  try {
    return { ok: true, value: JSON.parse(content) as T };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    degradedReadCount++;
    if (degradedSamples.length < SAMPLE_LIMIT) {
      degradedSamples.push({ path: sourcePath, reason: "parse-error", error: msg });
    }
    return { ok: false, reason: "parse-error", error: msg };
  }
}

/**
 * Returns the count of degraded reads since the last reset, plus up to N
 * sampled paths/reasons. Caller (analyzer-cli) flushes at end-of-run.
 */
export function getDegradedReadStats(): { count: number; samples: Array<{ path: string; reason: string; error?: string }> } {
  return { count: degradedReadCount, samples: [...degradedSamples] };
}

export function resetDegradedReadStats(): void {
  degradedReadCount = 0;
  degradedSamples.length = 0;
}
