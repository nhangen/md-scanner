import { describe, test, expect } from "bun:test";
import { parseSessionJSONL, mergeExtracts } from "./tagger";

const makeAssistantRecord = (toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>) =>
  JSON.stringify({
    type: "assistant",
    message: {
      content: toolUses.map((t) => ({ type: "tool_use", id: t.id, name: t.name, input: t.input })),
      usage: { input_tokens: 1000, output_tokens: 500 },
    },
    cwd: "/test/project",
  });

const makeUserToolResult = (results: Array<{ tool_use_id: string; is_error?: boolean }>) =>
  JSON.stringify({
    type: "user",
    message: {
      content: results.map((r) => ({
        type: "tool_result",
        tool_use_id: r.tool_use_id,
        content: "output",
        is_error: r.is_error ?? false,
      })),
    },
  });

const makeUserMessage = (text: string) =>
  JSON.stringify({
    type: "user",
    message: { content: text },
  });

describe("mergeExtracts", () => {
  const makeExtract = (overrides: Partial<ReturnType<typeof parseSessionJSONL>["extracts"]> = {}) => ({
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
      ...overrides,
    },
  });

  test("merges file read counts by summing", () => {
    const parent = makeExtract({ file_read_counts: { "/a.ts": 2, "/b.ts": 1 } });
    const child = makeExtract({ file_read_counts: { "/a.ts": 3, "/c.ts": 1 } });
    const result = mergeExtracts(parent, child);
    expect(result.extracts.file_read_counts["/a.ts"]).toBe(5);
    expect(result.extracts.file_read_counts["/b.ts"]).toBe(1);
    expect(result.extracts.file_read_counts["/c.ts"]).toBe(1);
  });

  test("concatenates bash commands and tool sequences", () => {
    const parent = makeExtract({
      bash_commands: [{ turn: 1, cmd: "ls", is_error: false, tool_use_id: "tu_1" }],
      tool_sequence: ["Read"],
    });
    const child = makeExtract({
      bash_commands: [{ turn: 1, cmd: "pwd", is_error: false, tool_use_id: "tu_2" }],
      tool_sequence: ["Bash"],
    });
    const result = mergeExtracts(parent, child);
    expect(result.extracts.bash_commands).toHaveLength(2);
    expect(result.extracts.bash_commands[0].cmd).toBe("ls");
    expect(result.extracts.bash_commands[1].cmd).toBe("pwd");
    expect(result.extracts.tool_sequence).toEqual(["Read", "Bash"]);
  });

  test("deduplicates file edit set", () => {
    const parent = makeExtract({ file_edit_set: ["/a.ts", "/b.ts"] });
    const child = makeExtract({ file_edit_set: ["/b.ts", "/c.ts"] });
    const result = mergeExtracts(parent, child);
    expect(result.extracts.file_edit_set.sort()).toEqual(["/a.ts", "/b.ts", "/c.ts"]);
  });
});

describe("parseSessionJSONL", () => {
  test("counts file reads", () => {
    const lines = [
      makeAssistantRecord([{ id: "tu_1", name: "Read", input: { file_path: "/test/project/foo.ts" } }]),
      makeUserToolResult([{ tool_use_id: "tu_1" }]),
      makeAssistantRecord([{ id: "tu_2", name: "Read", input: { file_path: "/test/project/foo.ts" } }]),
      makeUserToolResult([{ tool_use_id: "tu_2" }]),
      makeAssistantRecord([{ id: "tu_3", name: "Read", input: { file_path: "/test/project/bar.ts" } }]),
      makeUserToolResult([{ tool_use_id: "tu_3" }]),
    ].join("\n");

    const result = parseSessionJSONL(lines, "test-session");
    expect(result.extracts.file_read_counts["/test/project/foo.ts"]).toBe(2);
    expect(result.extracts.file_read_counts["/test/project/bar.ts"]).toBe(1);
  });

  test("tracks bash command errors via tool_use_id correlation", () => {
    const lines = [
      makeAssistantRecord([{ id: "tu_1", name: "Bash", input: { command: "npm run build" } }]),
      makeUserToolResult([{ tool_use_id: "tu_1", is_error: true }]),
      makeAssistantRecord([{ id: "tu_2", name: "Bash", input: { command: "npm run build:dev" } }]),
      makeUserToolResult([{ tool_use_id: "tu_2", is_error: false }]),
    ].join("\n");

    const result = parseSessionJSONL(lines, "test-session");
    expect(result.extracts.bash_commands).toHaveLength(2);
    expect(result.extracts.bash_commands[0].is_error).toBe(true);
    expect(result.extracts.bash_commands[1].is_error).toBe(false);
  });

  test("builds tool sequence", () => {
    const lines = [
      makeAssistantRecord([{ id: "tu_1", name: "Read", input: { file_path: "/test/project/a.ts" } }]),
      makeUserToolResult([{ tool_use_id: "tu_1" }]),
      makeAssistantRecord([{ id: "tu_2", name: "Grep", input: { pattern: "foo" } }]),
      makeUserToolResult([{ tool_use_id: "tu_2" }]),
      makeAssistantRecord([{ id: "tu_3", name: "Edit", input: { file_path: "/test/project/a.ts" } }]),
      makeUserToolResult([{ tool_use_id: "tu_3" }]),
    ].join("\n");

    const result = parseSessionJSONL(lines, "test-session");
    expect(result.extracts.tool_sequence).toEqual(["Read", "Grep", "Edit"]);
  });

  test("captures user text messages under 500 chars", () => {
    const lines = [
      makeUserMessage("Remember to use worktrees for branch work"),
      makeAssistantRecord([{ id: "tu_1", name: "Read", input: { file_path: "/test/project/a.ts" } }]),
      makeUserToolResult([{ tool_use_id: "tu_1" }]),
    ].join("\n");

    const result = parseSessionJSONL(lines, "test-session");
    expect(result.extracts.user_messages).toHaveLength(1);
    expect(result.extracts.user_messages[0].text).toBe("Remember to use worktrees for branch work");
  });

  test("skips user messages over 500 chars", () => {
    const longMessage = "x".repeat(501);
    const lines = [makeUserMessage(longMessage)].join("\n");

    const result = parseSessionJSONL(lines, "test-session");
    expect(result.extracts.user_messages).toHaveLength(0);
  });

  test("tracks file edits in edit set", () => {
    const lines = [
      makeAssistantRecord([{ id: "tu_1", name: "Edit", input: { file_path: "/test/project/a.ts" } }]),
      makeUserToolResult([{ tool_use_id: "tu_1" }]),
      makeAssistantRecord([{ id: "tu_2", name: "Write", input: { file_path: "/test/project/b.ts" } }]),
      makeUserToolResult([{ tool_use_id: "tu_2" }]),
      makeAssistantRecord([{ id: "tu_3", name: "Edit", input: { file_path: "/test/project/a.ts" } }]),
      makeUserToolResult([{ tool_use_id: "tu_3" }]),
    ].join("\n");

    const result = parseSessionJSONL(lines, "test-session");
    expect(result.extracts.file_edit_set).toEqual(["/test/project/a.ts", "/test/project/b.ts"]);
  });

  test("detects out-of-project paths", () => {
    const lines = [
      makeAssistantRecord([{ id: "tu_1", name: "Read", input: { file_path: "/other/project/file.ts" } }]),
      makeUserToolResult([{ tool_use_id: "tu_1" }]),
    ].join("\n");

    const result = parseSessionJSONL(lines, "test-session");
    expect(result.extracts.out_of_project_paths).toContain("/other/project/file.ts");
  });

  test("detects relative out-of-project paths", () => {
    const lines = [
      makeAssistantRecord([{ id: "tu_1", name: "Read", input: { file_path: "../../outside/file.ts" } }]),
      makeUserToolResult([{ tool_use_id: "tu_1" }]),
    ].join("\n");

    const result = parseSessionJSONL(lines, "test-session");
    expect(result.extracts.out_of_project_paths.length).toBeGreaterThan(0);
    expect(result.extracts.out_of_project_paths[0]).not.toStartWith("/test/project");
  });

  test("tracks token usage per turn", () => {
    const lines = [
      makeAssistantRecord([{ id: "tu_1", name: "Read", input: { file_path: "/test/project/a.ts" } }]),
      makeUserToolResult([{ tool_use_id: "tu_1" }]),
    ].join("\n");

    const result = parseSessionJSONL(lines, "test-session");
    expect(result.extracts.turn_tokens).toHaveLength(1);
    expect(result.extracts.turn_tokens[0].input_tokens).toBe(1000);
    expect(result.extracts.turn_tokens[0].output_tokens).toBe(500);
  });

  test("skips malformed JSONL lines without crashing", () => {
    const lines = [
      "not valid json",
      makeAssistantRecord([{ id: "tu_1", name: "Read", input: { file_path: "/test/project/a.ts" } }]),
      "{incomplete",
      makeUserToolResult([{ tool_use_id: "tu_1" }]),
    ].join("\n");

    const result = parseSessionJSONL(lines, "test-session");
    expect(result.extracts.file_read_counts["/test/project/a.ts"]).toBe(1);
  });

  test("ignores non-assistant/user record types", () => {
    const lines = [
      JSON.stringify({ type: "progress", data: { type: "hook_progress" } }),
      JSON.stringify({ type: "queue-operation" }),
      makeAssistantRecord([{ id: "tu_1", name: "Read", input: { file_path: "/test/project/a.ts" } }]),
      makeUserToolResult([{ tool_use_id: "tu_1" }]),
    ].join("\n");

    const result = parseSessionJSONL(lines, "test-session");
    expect(result.extracts.file_read_counts["/test/project/a.ts"]).toBe(1);
    expect(result.extracts.tool_sequence).toEqual(["Read"]);
  });
});
