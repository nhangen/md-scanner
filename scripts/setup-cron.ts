import { existsSync, mkdirSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const HOME = process.env.HOME ?? "~";
const STATE_DIR = join(HOME, ".claude", "context-gaps");
const WRAPPER_PATH = join(STATE_DIR, "run-analyzer.sh");
const CRON_MARKER = "md-scanner-analyzer";
const CRON_ENTRY = `0 6 * * * ${WRAPPER_PATH} # ${CRON_MARKER}`;

const PLUGIN_CACHE_DIR = join(
  HOME,
  ".claude",
  "plugins",
  "cache",
  "nhangen-tools",
  "md-scanner",
);

function isDryRun(): boolean {
  return process.argv.includes("--dry-run");
}

function isRemove(): boolean {
  return process.argv.includes("--remove");
}

function detectPlatform(): "macos" | "linux" | "wsl" | "windows" | "unknown" {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") {
    try {
      const result = spawnSync("cat", ["/proc/version"], { encoding: "utf8" });
      if (result.stdout && result.stdout.toLowerCase().includes("microsoft")) {
        return "wsl";
      }
    } catch {
      // not wsl
    }
    return "linux";
  }
  return "unknown";
}

function buildPathPrefix(platform: "macos" | "linux" | "wsl"): string {
  const parts: string[] = [];

  if (platform === "macos") {
    parts.push("/opt/homebrew/bin", "/usr/local/bin");
  }

  const bunBin = join(HOME, ".bun", "bin");
  if (existsSync(bunBin)) {
    parts.push(bunBin);
  }

  return parts.join(":");
}

function buildWrapperScript(pathPrefix: string): string {
  const lines: string[] = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    `export PATH="${pathPrefix}:$PATH"`,
    "",
    `PLUGIN_BASE="${PLUGIN_CACHE_DIR}"`,
    "",
    "PLUGIN_DIR=$(ls -1d \"$PLUGIN_BASE\"/*/  2>/dev/null | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)",
    "",
    'if [ -z "$PLUGIN_DIR" ]; then',
    '  echo "[md-scanner] error: no plugin version found in $PLUGIN_BASE" >&2',
    "  exit 1",
    "fi",
    "",
    'if [ -n "${BUN_PATH:-}" ] && [ -x "$BUN_PATH" ]; then',
    '  BUN="$BUN_PATH"',
    "elif command -v bun >/dev/null 2>&1; then",
    '  BUN="$(command -v bun)"',
    `elif [ -x "${join(HOME, ".bun", "bin", "bun")}" ]; then`,
    `  BUN="${join(HOME, ".bun", "bin", "bun")}"`,
    "else",
    '  echo "[md-scanner] error: bun not found" >&2',
    "  exit 1",
    "fi",
    "",
    `LOG_PATH="${join(STATE_DIR, "analyzer.log")}"`,
    "",
    '"$BUN" "${PLUGIN_DIR}scripts/analyzer-cli.ts" --mode=cron >> "$LOG_PATH" 2>&1',
  ];

  return lines.join("\n") + "\n";
}

function readCurrentCrontab(): string[] {
  const result = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  if (result.status !== 0) {
    return [];
  }
  return result.stdout.split("\n");
}

function writeCrontab(lines: string[]): boolean {
  const content = lines.join("\n");
  const result = spawnSync("crontab", ["-"], {
    input: content,
    encoding: "utf8",
  });
  return result.status === 0;
}

function installCron(dry: boolean): void {
  const platform = detectPlatform();

  if (platform === "windows") {
    console.log(
      "[md-scanner] Windows detected — cron not available. Rely on Stop hook instead.",
    );
    process.exit(0);
  }

  if (platform === "unknown") {
    console.log("[md-scanner] Unknown platform — skipping cron install.");
    process.exit(0);
  }

  const pathPrefix = buildPathPrefix(platform as "macos" | "linux" | "wsl");
  const wrapperContent = buildWrapperScript(pathPrefix);

  if (dry) {
    console.log(`[dry-run] Would write wrapper to: ${WRAPPER_PATH}`);
    console.log("");
    console.log("--- wrapper content ---");
    console.log(wrapperContent);
    console.log("--- crontab entry ---");
    console.log(CRON_ENTRY);
    return;
  }

  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }

  writeFileSync(WRAPPER_PATH, wrapperContent, { encoding: "utf8" });
  chmodSync(WRAPPER_PATH, 0o755);
  console.log(`[md-scanner] Wrote wrapper: ${WRAPPER_PATH}`);

  const existing = readCurrentCrontab();
  const filtered = existing.filter((line) => !line.includes(CRON_MARKER));
  filtered.push(CRON_ENTRY);

  const trailingNewline = filtered[filtered.length - 1] === "" ? filtered : [...filtered, ""];

  const ok = writeCrontab(trailingNewline);
  if (ok) {
    console.log(`[md-scanner] Installed crontab entry: ${CRON_ENTRY}`);
  } else {
    console.log("[md-scanner] Failed to write crontab.");
  }
}

function removeCron(): void {
  const existing = readCurrentCrontab();
  const before = existing.length;
  const filtered = existing.filter((line) => !line.includes(CRON_MARKER));

  if (filtered.length === before) {
    console.log("[md-scanner] No cron entry found to remove.");
    return;
  }

  const ok = writeCrontab(filtered);
  if (ok) {
    console.log(`[md-scanner] Removed crontab entry (marker: ${CRON_MARKER}).`);
  } else {
    console.log("[md-scanner] Failed to remove crontab entry.");
  }
}

if (isRemove()) {
  removeCron();
} else {
  installCron(isDryRun());
}
