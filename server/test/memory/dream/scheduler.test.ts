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
