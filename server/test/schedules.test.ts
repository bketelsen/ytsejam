import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  computeNextFire,
  foldScheduleEvents,
  ScheduleStore,
  type ScheduleEvent,
} from "../src/schedules.ts";

const dir = () => join(mkdtempSync(join(tmpdir(), "sched-")), "schedules");

const onceCreated: ScheduleEvent = {
  type: "created",
  scheduleId: "s1",
  label: "remind me",
  prompt: "remind the user about the dentist",
  spec: { type: "once", at: "2026-06-10T09:00:00.000Z" },
  targetSessionId: "sess-1",
  nextFireAt: "2026-06-10T09:00:00.000Z",
  timestamp: "2026-06-09T10:00:00.000Z",
};

describe("computeNextFire", () => {
  test("once: returns the at time", () => {
    expect(computeNextFire({ type: "once", at: "2026-06-10T09:00:00.000Z" }, new Date())).toBe(
      "2026-06-10T09:00:00.000Z",
    );
  });

  test("cron: returns the next occurrence after from", () => {
    const from = new Date("2026-06-09T10:00:00.000Z");
    const next = computeNextFire({ type: "cron", expr: "*/15 * * * *" }, from);
    expect(next).toBe("2026-06-09T10:15:00.000Z");
  });

  test("cron: throws on invalid expressions", () => {
    expect(() => computeNextFire({ type: "cron", expr: "not a cron" }, new Date())).toThrow();
  });
});

describe("foldScheduleEvents", () => {
  test("created → enabled with nextFireAt", () => {
    const rows = foldScheduleEvents([onceCreated]);
    expect(rows.get("s1")).toMatchObject({
      id: "s1",
      label: "remind me",
      enabled: true,
      cancelled: false,
      firedCount: 0,
      nextFireAt: "2026-06-10T09:00:00.000Z",
      lastFiredAt: null,
    });
  });

  test("one-shot fired → disabled; cron fired → stays enabled with new nextFireAt", () => {
    const rows = foldScheduleEvents([
      onceCreated,
      { type: "fired", scheduleId: "s1", firedAt: "2026-06-10T09:00:01.000Z", nextFireAt: null, timestamp: "2026-06-10T09:00:01.000Z" },
      {
        ...onceCreated,
        scheduleId: "s2",
        spec: { type: "cron", expr: "0 9 * * *" },
        nextFireAt: "2026-06-10T09:00:00.000Z",
      },
      { type: "fired", scheduleId: "s2", firedAt: "2026-06-10T09:00:01.000Z", nextFireAt: "2026-06-11T09:00:00.000Z", timestamp: "2026-06-10T09:00:01.000Z" },
    ]);
    expect(rows.get("s1")).toMatchObject({ enabled: false, firedCount: 1, nextFireAt: null });
    expect(rows.get("s2")).toMatchObject({
      enabled: true,
      firedCount: 1,
      nextFireAt: "2026-06-11T09:00:00.000Z",
      lastFiredAt: "2026-06-10T09:00:01.000Z",
    });
  });

  test("cancelled and rescheduled events", () => {
    const rows = foldScheduleEvents([
      onceCreated,
      { type: "rescheduled", scheduleId: "s1", nextFireAt: "2026-06-12T09:00:00.000Z", timestamp: "x" },
      { type: "cancelled", scheduleId: "s1", timestamp: "y" },
    ]);
    expect(rows.get("s1")).toMatchObject({
      enabled: false,
      cancelled: true,
      nextFireAt: "2026-06-12T09:00:00.000Z",
    });
  });
});

describe("ScheduleStore", () => {
  test("append/foldAll round-trip in a single JSONL file", () => {
    const store = new ScheduleStore(dir());
    expect(store.foldAll().size).toBe(0);
    store.append(onceCreated);
    store.append({ ...onceCreated, scheduleId: "s2" });
    store.append({ type: "cancelled", scheduleId: "s2", timestamp: "y" });
    const rows = store.foldAll();
    expect(rows.size).toBe(2);
    expect(rows.get("s1")!.enabled).toBe(true);
    expect(rows.get("s2")!.cancelled).toBe(true);
  });
});
