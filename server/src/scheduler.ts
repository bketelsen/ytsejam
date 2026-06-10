import { uuidv7 } from "@earendil-works/pi-agent-core";
import type { EventBus } from "./events.ts";
import type { Indexer } from "./indexer.ts";
import {
  computeNextFire,
  type ScheduleRow,
  type ScheduleSpec,
  type ScheduleStore,
} from "./schedules.ts";

export interface CreateScheduleInput {
  label: string;
  prompt: string;
  spec: ScheduleSpec;
  /** null = create a fresh session at fire time */
  targetSessionId: string | null;
}

export interface SchedulerOptions {
  store: ScheduleStore;
  indexer: Indexer;
  bus: EventBus;
  /** injectable clock for tests */
  now?: () => Date;
  /** inject the fire text into a session (assistant takes a turn) */
  inject: (sessionId: string, text: string) => Promise<void>;
  /** create a fresh chat session for schedules without a target; returns its id */
  createTargetSession: (label: string) => Promise<string>;
}

/**
 * Fires due schedules by injecting their prompt into the target session.
 * Schedule events in ScheduleStore are the SSOT; sqlite/bus are derived.
 * nextFireAt is precomputed on each event so folding needs no clock.
 */
export class SchedulerService {
  private readonly opts: SchedulerOptions;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(opts: SchedulerOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => new Date());
  }

  // ---- public API ----------------------------------------------------------

  create(input: CreateScheduleInput): ScheduleRow {
    const now = this.now();
    if (input.spec.type === "once") {
      const at = new Date(input.spec.at);
      if (Number.isNaN(at.getTime())) throw new Error(`Invalid timestamp: ${input.spec.at}`);
      if (at.getTime() <= now.getTime()) throw new Error("Schedule time must be in the future");
    }
    const nextFireAt = computeNextFire(input.spec, now); // throws on bad cron
    const scheduleId = uuidv7();
    return this.record({
      type: "created",
      scheduleId,
      label: input.label,
      prompt: input.prompt,
      spec: input.spec,
      targetSessionId: input.targetSessionId,
      nextFireAt,
      timestamp: now.toISOString(),
    });
  }

  list(): ScheduleRow[] {
    return this.opts.indexer.listSchedules();
  }

  /** Cancel an active schedule. False when unknown or already cancelled/spent. */
  cancel(scheduleId: string): boolean {
    const row = this.opts.store.foldAll().get(scheduleId);
    if (!row || !row.enabled) return false;
    this.record({ type: "cancelled", scheduleId, timestamp: this.now().toISOString() });
    return true;
  }

  /** Fire everything due. Serialized: overlapping calls are skipped. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const row of this.opts.store.foldAll().values()) {
        if (!row.enabled || !row.nextFireAt) continue;
        if (new Date(row.nextFireAt).getTime() > now.getTime()) continue;
        await this.fire(row);
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Boot recovery: overdue one-shots fire once (the user wanted them);
   * overdue crons skip missed occurrences and reschedule from now.
   */
  async catchUp(): Promise<void> {
    const now = this.now();
    for (const row of this.opts.store.foldAll().values()) {
      if (!row.enabled || !row.nextFireAt) continue;
      if (new Date(row.nextFireAt).getTime() > now.getTime()) continue;
      if (row.spec.type === "once") {
        await this.fire(row);
      } else {
        this.record({
          type: "rescheduled",
          scheduleId: row.id,
          nextFireAt: computeNextFire(row.spec, now),
          timestamp: now.toISOString(),
        });
      }
    }
  }

  /** Repopulate the (derived) schedules table from JSONL. */
  async rebuildIndex(): Promise<void> {
    for (const row of this.opts.store.foldAll().values()) {
      this.opts.indexer.upsertSchedule(row);
    }
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => console.error("scheduler tick failed", err));
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- internals -----------------------------------------------------------

  private record(event: Parameters<ScheduleStore["append"]>[0]): ScheduleRow {
    this.opts.store.append(event);
    const row = this.opts.store.foldAll().get(event.scheduleId)!;
    this.opts.indexer.upsertSchedule(row);
    this.opts.bus.emit({ type: "schedule", schedule: row });
    return row;
  }

  private async fire(row: ScheduleRow): Promise<void> {
    const now = this.now();
    // record the firing FIRST so a crash mid-inject can't double-fire on catch-up
    this.record({
      type: "fired",
      scheduleId: row.id,
      firedAt: now.toISOString(),
      nextFireAt: row.spec.type === "cron" ? computeNextFire(row.spec, now) : null,
      timestamp: now.toISOString(),
    });
    try {
      // a createTargetSession failure also counts as a spent fire (fired was
      // recorded above) — record-first means no retry but never a double-fire
      const sessionId =
        row.targetSessionId ?? (await this.opts.createTargetSession(row.label));
      await this.opts.inject(sessionId, `[Scheduled task "${row.label}"] ${row.prompt}`);
    } catch (err) {
      console.error(`failed to fire schedule ${row.id} ("${row.label}")`, err);
    }
  }
}
