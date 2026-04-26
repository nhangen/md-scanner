// Schema version for all persisted records — bump when format changes
export const SCHEMA_VERSION = 1;

// --- JSONL record types (what Claude Code writes) ---

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
}

export type AssistantContentBlock = ToolUseBlock | ThinkingBlock | TextBlock;
export type UserContentBlock = ToolResultBlock | string;

export interface JSONLRecord {
  type: "assistant" | "user" | "progress" | "queue-operation" | "last-prompt";
  message?: {
    content: AssistantContentBlock[] | UserContentBlock[] | string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  sessionId?: string;
  cwd?: string;
}

// --- Tagger output (what we write to pending files) ---

export interface BashCommand {
  turn: number;
  cmd: string;
  is_error: boolean;
  tool_use_id: string;
}

export interface UserMessage {
  turn: number;
  text: string;
}

export interface TurnTokens {
  turn: number;
  input_tokens: number;
  output_tokens: number;
}

export interface SessionExtract {
  schema_version: number;
  session_id: string;
  timestamp: string;
  project_path: string;
  extracts: {
    file_read_counts: Record<string, number>;
    bash_commands: BashCommand[];
    tool_sequence: string[];
    user_messages: UserMessage[];
    file_edit_set: string[];
    turn_tokens: TurnTokens[];
    out_of_project_paths: string[];
  };
}

// --- Resolved records (applied/dismissed/deferred) ---

export interface Fingerprint {
  pattern_type: string;
  target_file: string;
  primary_key: string;
}

export interface ResolvedRecord {
  schema_version: number;
  timestamp: string;
  session_ids: string[];
  fingerprint: Fingerprint;
  recommendation_text: string;
  evidence_summary: string;
  action: "applied" | "dismissed" | "deferred";
}

// --- Analyzer types ---

export interface ProjectAggregate {
  project_path: string;
  canonical_path: string;
  session_count: number;
  session_ids: string[];
  timestamps: string[];
  file_read_sessions: Record<string, string[]>;
  bash_error_sessions: Record<string, string[]>;
  bash_command_pair_sessions: Record<string, string[]>;
  edit_sets: Array<{ session_id: string; files: string[] }>;
  out_of_project_sessions: Record<string, string[]>;
  user_message_corpus: Array<{ session_id: string; text: string }>;
  high_cost_sessions: Array<{
    session_id: string;
    total_input: number;
    total_output: number;
    tool_sequence: string[];
  }>;
}

export interface AnalyzerIndex {
  schema_version: number;
  last_run: string;
  processed_files: Record<string, { mtime: number; size: number }>;
}

export type TrendDirection = "up" | "down" | "steady";
export type RecommendedSurface =
  | "project-claude-md"
  | "global-claude-md"
  | "rules"
  | "memory"
  | "skill-candidate"
  | "settings-allowlist";

export interface DetectorFinding {
  pattern_type: string;
  evidence: string;
  session_ids: string[];
  session_count: number;
  trend: TrendDirection;
  estimated_tokens: number;
  recommended_surface: RecommendedSurface;
  fingerprint: Fingerprint;
}

export const ANALYZER_SCHEMA_VERSION = 1;
