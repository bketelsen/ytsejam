import fs from "node:fs";
import path from "node:path";
import { CronExpressionParser } from "cron-parser";

export type ScheduleSpec = { type: "once"; at: string } | { type: "cron"; expr: string };

/** Derived row (sqlite + API + UI). The JSONL events are the SSOT. */
export interface ScheduleRow {
  id: string;
  label: string;
  prompt: string;
  spec: ScheduleSpec;
  /** null = create a fresh session at fire time */
  targetSessionId: string | null;
  enabled: boolean;
  cancelled: boolean;
  createdAt: string;
  lastFiredAt: string | null;
  nextFireAt: string | null;
  firedCount: number;
}

export type ScheduleEvent =
  | {
      type: "created";
      scheduleId: string;
      label: string;
      prompt: string;
      spec: ScheduleSpec;
      targetSessionId: string | null;
      nextFireAt: string;
      timestamp: string;
    }
  | { type: "fired"; scheduleId: string; firedAt: string; nextFireAt: string | null; timestamp: string }
  | { type: "rescheduled"; scheduleId: string; nextFireAt: string | null; timestamp: string }
  | { type: "cancelled"; scheduleId: string; timestamp: string };

/**
 * Next occurrence for a spec, strictly after `from`. Cron expressions
 * evaluate in the server's local timezone. Throws on invalid cron syntax.
 */
export function computeNextFire(spec: ScheduleSpec, from: Date): string {
  if (spec.type === "once") return spec.at;
  return CronExpressionParser.parse(spec.expr, { currentDate: from }).next().toDate().toISOString();
}

export function foldScheduleEvents(events: ScheduleEvent[]): Map<string, ScheduleRow> {
  const rows = new Map<string, ScheduleRow>();
  for (const e of events) {
    if (e.type === "created") {
      rows.set(e.scheduleId, {
        id: e.scheduleId,
        label: e.label,
        prompt: e.prompt,
        spec: e.spec,
        targetSessionId: e.targetSessionId,
        enabled: true,
        cancelled: false,
        createdAt: e.timestamp,
        lastFiredAt: null,
        nextFireAt: e.nextFireAt,
        firedCount: 0,
      });
      continue;
    }
    const row = rows.get(e.scheduleId);
    if (!row) continue; // tolerate orphaned events
    if (e.type === "fired") {
      row.firedCount += 1;
      row.lastFiredAt = e.firedAt;
      row.nextFireAt = e.nextFireAt;
      if (row.spec.type === "once") row.enabled = false;
    } else if (e.type === "rescheduled") {
      row.nextFireAt = e.nextFireAt;
    } else if (e.type === "cancelled") {
      row.cancelled = true;
      row.enabled = false;
    }
  }
  return rows;
}

/** Append-only schedule lifecycle events, one shared JSONL file. */
export class ScheduleStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private get filePath(): string {
    return path.join(this.dir, "schedules.jsonl");
  }

  append(event: ScheduleEvent): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`);
  }

  readAll(): ScheduleEvent[] {
    try {
      return fs
        .readFileSync(this.filePath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ScheduleEvent);
    } catch {
      return [];
    }
  }

  foldAll(): Map<string, ScheduleRow> {
    return foldScheduleEvents(this.readAll());
  }
}
