import { resolve } from "path";
import {
  SCHEMA_VERSION,
  type SessionExtract,
  type BashCommand,
  type UserMessage,
  type TurnTokens,
  type JSONLRecord,
  type ToolUseBlock,
  type ToolResultBlock,
} from "./types";

const FILE_PATH_TOOLS = new Set(["Read", "Edit", "Write", "Glob"]);
const EDIT_TOOLS = new Set(["Edit", "Write"]);
const MAX_USER_MSG_LENGTH = 500;

export function parseSessionJSONL(content: string, sessionId: string): SessionExtract {
  const fileReadCounts: Record<string, number> = {};
  const bashCommands: BashCommand[] = [];
  const toolSequence: string[] = [];
  const userMessages: UserMessage[] = [];
  const fileEditSet = new Set<string>();
  const turnTokens: TurnTokens[] = [];
  const outOfProjectPaths: string[] = [];

  // Bash calls pending error resolution
  const pendingBash = new Map<string, { turn: number; cmd: string }>();

  let projectPath = "";
  let turnNumber = 0;

  const lines = content.split("\n");

  for (const line of lines) {
    if (!line.trim()) continue;

    let record: JSONLRecord;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // skip malformed lines
    }

    if (!record.type || !record.message) continue;

    // Extract project path from first record with cwd
    if (!projectPath && record.cwd) {
      projectPath = record.cwd;
    }

    if (record.type === "assistant") {
      turnNumber++;
      const msgContent = record.message.content;
      if (!Array.isArray(msgContent)) continue;

      // Track tokens
      const usage = record.message.usage;
      if (usage) {
        turnTokens.push({
          turn: turnNumber,
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: usage.output_tokens ?? 0,
        });
      }

      for (const block of msgContent) {
        if (typeof block === "string") continue;
        if (block.type !== "tool_use") continue;

        const toolBlock = block as ToolUseBlock;
        const { id, name, input } = toolBlock;

        // Track tool sequence
        toolSequence.push(name);

        // Track file reads
        if (name === "Read" && input.file_path) {
          const filePath = String(input.file_path);
          fileReadCounts[filePath] = (fileReadCounts[filePath] || 0) + 1;
        }

        // Track file edits
        if (EDIT_TOOLS.has(name) && input.file_path) {
          fileEditSet.add(String(input.file_path));
        }

        // Track bash commands (error resolved later)
        if (name === "Bash" && input.command) {
          pendingBash.set(id, { turn: turnNumber, cmd: String(input.command) });
        }

        // Track out-of-project paths
        if (FILE_PATH_TOOLS.has(name) && input.file_path && projectPath) {
          const filePath = String(input.file_path);
          const resolved = filePath.startsWith("/") ? filePath : resolve(projectPath, filePath);
          if (!resolved.startsWith(projectPath)) {
            outOfProjectPaths.push(resolved);
          }
        }
      }
    }

    if (record.type === "user") {
      const msgContent = record.message.content;

      // Handle plain text user messages
      if (typeof msgContent === "string" && msgContent.length > 0 && msgContent.length <= MAX_USER_MSG_LENGTH) {
        userMessages.push({ turn: turnNumber, text: msgContent.slice(0, MAX_USER_MSG_LENGTH) });
      }

      // Handle tool results — resolve pending tool_use errors
      if (Array.isArray(msgContent)) {
        for (const block of msgContent) {
          if (typeof block === "string") continue;
          if (block.type !== "tool_result") continue;

          const resultBlock = block as ToolResultBlock;
          const pending = pendingBash.get(resultBlock.tool_use_id);
          if (pending) {
            bashCommands.push({
              turn: pending.turn,
              cmd: pending.cmd,
              is_error: resultBlock.is_error === true,
              tool_use_id: resultBlock.tool_use_id,
            });
            pendingBash.delete(resultBlock.tool_use_id);
          }
        }
      }
    }
  }

  // Resolve any remaining pending bash commands as non-errors
  for (const [id, pending] of pendingBash) {
    bashCommands.push({
      turn: pending.turn,
      cmd: pending.cmd,
      is_error: false,
      tool_use_id: id,
    });
  }

  return {
    schema_version: SCHEMA_VERSION,
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    project_path: projectPath,
    extracts: {
      file_read_counts: fileReadCounts,
      bash_commands: bashCommands,
      tool_sequence: toolSequence,
      user_messages: userMessages,
      file_edit_set: [...fileEditSet],
      turn_tokens: turnTokens,
      out_of_project_paths: [...new Set(outOfProjectPaths)],
    },
  };
}

export function mergeExtracts(parent: SessionExtract, child: SessionExtract): SessionExtract {
  const merged = structuredClone(parent);

  for (const [path, count] of Object.entries(child.extracts.file_read_counts)) {
    merged.extracts.file_read_counts[path] = (merged.extracts.file_read_counts[path] || 0) + count;
  }

  merged.extracts.bash_commands.push(...child.extracts.bash_commands);
  merged.extracts.tool_sequence.push(...child.extracts.tool_sequence);
  merged.extracts.user_messages.push(...child.extracts.user_messages);
  merged.extracts.turn_tokens.push(...child.extracts.turn_tokens);

  const editSet = new Set([...merged.extracts.file_edit_set, ...child.extracts.file_edit_set]);
  merged.extracts.file_edit_set = [...editSet];

  const oopSet = new Set([...merged.extracts.out_of_project_paths, ...child.extracts.out_of_project_paths]);
  merged.extracts.out_of_project_paths = [...oopSet];

  return merged;
}
