import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { EventBus, type ServerEvent } from "../src/events.ts";
import { Indexer } from "../src/indexer.ts";
import { ScheduleStore } from "../src/schedules.ts";
import { SchedulerService } from "../src/scheduler.ts";

interface Made {
  scheduler: SchedulerService;
  store: ScheduleStore;
  indexer: Indexer;
  bus: EventBus;
  injected: Array<{ sessionId: string; text: string }>;
  createdSessions: string[];
  setNow: (iso: string) => void;
}

function makeScheduler(): Made {
  const dataDir = mkdtempSync(join(tmpdir(), "schedsvc-"));
  const store = new ScheduleStore(join(dataDir, "schedules"));
  const indexer = new Indexer(join(dataDir, "index.db"));
  const bus = new EventBus();
  const injected: Array<{ sessionId: string; text: string }> = [];
  const createdSessions: string[] = [];
  let now = new Date("2026-06-09T10:00:00.000Z");
  let sessionCounter = 0;
  const scheduler = new SchedulerService({
    store,
    indexer,
    bus,
    now: () => now,
    inject: async (sessionId, text) => {
      injected.push({ sessionId, text });
    },
    createTargetSession: async (label) => {
      const id = `new-sess-${++sessionCounter}-${label}`;
      createdSessions.push(id);
      return id;
    },
  });
  return {
    scheduler,
    store,
    indexer,
    bus,
    injected,
    createdSessions,
    setNow: (iso) => {
      now = new Date(iso);
    },
  };
}

describe("SchedulerService", () => {
  test("create validates and indexes; one-shot fires once at its time into the target session", async () => {
    const m = makeScheduler();
    const row = m.scheduler.create({
      label: "dentist",
      prompt: "remind the user about the dentist appointment",
      spec: { type: "once", at: "2026-06-09T11:00:00.000Z" },
      targetSessionId: "sess-1",
    });
    expect(row.enabled).toBe(true);
    expect(m.indexer.getSchedule(row.id)).toMatchObject({ nextFireAt: "2026-06-09T11:00:00.000Z" });

    await m.scheduler.tick();
    expect(m.injected).toEqual([]); // not due yet

    m.setNow("2026-06-09T11:00:01.000Z");
    await m.scheduler.tick();
    expect(m.injected).toHaveLength(1);
    expect(m.injected[0]!.sessionId).toBe("sess-1");
    expect(m.injected[0]!.text).toContain('[Scheduled task "dentist"]');
    expect(m.injected[0]!.text).toContain("dentist appointment");
    expect(m.indexer.getSchedule(row.id)).toMatchObject({ enabled: false, firedCount: 1 });

    await m.scheduler.tick(); // does not fire again
    expect(m.injected).toHaveLength(1);
  });

  test("cron fires repeatedly with advancing nextFireAt", async () => {
    const m = makeScheduler();
    const row = m.scheduler.create({
      label: "quarterly",
      prompt: "check in",
      spec: { type: "cron", expr: "*/15 * * * *" },
      targetSessionId: "sess-1",
    });
    m.setNow("2026-06-09T10:16:00.000Z");
    await m.scheduler.tick();
    expect(m.injected).toHaveLength(1);
    const afterFirst = m.indexer.getSchedule(row.id)!;
    expect(afterFirst.enabled).toBe(true);
    expect(afterFirst.firedCount).toBe(1);
    expect(new Date(afterFirst.nextFireAt!).getTime()).toBeGreaterThan(
      new Date("2026-06-09T10:16:00.000Z").getTime(),
    );

    m.setNow("2026-06-09T10:31:00.000Z");
    await m.scheduler.tick();
    expect(m.injected).toHaveLength(2);
  });

  test("null target creates a fresh session at fire time", async () => {
    const m = makeScheduler();
    m.scheduler.create({
      label: "briefing",
      prompt: "morning briefing",
      spec: { type: "once", at: "2026-06-09T10:30:00.000Z" },
      targetSessionId: null,
    });
    m.setNow("2026-06-09T10:31:00.000Z");
    await m.scheduler.tick();
    expect(m.createdSessions).toHaveLength(1);
    expect(m.injected[0]!.sessionId).toBe(m.createdSessions[0]);
  });

  test("cancel disables; create rejects invalid input", async () => {
    const m = makeScheduler();
    const row = m.scheduler.create({
      label: "x",
      prompt: "y",
      spec: { type: "once", at: "2026-06-09T11:00:00.000Z" },
      targetSessionId: "sess-1",
    });
    expect(m.scheduler.cancel(row.id)).toBe(true);
    expect(m.scheduler.cancel(row.id)).toBe(false); // already cancelled
    m.setNow("2026-06-09T12:00:00.000Z");
    await m.scheduler.tick();
    expect(m.injected).toEqual([]);

    expect(() =>
      m.scheduler.create({
        label: "bad",
        prompt: "p",
        spec: { type: "once", at: "2026-06-09T09:00:00.000Z" }, // in the past
        targetSessionId: "s",
      }),
    ).toThrow(/future/);
    expect(() =>
      m.scheduler.create({
        label: "bad",
        prompt: "p",
        spec: { type: "cron", expr: "garbage" },
        targetSessionId: "s",
      }),
    ).toThrow();
  });

  test("catchUp: overdue one-shot fires once, overdue cron reschedules without firing", async () => {
    const m = makeScheduler();
    // events written "by a previous process": both due in the past
    m.store.append({
      type: "created",
      scheduleId: "old-once",
      label: "missed reminder",
      prompt: "missed it",
      spec: { type: "once", at: "2026-06-09T08:00:00.000Z" },
      targetSessionId: "sess-1",
      nextFireAt: "2026-06-09T08:00:00.000Z",
      timestamp: "2026-06-08T10:00:00.000Z",
    });
    m.store.append({
      type: "created",
      scheduleId: "old-cron",
      label: "hourly",
      prompt: "tick",
      spec: { type: "cron", expr: "0 * * * *" },
      targetSessionId: "sess-1",
      nextFireAt: "2026-06-09T08:00:00.000Z",
      timestamp: "2026-06-08T10:00:00.000Z",
    });
    await m.scheduler.rebuildIndex();
    await m.scheduler.catchUp();

    // one-shot fired exactly once
    expect(m.injected).toHaveLength(1);
    expect(m.injected[0]!.text).toContain("missed reminder");
    expect(m.indexer.getSchedule("old-once")).toMatchObject({ enabled: false, firedCount: 1 });

    // cron did NOT fire, but nextFireAt moved into the future
    const cron = m.indexer.getSchedule("old-cron")!;
    expect(cron.firedCount).toBe(0);
    expect(new Date(cron.nextFireAt!).getTime()).toBeGreaterThan(
      new Date("2026-06-09T10:00:00.000Z").getTime(),
    );
  });

  test("schedule events flow over the bus", async () => {
    const m = makeScheduler();
    const events: ServerEvent[] = [];
    m.bus.subscribe((e) => events.push(e));
    m.scheduler.create({
      label: "x",
      prompt: "y",
      spec: { type: "once", at: "2026-06-09T11:00:00.000Z" },
      targetSessionId: "s",
    });
    expect(events.some((e) => e.type === "schedule")).toBe(true);
  });
});
