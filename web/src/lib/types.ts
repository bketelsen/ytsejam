export interface SessionRow {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  preview: string;
  unread: boolean;
  archived?: boolean;
  running: boolean;
  compacting?: boolean;
  // Only the GET /api/sessions/:id response carries this; the list endpoint omits it.
  cwd?: string;
}

export interface LtmHealth {
  reachable: boolean;
  consecutiveFailures: number;
  lastTickAt?: string;
  lastTickStats?: {
    scannedFiles: number;
    scannedLines: number;
    replayed: number;
    skipped: number;
    errors: number;
  };
  lastError?: { message: string; at: string };
}

// The tri-state outline used by both icons in the chat header (Plug for WebSocket,
// Brain for LTM) and tracked by useApp. Owned here so the hook and the component
// share a single source of truth — adding a fourth state (e.g. "degraded") needs
// only one edit, not two. (Issue #117.)
export type HealthState = "unknown" | "ok" | "bad";

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

export interface SkillSummary {
  name: string;
  description: string;
  triggers: string[];
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
  | { type: "session_archived"; sessionId: string }
  | { type: "session_unarchived"; sessionId: string }
  | { type: "task"; task: TaskRow }
  | { type: "schedule"; schedule: ScheduleRow }
  | { type: "compaction_start"; sessionId: string; trigger: "proactive" | "reactive" }
  | { type: "compaction_end"; sessionId: string; status: "succeeded" | "surrendered" | "failed" };
