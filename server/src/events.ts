import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { SessionRow } from "./indexer.ts";
import type { TaskRow } from "./tasks.ts";
import type { ScheduleRow } from "./schedules.ts";

export type ServerEvent =
  | { type: "agent"; sessionId: string; event: AgentEvent }
  | { type: "session_meta"; session: SessionRow & { running: boolean; compacting: boolean } }
  | { type: "session_archived"; sessionId: string }
  | { type: "session_unarchived"; sessionId: string }
  | { type: "task"; task: TaskRow }
  | { type: "schedule"; schedule: ScheduleRow }
  | { type: "compaction_start"; sessionId: string; trigger: "proactive" | "reactive" }
  | { type: "compaction_end"; sessionId: string; status: "succeeded" | "surrendered" | "failed" };

export class EventBus {
  private listeners = new Set<(event: ServerEvent) => void>();

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: ServerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("event listener failed", err);
      }
    }
  }
}
