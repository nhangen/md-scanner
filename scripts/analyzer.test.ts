import { describe, test, expect } from "bun:test";
import {
  isObserverSession,
  cleanUserMessages,
  fnv1aHash4,
  projectSlug,
  rleCompress,
  claudeProjectDirId,
} from "./analyzer";
import type { SessionExtract, UserMessage } from "./types";

function makeExtract(overrides: Partial<SessionExtract> = {}): SessionExtract {
  return {
    schema_version: 1,
    session_id: "test-session",
    timestamp: "2026-01-01T00:00:00.000Z",
    project_path: "/test/project",
    extracts: {
      file_read_counts: {},
      bash_commands: [],
      tool_sequence: [],
      user_messages: [],
      file_edit_set: [],
      turn_tokens: [],
      out_of_project_paths: [],
      ...(overrides.extracts ?? {}),
    },
    ...overrides,
    // re-apply extracts merge since spread above is shallow
  } as SessionExtract;
}

describe("isObserverSession", () => {
  test("filters by observer-sessions in path", () => {
    const ext = makeExtract({ project_path: "/home/user/observer-sessions/abc" });
    expect(isObserverSession(ext)).toBe(true);
  });

  test("filters by .claude-mem in path", () => {
    const ext = makeExtract({ project_path: "/home/user/.claude-mem/data" });
    expect(isObserverSession(ext)).toBe(true);
  });

  test("filters by observer tool names", () => {
    for (const tool of ["ToolSearch", "TaskCreate", "TaskUpdate", "Skill"]) {
      const ext = makeExtract();
      ext.extracts.tool_sequence = ["Read", tool, "Bash"];
      expect(isObserverSession(ext)).toBe(true);
    }
  });

  test("passes normal sessions", () => {
    const ext = makeExtract();
    ext.extracts.tool_sequence = ["Read", "Grep", "Edit", "Bash"];
    expect(isObserverSession(ext)).toBe(false);
  });
});

describe("cleanUserMessages", () => {
  test("strips Stop hook feedback messages", () => {
    const msgs: UserMessage[] = [
      { turn: 1, text: "Stop hook feedback: something" },
      { turn: 2, text: "real message" },
    ];
    const result = cleanUserMessages(msgs);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("real message");
  });

  test("strips local-command-caveat messages", () => {
    const msgs: UserMessage[] = [
      { turn: 1, text: "blah <local-command-caveat> blah" },
    ];
    expect(cleanUserMessages(msgs)).toHaveLength(0);
  });

  test("strips command-name messages", () => {
    const msgs: UserMessage[] = [
      { turn: 1, text: "some <command-name> thing" },
    ];
    expect(cleanUserMessages(msgs)).toHaveLength(0);
  });

  test("strips local-command-stdout messages", () => {
    const msgs: UserMessage[] = [
      { turn: 1, text: "output <local-command-stdout> here" },
    ];
    expect(cleanUserMessages(msgs)).toHaveLength(0);
  });

  test("strips single-word noise", () => {
    const noiseWords = ["yes", "no", "sure", "go", "ok", "1", "2", "3", "Yes", "NO", "OK"];
    const msgs: UserMessage[] = noiseWords.map((w, i) => ({ turn: i, text: w }));
    expect(cleanUserMessages(msgs)).toHaveLength(0);
  });

  test("keeps real messages", () => {
    const msgs: UserMessage[] = [
      { turn: 1, text: "Please fix the bug in auth.ts" },
      { turn: 2, text: "Use worktrees for branch work" },
    ];
    const result = cleanUserMessages(msgs);
    expect(result).toHaveLength(2);
  });
});

describe("fnv1aHash4", () => {
  test("produces 4-char hex", () => {
    const hash = fnv1aHash4("/some/path");
    expect(hash).toHaveLength(4);
    expect(hash).toMatch(/^[0-9a-f]{4}$/);
  });

  test("different paths produce different hashes", () => {
    const h1 = fnv1aHash4("/path/one");
    const h2 = fnv1aHash4("/path/two");
    expect(h1).not.toBe(h2);
  });

  test("same input produces same hash", () => {
    expect(fnv1aHash4("hello")).toBe(fnv1aHash4("hello"));
  });
});

describe("projectSlug", () => {
  test("creates correct slug format", () => {
    const slug = projectSlug("/Users/me/projects/my-app");
    expect(slug).toMatch(/^my-app-[0-9a-f]{4}$/);
  });

  test("replaces special characters with dashes", () => {
    const slug = projectSlug("/Users/me/My App_v2");
    expect(slug).toMatch(/^my-app-v2-[0-9a-f]{4}$/);
  });

  test("lowercases everything", () => {
    const slug = projectSlug("/Users/me/MyProject");
    expect(slug.startsWith("myproject-")).toBe(true);
  });
});

describe("rleCompress", () => {
  test("compresses runs", () => {
    expect(rleCompress(["Read", "Read", "Grep", "Edit"])).toBe("Read*2, Grep, Edit");
  });

  test("handles singles", () => {
    expect(rleCompress(["Read", "Grep", "Edit"])).toBe("Read, Grep, Edit");
  });

  test("handles empty array", () => {
    expect(rleCompress([])).toBe("");
  });

  test("handles single element", () => {
    expect(rleCompress(["Read"])).toBe("Read");
  });

  test("handles all same elements", () => {
    expect(rleCompress(["Bash", "Bash", "Bash"])).toBe("Bash*3");
  });

  test("handles alternating elements", () => {
    expect(rleCompress(["Read", "Edit", "Read", "Edit"])).toBe("Read, Edit, Read, Edit");
  });
});

describe("claudeProjectDirId", () => {
  test("replaces slashes with dashes", () => {
    expect(claudeProjectDirId("/Users/me/repo")).toBe("-Users-me-repo");
  });

  test("replaces spaces with dashes (Local Sites case)", () => {
    expect(claudeProjectDirId("/Users/me/Local Sites/app/public")).toBe(
      "-Users-me-Local-Sites-app-public",
    );
  });

  test("matches the on-disk Claude Code memory dir convention", () => {
    // Real example from ~/.claude/projects/ on this machine
    expect(
      claudeProjectDirId("/Users/nhangen/Local Sites/appoptinmonstertest/app/public"),
    ).toBe("-Users-nhangen-Local-Sites-appoptinmonstertest-app-public");
  });
});

import {
  detectRepeatedFileReads,
  detectCommandErrors,
  detectFilePairCoOccurrence,
  detectCrossProjectPaths,
  detectUserMessageFrequency,
  detectSkillCandidates,
  computeTrend,
} from "./analyzer";
import type { ProjectAggregate } from "./types";

function makeAgg(overrides: Partial<ProjectAggregate>): ProjectAggregate {
  return {
    project_path: "/test",
    canonical_path: "/test",
    session_count: 5,
    session_ids: ["s1", "s2", "s3", "s4", "s5"],
    timestamps: [],
    file_read_sessions: {},
    bash_error_sessions: {},
    bash_command_pair_sessions: {},
    edit_sets: [],
    out_of_project_sessions: {},
    user_message_corpus: [],
    high_cost_sessions: [],
    ...overrides,
  };
}

describe("detectRepeatedFileReads", () => {
  test("flags files read in 3+ sessions (cold, session_count=5)", () => {
    const agg = makeAgg({
      session_count: 5,
      file_read_sessions: {
        "/test/config.ts": ["s1", "s2", "s3"],
        "/test/once.ts": ["s1"],
      },
    });
    const findings = detectRepeatedFileReads(agg);
    expect(findings).toHaveLength(1);
    expect(findings[0].fingerprint.primary_key).toBe("/test/config.ts");
  });

  test("requires 5+ for mature (session_count=15) — 4 sessions should NOT trigger", () => {
    const agg = makeAgg({
      session_count: 15,
      session_ids: ["s1","s2","s3","s4","s5","s6","s7","s8","s9","s10","s11","s12","s13","s14","s15"],
      file_read_sessions: {
        "/test/config.ts": ["s1", "s2", "s3", "s4"],
      },
    });
    const findings = detectRepeatedFileReads(agg);
    expect(findings).toHaveLength(0);
  });

  test("skips .claude-mem paths", () => {
    const agg = makeAgg({
      session_count: 5,
      file_read_sessions: {
        "/home/user/.claude-mem/data/file.md": ["s1", "s2", "s3"],
      },
    });
    expect(detectRepeatedFileReads(agg)).toHaveLength(0);
  });

  test("skips .claude/plugins paths", () => {
    const agg = makeAgg({
      session_count: 5,
      file_read_sessions: {
        "/home/user/.claude/plugins/cache/some-plugin/file.ts": ["s1", "s2", "s3"],
      },
    });
    expect(detectRepeatedFileReads(agg)).toHaveLength(0);
  });
});

describe("detectCommandErrors", () => {
  test("flags binaries with errors in 2+ sessions", () => {
    const agg = makeAgg({
      bash_error_sessions: {
        wp: ["s1", "s2"],
        git: ["s3", "s4", "s5"],
      },
    });
    const findings = detectCommandErrors(agg);
    expect(findings).toHaveLength(2);
    const keys = findings.map((f) => f.fingerprint.primary_key);
    expect(keys).toContain("wp");
    expect(keys).toContain("git");
  });

  test("ignores binaries with errors in only 1 session", () => {
    const agg = makeAgg({
      bash_error_sessions: {
        wp: ["s1"],
      },
    });
    expect(detectCommandErrors(agg)).toHaveLength(0);
  });
});

describe("detectFilePairCoOccurrence", () => {
  test("finds pairs edited together in 3+ sessions", () => {
    const agg = makeAgg({
      session_ids: ["s1", "s2", "s3", "s4", "s5"],
      edit_sets: [
        { session_id: "s1", files: ["/src/a.ts", "/src/b.ts"] },
        { session_id: "s2", files: ["/src/a.ts", "/src/b.ts"] },
        { session_id: "s3", files: ["/src/a.ts", "/src/b.ts"] },
      ],
    });
    const findings = detectFilePairCoOccurrence(agg);
    expect(findings).toHaveLength(1);
    expect(findings[0].pattern_type).toBe("file-pair-co-occurrence");
    expect(findings[0].session_count).toBe(3);
  });

  test("filters out Obsidian paths", () => {
    const agg = makeAgg({
      session_ids: ["s1", "s2", "s3"],
      edit_sets: [
        { session_id: "s1", files: ["/src/a.ts", "/Users/me/Documents/Obsidian/note.md"] },
        { session_id: "s2", files: ["/src/a.ts", "/Users/me/Documents/Obsidian/note.md"] },
        { session_id: "s3", files: ["/src/a.ts", "/Users/me/Documents/Obsidian/note.md"] },
      ],
    });
    expect(detectFilePairCoOccurrence(agg)).toHaveLength(0);
  });
});

describe("detectCrossProjectPaths", () => {
  test("flags paths accessed in 2+ sessions", () => {
    const agg = makeAgg({
      out_of_project_sessions: {
        "/other-repo/config.ts": ["s1", "s2"],
        "/another/file.ts": ["s3"],
      },
    });
    const findings = detectCrossProjectPaths(agg);
    expect(findings).toHaveLength(1);
    expect(findings[0].fingerprint.primary_key).toBe("/other-repo/config.ts");
  });
});

describe("detectUserMessageFrequency", () => {
  test("finds repeated messages across sessions", () => {
    const agg = makeAgg({
      user_message_corpus: [
        { session_id: "s1", text: "use worktrees for branch work" },
        { session_id: "s2", text: "use worktrees for branch work" },
        { session_id: "s3", text: "unique message only once" },
      ],
    });
    const findings = detectUserMessageFrequency(agg);
    expect(findings).toHaveLength(1);
    expect(findings[0].fingerprint.primary_key).toBe("use worktrees for branch work");
  });

  test("ignores unique messages", () => {
    const agg = makeAgg({
      user_message_corpus: [
        { session_id: "s1", text: "message one" },
        { session_id: "s2", text: "message two" },
        { session_id: "s3", text: "message three" },
      ],
    });
    expect(detectUserMessageFrequency(agg)).toHaveLength(0);
  });
});

describe("computeTrend", () => {
  test("returns steady with even distribution (6 sessions spread across months)", () => {
    const sessions = ["s1", "s2", "s3", "s4", "s5", "s6"];
    const tsMap = new Map([
      ["s1", "2026-01-01T00:00:00Z"],
      ["s2", "2026-02-01T00:00:00Z"],
      ["s3", "2026-03-01T00:00:00Z"],
      ["s4", "2026-04-01T00:00:00Z"],
      ["s5", "2026-05-01T00:00:00Z"],
      ["s6", "2026-06-01T00:00:00Z"],
    ]);
    expect(computeTrend(sessions, tsMap)).toBe("steady");
  });

  test("returns steady with <3 sessions", () => {
    const sessions = ["s1", "s2"];
    const tsMap = new Map([
      ["s1", "2026-01-01T00:00:00Z"],
      ["s2", "2026-02-01T00:00:00Z"],
    ]);
    expect(computeTrend(sessions, tsMap)).toBe("steady");
  });

  test("returns up when sessions concentrate in the recent third of the global timeline", () => {
    const tsMap = new Map([
      ["s1", "2026-01-01T00:00:00Z"],
      ["s2", "2026-02-01T00:00:00Z"],
      ["s3", "2026-03-01T00:00:00Z"],
      ["s4", "2026-04-01T00:00:00Z"],
      ["s5", "2026-05-01T00:00:00Z"],
      ["s6", "2026-06-01T00:00:00Z"],
      ["s7", "2026-05-15T00:00:00Z"],
      ["s8", "2026-05-20T00:00:00Z"],
      ["s9", "2026-06-15T00:00:00Z"],
    ]);
    const findingSessions = ["s6", "s7", "s8", "s9"];
    expect(computeTrend(findingSessions, tsMap)).toBe("up");
  });

  test("returns down when sessions concentrate in the oldest third of the global timeline", () => {
    const tsMap = new Map([
      ["s1", "2026-01-01T00:00:00Z"],
      ["s2", "2026-01-15T00:00:00Z"],
      ["s3", "2026-02-01T00:00:00Z"],
      ["s4", "2026-02-15T00:00:00Z"],
      ["s5", "2026-03-01T00:00:00Z"],
      ["s6", "2026-04-01T00:00:00Z"],
      ["s7", "2026-05-01T00:00:00Z"],
      ["s8", "2026-06-01T00:00:00Z"],
    ]);
    const findingSessions = ["s1", "s2", "s3", "s4"];
    expect(computeTrend(findingSessions, tsMap)).toBe("down");
  });
});

describe("detectSkillCandidates", () => {
  test("selects top 25% by cost and RLE-compresses tool sequences", () => {
    const agg = makeAgg({
      session_count: 4,
      session_ids: ["s1", "s2", "s3", "s4"],
      timestamps: ["2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z"],
      high_cost_sessions: [
        { session_id: "s1", total_input: 100000, total_output: 50000, tool_sequence: ["Read", "Read", "Read", "Grep", "Edit", "Bash"] },
        { session_id: "s2", total_input: 5000, total_output: 2000, tool_sequence: ["Read", "Edit"] },
        { session_id: "s3", total_input: 3000, total_output: 1000, tool_sequence: ["Grep"] },
        { session_id: "s4", total_input: 2000, total_output: 500, tool_sequence: ["Bash"] },
      ],
    });
    const findings = detectSkillCandidates(agg);
    expect(findings).toHaveLength(1);
    expect(findings[0].session_ids).toEqual(["s1"]);
    expect(findings[0].evidence).toContain("Read*3");
  });
});

import { detectAllowlistGaps } from "./analyzer";
import {
  commandToAllowlistKey,
  isAutoAllowed,
  isArbitraryCode,
  isWriteShaped,
  formatAllowPattern,
  isReadOnlyMcp,
} from "./allowlist";

describe("commandToAllowlistKey", () => {
  test("extracts head + subcommand for two-token commands", () => {
    expect(commandToAllowlistKey("gh pr view 123")).toBe("gh pr");
    expect(commandToAllowlistKey("git status -s")).toBe("git status");
  });

  test("handles single-token commands", () => {
    expect(commandToAllowlistKey("ls")).toBe("ls");
  });

  test("strips env-var prefixes", () => {
    expect(commandToAllowlistKey('export PATH="/x:$PATH" && gh pr list')).toBe("gh pr");
    expect(commandToAllowlistKey("FOO=bar gh pr list")).toBe("gh pr");
  });

  test("strips sudo/timeout/rtk wrappers", () => {
    expect(commandToAllowlistKey("sudo gh pr view")).toBe("gh pr");
    expect(commandToAllowlistKey("timeout 10 gh pr list")).toBe("gh pr");
    expect(commandToAllowlistKey("rtk gh pr diff")).toBe("gh pr");
  });

  test("rejects arbitrary-code interpreters", () => {
    expect(commandToAllowlistKey("python3 -c 'print(1)'")).toBeNull();
    expect(commandToAllowlistKey("bun run script")).toBeNull();
    expect(commandToAllowlistKey("/bin/bash -c 'rm -rf /'")).toBeNull();
  });

  test("treats absolute-path scripts as their full path", () => {
    expect(commandToAllowlistKey("/Users/nh/foo.sh --flag")).toBe("/Users/nh/foo.sh");
  });

  test("uses head only when second token is a flag/path/quoted arg", () => {
    expect(commandToAllowlistKey("ls -la")).toBe("ls");
    expect(commandToAllowlistKey("cat /etc/hosts")).toBe("cat");
    expect(commandToAllowlistKey("echo 'hello'")).toBe("echo");
  });

  test("takes leading pipeline segment", () => {
    expect(commandToAllowlistKey("gh pr list | jq .")).toBe("gh pr");
    expect(commandToAllowlistKey("git status && git log")).toBe("git status");
  });

  test("returns null on empty input", () => {
    expect(commandToAllowlistKey("")).toBeNull();
    expect(commandToAllowlistKey("   ")).toBeNull();
  });
});

describe("isAutoAllowed", () => {
  test("returns true for any-args head commands", () => {
    expect(isAutoAllowed("ls")).toBe(true);
    expect(isAutoAllowed("ls -la")).toBe(true);
    expect(isAutoAllowed("grep pattern")).toBe(true);
  });

  test("returns true for known git/gh subcommands", () => {
    expect(isAutoAllowed("git status")).toBe(true);
    expect(isAutoAllowed("gh pr")).toBe(true);
    expect(isAutoAllowed("docker ps")).toBe(true);
  });

  test("returns false for non-auto-allowed commands", () => {
    expect(isAutoAllowed("npm install")).toBe(false);
    expect(isAutoAllowed("composer phpcs")).toBe(false);
  });
});

describe("isArbitraryCode", () => {
  test("flags interpreters", () => {
    expect(isArbitraryCode("python3 -c")).toBe(true);
    expect(isArbitraryCode("bun run")).toBe(true);
    expect(isArbitraryCode("bash script")).toBe(true);
  });

  test("does not flag normal commands", () => {
    expect(isArbitraryCode("git status")).toBe(false);
    expect(isArbitraryCode("ls")).toBe(false);
  });
});

describe("isWriteShaped", () => {
  test("rejects single-token write-shaped heads", () => {
    expect(isWriteShaped("rm")).toBe(true);
    expect(isWriteShaped("rm -rf")).toBe(true); // pair with -rf still rejected via head
    expect(isWriteShaped("kill")).toBe(true);
    expect(isWriteShaped("chmod")).toBe(true);
    expect(isWriteShaped("curl")).toBe(true);
    expect(isWriteShaped("docker")).toBe(true);
  });

  test("rejects mutating 2-token git/docker pairs", () => {
    // Note: gh pr/issue/repo/release subcommands aggregate at 2 tokens (`gh pr`)
    // and are blocked at the auto-allow gate, not the write-shape gate. The
    // 3-token entries in WRITE_SHAPED_PAIRS (`gh pr create`, `gh repo delete`)
    // are documentation for a future 3-token aggregation; they don't fire at
    // current aggregation granularity.
    expect(isWriteShaped("git push")).toBe(true);
    expect(isWriteShaped("git commit")).toBe(true);
    expect(isWriteShaped("git rebase")).toBe(true);
    expect(isWriteShaped("git rm")).toBe(true);
    expect(isWriteShaped("docker run")).toBe(true);
    expect(isWriteShaped("docker push")).toBe(true);
  });

  test("rejects package-manager mutations", () => {
    expect(isWriteShaped("npm install")).toBe(true);
    expect(isWriteShaped("yarn add")).toBe(true);
    expect(isWriteShaped("pnpm remove")).toBe(true);
    expect(isWriteShaped("composer install")).toBe(true);
    expect(isWriteShaped("brew install")).toBe(true);
  });

  test("rejects defensively when head is mutating but subcommand is unknown", () => {
    // git is in WRITE_SHAPED_HEADS — anything starting with git that's not
    // explicitly auto-allowed (status/log/diff etc.) gets rejected by the
    // head check
    expect(isWriteShaped("git frobnicate")).toBe(true);
  });

  test("does not reject read-only commands", () => {
    expect(isWriteShaped("composer phpcs")).toBe(false);
    expect(isWriteShaped("ls")).toBe(false);
    expect(isWriteShaped("cat")).toBe(false);
    expect(isWriteShaped("/Users/nh/scan-prs.sh")).toBe(false);
  });
});

describe("formatAllowPattern", () => {
  test("wraps key in Bash() with wildcard suffix", () => {
    expect(formatAllowPattern("gh pr")).toBe("Bash(gh pr *)");
    expect(formatAllowPattern("/Users/nh/foo.sh")).toBe("Bash(/Users/nh/foo.sh *)");
  });
});

describe("isReadOnlyMcp", () => {
  test("returns true for read-shaped MCP tools", () => {
    expect(isReadOnlyMcp("mcp__gitnexus__impact")).toBe(true);
    expect(isReadOnlyMcp("mcp__claude_mem__search")).toBe(true);
    expect(isReadOnlyMcp("mcp__zenhub__getIssuesInPipeline")).toBe(true);
  });

  test("returns false for write-shaped MCP tools", () => {
    expect(isReadOnlyMcp("mcp__zenhub__setIssueEstimate")).toBe(false);
    expect(isReadOnlyMcp("mcp__zenhub__createGitHubIssue")).toBe(false);
    expect(isReadOnlyMcp("mcp__plugin__updateRecord")).toBe(false);
  });

  test("returns false for non-MCP tool names", () => {
    expect(isReadOnlyMcp("Bash")).toBe(false);
    expect(isReadOnlyMcp("Read")).toBe(false);
  });
});

describe("detectAllowlistGaps", () => {
  test("emits a finding for read-only commands ≥3 sessions not in existing allowlist", () => {
    const agg = makeAgg({
      bash_command_pair_sessions: {
        "composer phpcs": ["s1", "s2", "s3"],
        "ls": ["s1", "s2", "s3", "s4"], // auto-allowed, should be filtered
      },
    });
    const findings = detectAllowlistGaps(agg, new Set());
    expect(findings).toHaveLength(1);
    expect(findings[0].pattern_type).toBe("allowlist-gap");
    expect(findings[0].fingerprint.primary_key).toBe("Bash(composer phpcs *)");
    expect(findings[0].recommended_surface).toBe("settings-allowlist");
  });

  test("filters out commands below the 3-session threshold", () => {
    const agg = makeAgg({
      bash_command_pair_sessions: {
        "composer phpcs": ["s1", "s2"],
      },
    });
    expect(detectAllowlistGaps(agg, new Set())).toHaveLength(0);
  });

  test("filters out arbitrary-code interpreters even at high frequency", () => {
    const agg = makeAgg({
      bash_command_pair_sessions: {
        // commandToAllowlistKey would have rejected these at extraction time,
        // but defense-in-depth — the detector also rejects them.
        "python3": ["s1", "s2", "s3", "s4", "s5"],
      },
    });
    expect(detectAllowlistGaps(agg, new Set())).toHaveLength(0);
  });

  test("filters out write-shaped commands even at high frequency", () => {
    const agg = makeAgg({
      bash_command_pair_sessions: {
        "rm -rf": ["s1", "s2", "s3", "s4", "s5"],
        "git push": ["s1", "s2", "s3", "s4", "s5"],
        "npm install": ["s1", "s2", "s3", "s4", "s5"],
        "docker run": ["s1", "s2", "s3", "s4", "s5"],
        "wp eval": ["s1", "s2", "s3", "s4", "s5"],
      },
    });
    expect(detectAllowlistGaps(agg, new Set())).toHaveLength(0);
  });

  test("skips entries already present in the allowlist (wildcard form)", () => {
    const agg = makeAgg({
      bash_command_pair_sessions: {
        "composer phpcs": ["s1", "s2", "s3"],
      },
    });
    const existing = new Set(["Bash(composer phpcs *)"]);
    expect(detectAllowlistGaps(agg, existing)).toHaveLength(0);
  });

  test("skips entries already present in the allowlist (exact form)", () => {
    const agg = makeAgg({
      bash_command_pair_sessions: {
        "composer phpcs": ["s1", "s2", "s3"],
      },
    });
    const existing = new Set(["Bash(composer phpcs)"]);
    expect(detectAllowlistGaps(agg, existing)).toHaveLength(0);
  });

  test("sorts by descending session count", () => {
    const agg = makeAgg({
      bash_command_pair_sessions: {
        "composer phpcs": ["s1", "s2", "s3"],
        "bin/phpunit": ["s1", "s2", "s3", "s4", "s5", "s6"],
      },
    });
    const findings = detectAllowlistGaps(agg, new Set());
    expect(findings).toHaveLength(2);
    expect(findings[0].fingerprint.primary_key).toBe("Bash(bin/phpunit *)");
    expect(findings[1].fingerprint.primary_key).toBe("Bash(composer phpcs *)");
  });
});

import { detectClaudeMdUnusedSections, detectClaudeMdUndocumentedRepeat } from "./analyzer";
import {
  parseClaudeMdSections,
  sectionHasCommandUsage,
  sectionHasPathUsage,
  normalizePath,
  pathIsDocumented,
} from "./claudemd";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";

function makeTempProject(claudeMdContent: string, memoryContent: string | null = null): { projectPath: string; cleanup: () => void } {
  const projectPath = `${tmpdir()}/md-scanner-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(`${projectPath}/CLAUDE.md`, claudeMdContent);
  let memoryDir: string | null = null;
  if (memoryContent !== null) {
    memoryDir = `${projectPath}/.memory`;
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(`${memoryDir}/MEMORY.md`, memoryContent);
  }
  return {
    projectPath,
    cleanup: () => rmSync(projectPath, { recursive: true, force: true }),
  };
}

describe("parseClaudeMdSections", () => {
  test("returns empty array for non-existent file", () => {
    expect(parseClaudeMdSections("/does/not/exist.md")).toEqual([]);
  });

  test("extracts ## sections with title and body", () => {
    const { projectPath, cleanup } = makeTempProject(
      "# Header\n\n## Section A\n\nbody A\n\n## Section B\n\nbody B\n",
    );
    try {
      const sections = parseClaudeMdSections(`${projectPath}/CLAUDE.md`);
      expect(sections).toHaveLength(2);
      expect(sections[0].title).toBe("Section A");
      expect(sections[1].title).toBe("Section B");
    } finally {
      cleanup();
    }
  });

  test("extracts backtick-quoted commands", () => {
    const { projectPath, cleanup } = makeTempProject(
      "## Commands\n\nUse `gh pr view` and `composer phpcs` to check.\n",
    );
    try {
      const sections = parseClaudeMdSections(`${projectPath}/CLAUDE.md`);
      expect(sections[0].commands).toContain("gh pr view");
      expect(sections[0].commands).toContain("composer phpcs");
    } finally {
      cleanup();
    }
  });

  test("extracts paths and rule refs", () => {
    const { projectPath, cleanup } = makeTempProject(
      "## Rules\n\nSee `~/.claude/rules/safety-invariant-scope.md` and `safety-invariant-scope`.\n",
    );
    try {
      const sections = parseClaudeMdSections(`${projectPath}/CLAUDE.md`);
      expect(sections[0].paths.length).toBeGreaterThan(0);
      expect(sections[0].rule_refs).toContain("safety-invariant-scope");
    } finally {
      cleanup();
    }
  });
});

describe("normalizePath", () => {
  test("collapses ~/ prefix", () => {
    expect(normalizePath("~/.claude/rules", "/Users/me")).toBe(".claude/rules");
  });

  test("collapses absolute home prefix", () => {
    expect(normalizePath("/Users/me/.claude/rules", "/Users/me")).toBe(".claude/rules");
  });

  test("leaves non-home paths unchanged", () => {
    expect(normalizePath("/etc/hosts", "/Users/me")).toBe("/etc/hosts");
  });
});

describe("sectionHasCommandUsage", () => {
  test("matches when section command appears in observed keys", () => {
    const section = { title: "X", body: "", commands: ["gh pr view"], paths: [], rule_refs: [] };
    expect(sectionHasCommandUsage(section, new Set(["gh pr"]))).toBe(true);
  });

  test("matches single-token section command against pair head", () => {
    const section = { title: "X", body: "", commands: ["composer"], paths: [], rule_refs: [] };
    expect(sectionHasCommandUsage(section, new Set(["composer phpcs"]))).toBe(true);
  });

  test("returns false when no commands match", () => {
    const section = { title: "X", body: "", commands: ["gh pr view"], paths: [], rule_refs: [] };
    expect(sectionHasCommandUsage(section, new Set(["git status"]))).toBe(false);
  });

  test("returns false when section has no commands (caller falls through to path check)", () => {
    const section = { title: "X", body: "prose only", commands: [], paths: [], rule_refs: [] };
    expect(sectionHasCommandUsage(section, new Set())).toBe(false);
  });
});

describe("pathIsDocumented", () => {
  test("returns true when path appears in CLAUDE.md", () => {
    const { projectPath, cleanup } = makeTempProject(
      "## Files\n\nSee `~/.config/branch-cleanup/repos.md` for paths.\n",
    );
    try {
      expect(pathIsDocumented("/Users/me/.config/branch-cleanup/repos.md", projectPath, null)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("returns true when path appears in MEMORY.md", () => {
    const { projectPath, cleanup } = makeTempProject(
      "## Other\n\nNothing relevant\n",
      "Remember: ~/.config/branch-cleanup/repos.md is the truth.",
    );
    try {
      expect(pathIsDocumented("/Users/me/.config/branch-cleanup/repos.md", projectPath, `${projectPath}/.memory`)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("returns false when path is not mentioned anywhere", () => {
    const { projectPath, cleanup } = makeTempProject("## Other\n\nNothing relevant\n");
    try {
      expect(pathIsDocumented("/Users/me/.config/branch-cleanup/repos.md", projectPath, null)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("returns false when CLAUDE.md does not exist", () => {
    expect(pathIsDocumented("/some/path", "/does/not/exist", null)).toBe(false);
  });
});

describe("detectClaudeMdUnusedSections", () => {
  test("flags sections whose commands never appear in transcripts (>=10 sessions)", () => {
    const { projectPath, cleanup } = makeTempProject(
      "## Stale Workflow\n\nRun `frobnicate widget` to deploy.\n\n## Active Workflow\n\nRun `composer phpcs` for lint.\n",
    );
    try {
      const agg = makeAgg({
        session_count: 12,
        session_ids: Array.from({ length: 12 }, (_, i) => `s${i}`),
        bash_command_pair_sessions: { "composer phpcs": ["s1", "s2", "s3"] },
      });
      const findings = detectClaudeMdUnusedSections(agg, `${projectPath}/CLAUDE.md`);
      expect(findings).toHaveLength(1);
      expect(findings[0].fingerprint.primary_key).toBe("Stale Workflow");
      expect(findings[0].pattern_type).toBe("claudemd-unused-section");
    } finally {
      cleanup();
    }
  });

  test("does not flag when session count is below threshold", () => {
    const { projectPath, cleanup } = makeTempProject(
      "## Stale Workflow\n\nRun `frobnicate widget` to deploy.\n",
    );
    try {
      const agg = makeAgg({
        session_count: 5,
        session_ids: ["s1", "s2", "s3", "s4", "s5"],
        bash_command_pair_sessions: {},
      });
      expect(detectClaudeMdUnusedSections(agg, `${projectPath}/CLAUDE.md`)).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("flags path-only sections whose paths are never observed", () => {
    const { projectPath, cleanup } = makeTempProject(
      "## Stale Paths\n\nReference: `/Users/me/never-touched.txt` and `~/old/data.csv`.\n",
    );
    try {
      const agg = makeAgg({
        session_count: 12,
        session_ids: Array.from({ length: 12 }, (_, i) => `s${i}`),
        bash_command_pair_sessions: {},
        file_read_sessions: {},
      });
      const findings = detectClaudeMdUnusedSections(agg, `${projectPath}/CLAUDE.md`);
      expect(findings).toHaveLength(1);
      expect(findings[0].fingerprint.primary_key).toBe("Stale Paths");
    } finally {
      cleanup();
    }
  });

  test("skips path-only sections when at least one path IS observed", () => {
    const { projectPath, cleanup } = makeTempProject(
      "## Used Paths\n\nReference: `/Users/me/active.txt`.\n",
    );
    try {
      const agg = makeAgg({
        session_count: 12,
        session_ids: Array.from({ length: 12 }, (_, i) => `s${i}`),
        bash_command_pair_sessions: {},
        file_read_sessions: { "/Users/me/active.txt": ["s1"] },
      });
      expect(detectClaudeMdUnusedSections(agg, `${projectPath}/CLAUDE.md`)).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("skips prose-only sections that lack commands and paths", () => {
    const { projectPath, cleanup } = makeTempProject(
      "## Philosophy\n\nWe value simplicity over cleverness.\n",
    );
    try {
      const agg = makeAgg({
        session_count: 20,
        session_ids: Array.from({ length: 20 }, (_, i) => `s${i}`),
      });
      expect(detectClaudeMdUnusedSections(agg, `${projectPath}/CLAUDE.md`)).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("returns empty when CLAUDE.md does not exist", () => {
    const agg = makeAgg({ session_count: 20 });
    expect(detectClaudeMdUnusedSections(agg, "/no/such/file.md")).toEqual([]);
  });
});

describe("detectClaudeMdUndocumentedRepeat", () => {
  test("flags re-read paths that ARE documented", () => {
    const { projectPath, cleanup } = makeTempProject(
      "## Repos\n\nSee `~/.config/branch-cleanup/repos.md` for the canonical list.\n",
    );
    try {
      const agg = makeAgg({
        session_count: 12,
        file_read_sessions: {
          "/Users/me/.config/branch-cleanup/repos.md": ["s1", "s2", "s3", "s4", "s5", "s6"],
        },
      });
      const findings = detectClaudeMdUndocumentedRepeat(agg, projectPath, null);
      expect(findings).toHaveLength(1);
      expect(findings[0].pattern_type).toBe("claudemd-undocumented-repeat");
      expect(findings[0].evidence).toContain("Doc exists but isn't being followed");
    } finally {
      cleanup();
    }
  });

  test("does NOT flag re-read paths that are absent from CLAUDE.md (existing repeated-file-read covers those)", () => {
    const { projectPath, cleanup } = makeTempProject("## Other\n\nUnrelated.\n");
    try {
      const agg = makeAgg({
        session_count: 12,
        file_read_sessions: {
          "/Users/me/.config/branch-cleanup/repos.md": ["s1", "s2", "s3", "s4", "s5", "s6"],
        },
      });
      expect(detectClaudeMdUndocumentedRepeat(agg, projectPath, null)).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("respects the same .claude-mem / plugins exclusions as detectRepeatedFileReads", () => {
    const { projectPath, cleanup } = makeTempProject(
      "## Plugin Configs\n\n`/Users/me/.claude/plugins/cache/foo/config.json` is documented.\n",
    );
    try {
      const agg = makeAgg({
        session_count: 12,
        file_read_sessions: {
          "/Users/me/.claude/plugins/cache/foo/config.json": ["s1", "s2", "s3", "s4", "s5"],
        },
      });
      expect(detectClaudeMdUndocumentedRepeat(agg, projectPath, null)).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

import { detectRuleDriftEntries, stripFrontmatter, normalizeQuotes } from "./rule-drift";

describe("stripFrontmatter", () => {
  test("removes leading --- block", () => {
    const input = "---\ndescription: foo\nglobs:\n---\n\n# Body\n\ntext\n";
    expect(stripFrontmatter(input)).toBe("\n# Body\n\ntext\n");
  });

  test("returns content unchanged when no frontmatter", () => {
    const input = "# Body\n\ntext\n";
    expect(stripFrontmatter(input)).toBe(input);
  });

  test("returns content unchanged when frontmatter is unclosed", () => {
    const input = "---\ndescription: foo\n# Body\n";
    expect(stripFrontmatter(input)).toBe(input);
  });
});

describe("normalizeQuotes", () => {
  test("converts smart quotes to straight quotes", () => {
    expect(normalizeQuotes("don’t")).toBe("don't");
    expect(normalizeQuotes("“hello”")).toBe('"hello"');
  });

  test("converts em-dash to double-dash", () => {
    expect(normalizeQuotes("a — b")).toBe("a -- b");
  });
});

describe("detectRuleDriftEntries", () => {
  test("flags rules in cursor only", () => {
    const dir = `${tmpdir()}/md-scanner-drift-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const cursorDir = `${dir}/cursor`;
    const claudeDir = `${dir}/claude`;
    mkdirSync(cursorDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(`${cursorDir}/orphan.mdc`, "---\nalwaysApply: true\n---\n\n# Orphan\n");
    try {
      const entries = detectRuleDriftEntries(cursorDir, claudeDir);
      expect(entries).toHaveLength(1);
      expect(entries[0].rule_name).toBe("orphan");
      expect(entries[0].status).toBe("cursor-only");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("flags rules in claude only", () => {
    const dir = `${tmpdir()}/md-scanner-drift-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const cursorDir = `${dir}/cursor`;
    const claudeDir = `${dir}/claude`;
    mkdirSync(cursorDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(`${claudeDir}/orphan.md`, "---\nglobs:\n---\n\n# Orphan\n");
    try {
      const entries = detectRuleDriftEntries(cursorDir, claudeDir);
      expect(entries).toHaveLength(1);
      expect(entries[0].status).toBe("claude-only");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("flags rules whose body differs (ignoring frontmatter)", () => {
    const dir = `${tmpdir()}/md-scanner-drift-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const cursorDir = `${dir}/cursor`;
    const claudeDir = `${dir}/claude`;
    mkdirSync(cursorDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(`${cursorDir}/foo.mdc`, "---\nalwaysApply: true\n---\n\n# Foo\n\nVersion 1\n");
    writeFileSync(`${claudeDir}/foo.md`, "---\nglobs:\n---\n\n# Foo\n\nVersion 2\n");
    try {
      const entries = detectRuleDriftEntries(cursorDir, claudeDir);
      expect(entries).toHaveLength(1);
      expect(entries[0].status).toBe("differs");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns empty when bodies match (ignoring different frontmatter)", () => {
    const dir = `${tmpdir()}/md-scanner-drift-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const cursorDir = `${dir}/cursor`;
    const claudeDir = `${dir}/claude`;
    mkdirSync(cursorDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(`${cursorDir}/foo.mdc`, "---\nalwaysApply: true\n---\n\n# Foo\n\nSame body\n");
    writeFileSync(`${claudeDir}/foo.md`, "---\nglobs:\n---\n\n# Foo\n\nSame body\n");
    try {
      expect(detectRuleDriftEntries(cursorDir, claudeDir)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("normalizes smart quotes when comparing", () => {
    const dir = `${tmpdir()}/md-scanner-drift-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const cursorDir = `${dir}/cursor`;
    const claudeDir = `${dir}/claude`;
    mkdirSync(cursorDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(`${cursorDir}/foo.mdc`, "---\n---\n\nNever ask the user’s repo location\n");
    writeFileSync(`${claudeDir}/foo.md`, "---\n---\n\nNever ask the user's repo location\n");
    try {
      expect(detectRuleDriftEntries(cursorDir, claudeDir)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns empty when both directories are missing", () => {
    expect(detectRuleDriftEntries("/no/cursor", "/no/claude")).toEqual([]);
  });
});
