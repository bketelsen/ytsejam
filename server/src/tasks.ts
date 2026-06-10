import fs from "node:fs";
import path from "node:path";

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

/** Derived row (sqlite + API + UI). The JSONL events are the SSOT. */
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

export type TaskEvent =
  | {
      type: "created";
      taskId: string;
      parentSessionId: string;
      label: string;
      task: string;
      context?: string;
      model: string;
      timestamp: string;
    }
  | { type: "started"; taskId: string; subagentSessionId: string; timestamp: string }
  | { type: "completed"; taskId: string; report: string; timestamp: string }
  | { type: "failed"; taskId: string; error: string; timestamp: string }
  | { type: "cancelled"; taskId: string; timestamp: string }
  | { type: "interrupted"; taskId: string; timestamp: string };

const SUMMARY_MAX = 500;

export function foldTaskEvents(events: TaskEvent[]): TaskRow | undefined {
  const created = events.find((e) => e.type === "created");
  if (!created || created.type !== "created") return undefined;
  const row: TaskRow = {
    id: created.taskId,
    parentSessionId: created.parentSessionId,
    subagentSessionId: null,
    label: created.label,
    status: "pending",
    model: created.model,
    createdAt: created.timestamp,
    startedAt: null,
    finishedAt: null,
    resultSummary: "",
  };
  for (const e of events) {
    switch (e.type) {
      case "started":
        row.status = "running";
        row.subagentSessionId = e.subagentSessionId;
        row.startedAt = e.timestamp;
        break;
      case "completed":
        row.status = "completed";
        row.finishedAt = e.timestamp;
        row.resultSummary = e.report.slice(0, SUMMARY_MAX);
        break;
      case "failed":
        row.status = "failed";
        row.finishedAt = e.timestamp;
        row.resultSummary = e.error.slice(0, SUMMARY_MAX);
        break;
      case "cancelled":
        row.status = "cancelled";
        row.finishedAt = e.timestamp;
        break;
      case "interrupted":
        row.status = "interrupted";
        row.finishedAt = e.timestamp;
        break;
    }
  }
  return row;
}

/** Append-only task lifecycle events, one JSONL file per task. */
export class TaskStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  append(event: TaskEvent): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(path.join(this.dir, `${event.taskId}.jsonl`), `${JSON.stringify(event)}\n`);
  }

  read(taskId: string): TaskEvent[] {
    try {
      return fs
        .readFileSync(path.join(this.dir, `${taskId}.jsonl`), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TaskEvent);
    } catch {
      return [];
    }
  }

  fold(taskId: string): TaskRow | undefined {
    return foldTaskEvents(this.read(taskId));
  }

  listIds(): string[] {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => f.slice(0, -".jsonl".length));
    } catch {
      return [];
    }
  }
}
