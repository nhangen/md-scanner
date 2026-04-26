import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, chmodSync } from "fs";
import { tmpdir } from "os";
import {
  safeReadFile,
  safeParseJson,
  getDegradedReadStats,
  resetDegradedReadStats,
} from "./safe-read";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = `${tmpdir()}/safe-read-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(tmpRoot, { recursive: true });
  resetDegradedReadStats();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("safeReadFile", () => {
  test("returns ok with content when file exists and is readable", () => {
    const path = `${tmpRoot}/file.txt`;
    writeFileSync(path, "hello world");
    const result = safeReadFile(path);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toBe("hello world");
  });

  test('returns missing when file does not exist (NOT counted as degraded)', () => {
    const result = safeReadFile(`${tmpRoot}/nope.txt`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing");
    expect(getDegradedReadStats().count).toBe(0);
  });

  test("returns unreadable AND counts as degraded when read fails on existing path", () => {
    const dirAsFile = `${tmpRoot}/some-dir`;
    mkdirSync(dirAsFile);
    // readFileSync on a directory throws EISDIR — exercises the unreadable branch
    const result = safeReadFile(dirAsFile);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unreadable");
      expect(result.error).toBeTruthy();
    }
    expect(getDegradedReadStats().count).toBe(1);
  });

  test("samples accumulate up to limit, count keeps incrementing past limit", () => {
    for (let i = 0; i < 15; i++) {
      const dir = `${tmpRoot}/dir${i}`;
      mkdirSync(dir);
      safeReadFile(dir);
    }
    const stats = getDegradedReadStats();
    expect(stats.count).toBe(15);
    expect(stats.samples).toHaveLength(10);
  });
});

describe("safeParseJson", () => {
  test("returns ok with parsed value on valid JSON", () => {
    const result = safeParseJson<{ a: number }>('{"a": 1}', "/test.json");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.a).toBe(1);
  });

  test("returns parse-error AND counts as degraded on malformed JSON", () => {
    const result = safeParseJson('{invalid', "/test.json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("parse-error");
      expect(result.error).toBeTruthy();
    }
    expect(getDegradedReadStats().count).toBe(1);
  });
});

describe("resetDegradedReadStats", () => {
  test("zeros the counter and clears samples", () => {
    const dir = `${tmpRoot}/d`;
    mkdirSync(dir);
    safeReadFile(dir);
    expect(getDegradedReadStats().count).toBe(1);
    resetDegradedReadStats();
    const after = getDegradedReadStats();
    expect(after.count).toBe(0);
    expect(after.samples).toHaveLength(0);
  });
});
