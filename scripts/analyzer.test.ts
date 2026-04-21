import { describe, test, expect } from "bun:test";
import {
  isObserverSession,
  cleanUserMessages,
  fnv1aHash4,
  projectSlug,
  rleCompress,
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
