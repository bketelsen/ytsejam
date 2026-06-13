/**
 * On-disk types for ytsejam's session store (pi-agent-core JSONL v3).
 *
 * A session file is one JSON object per line:
 *   line 1   — SessionHeader { type:"session", version:3, id, timestamp, cwd }
 *   line 2+  — SessionEntry  { type, id, parentId, timestamp, ... }
 *
 * Entries form a tree via parentId; the active branch is the path from the
 * latest `leaf` entry's target to the root (or from the last entry when no
 * leaf entry exists). These mirror pi-agent-core's published types but are
 * declared locally so the library stays dependency-free.
 */

export interface SessionHeader {
  type: "session";
  version: 3;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface EntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCallContent)[];
  model?: string;
  stopReason?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  isError: boolean;
  timestamp: number;
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

export interface MessageEntry extends EntryBase {
  type: "message";
  message: AgentMessage;
}

export interface CompactionEntry extends EntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export interface SessionInfoEntry extends EntryBase {
  type: "session_info";
  name?: string;
}

export interface LeafEntry extends EntryBase {
  type: "leaf";
  targetId: string | null;
}

/** Entry types the reader does not interpret (model_change, label, custom…). */
export interface OtherEntry extends EntryBase {
  [key: string]: unknown;
}

export type SessionEntry =
  | MessageEntry
  | CompactionEntry
  | SessionInfoEntry
  | LeafEntry
  | OtherEntry;
