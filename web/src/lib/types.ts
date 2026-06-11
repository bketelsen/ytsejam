export interface SessionRow {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  preview: string;
  unread: boolean;
  running: boolean;
  // Only the GET /api/sessions/:id response carries this; the list endpoint omits it.
  cwd?: string;
}

export interface ContentBlock {
  type: string; // "text" | "thinking" | "toolCall" | "image" | ...
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

export interface ChatMessage {
  role: string; // "user" | "assistant" | "toolResult" | custom
  content: ContentBlock[] | string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  errorMessage?: string;
  stopReason?: string;
  timestamp?: number;
  details?: unknown;
}

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface TaskRow {
  id: string;
  parentSessionId: string;
  subagentSessionId: string | null;
  label: string;
  status: TaskStatus;
  model: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  resultSummary: string;
}

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  ref: string;
}

export type ScheduleSpec = { type: "once"; at: string } | { type: "cron"; expr: string };

export interface ScheduleRow {
  id: string;
  label: string;
  prompt: string;
  spec: ScheduleSpec;
  targetSessionId: string | null;
  enabled: boolean;
  cancelled: boolean;
  createdAt: string;
  lastFiredAt: string | null;
  nextFireAt: string | null;
  firedCount: number;
}

export type ServerEvent =
  | { type: "agent"; sessionId: string; event: { type: string; message?: ChatMessage; [k: string]: unknown } }
  | { type: "session_meta"; session: SessionRow }
  | { type: "session_deleted"; sessionId: string }
  | { type: "task"; task: TaskRow }
  | { type: "schedule"; schedule: ScheduleRow };
