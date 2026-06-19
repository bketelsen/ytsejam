import { describe, it, expect } from "vitest";
import { DreamScheduler } from "../../../src/memory/dream/scheduler.ts";

const dateAt = (h: number) => new Date(2026, 5, 20, h, 0, 0);

describe("DreamScheduler.isDue", () => {
  it("due after the hour when not yet run today; not due before, or if already run", () => {
    let last: string | null = null;
    const s = new DreamScheduler({ run: async () => {}, hour: 3, lastRunDate: () => last, nowDate: () => dateAt(4) });
    expect(s.isDue()).toBe(true);
    const before = new DreamScheduler({ run: async () => {}, hour: 3, lastRunDate: () => last, nowDate: () => dateAt(2) });
    expect(before.isDue()).toBe(false);
    last = "2026-06-20";
    expect(s.isDue()).toBe(false);
  });
});

describe("DreamScheduler boot baseline (no daytime-restart run)", () => {
  it("first-ever boot past the hour seeds the baseline and does NOT run", () => {
    let last: string | null = null;
    const seeded: string[] = [];
    let ran = 0;
    const s = new DreamScheduler({
      run: async () => { ran++; },
      hour: 3,
      lastRunDate: () => last,
      nowDate: () => dateAt(18), // 6pm restart, never run today
      intervalMs: 60_000,
      recordBaseline: (d) => { seeded.push(d); last = d; }, // persist + reflect back
    });
    expect(s.shouldSeedBaseline()).toBe(true);
    s.start();
    expect(seeded).toEqual(["2026-06-20"]); // baseline recorded
    expect(ran).toBe(0); // boot tick is a no-op after seeding
    s.stop();
  });

  it("boot BEFORE the hour does not seed and does not run (waits for the hour)", () => {
    const seeded: string[] = [];
    let ran = 0;
    const s = new DreamScheduler({
      run: async () => { ran++; },
      hour: 3,
      lastRunDate: () => null,
      nowDate: () => dateAt(1), // 1am, before the hour
      intervalMs: 60_000,
      recordBaseline: (d) => seeded.push(d),
    });
    expect(s.shouldSeedBaseline()).toBe(false);
    s.start();
    expect(seeded).toEqual([]);
    expect(ran).toBe(0);
    s.stop();
  });
});
