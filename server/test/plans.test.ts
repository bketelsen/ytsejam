import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PlanStore, renderPlanSection } from "../src/plans.ts";

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "plan-"));
  return new PlanStore(join(dir, "plans"));
}

describe("PlanStore.set", () => {
  test("creates items with sequential ids and pending status", () => {
    const store = freshStore();
    const plan = store.set("s1", ["write tests", "implement", "ship"]);
    expect(plan).toEqual([
      { id: "p1", text: "write tests", status: "pending" },
      { id: "p2", text: "implement", status: "pending" },
      { id: "p3", text: "ship", status: "pending" },
    ]);
  });

  test("replaces the whole plan, reassigning ids from p1", () => {
    const store = freshStore();
    store.set("s1", ["a", "b", "c"]);
    const plan = store.set("s1", ["x", "y"]);
    expect(plan.map((i) => i.id)).toEqual(["p1", "p2"]);
    expect(plan.map((i) => i.text)).toEqual(["x", "y"]);
  });

  test("an empty list clears the plan", () => {
    const store = freshStore();
    store.set("s1", ["a"]);
    expect(store.set("s1", [])).toEqual([]);
    expect(store.current("s1")).toEqual([]);
  });
});

describe("PlanStore.update", () => {
  test("transitions a single item's status", () => {
    const store = freshStore();
    store.set("s1", ["a", "b"]);
    const plan = store.update("s1", { updates: [{ id: "p1", status: "in_progress" }] });
    expect(plan.find((i) => i.id === "p1")?.status).toBe("in_progress");
    expect(plan.find((i) => i.id === "p2")?.status).toBe("pending");
  });

  test("transitions multiple items in one call", () => {
    const store = freshStore();
    store.set("s1", ["a", "b", "c"]);
    const plan = store.update("s1", {
      updates: [
        { id: "p1", status: "done" },
        { id: "p3", status: "cancelled" },
      ],
    });
    expect(plan.map((i) => i.status)).toEqual(["done", "pending", "cancelled"]);
  });

  test("edits item text", () => {
    const store = freshStore();
    store.set("s1", ["a"]);
    const plan = store.update("s1", { updates: [{ id: "p1", text: "a (revised)" }] });
    expect(plan[0]).toEqual({ id: "p1", text: "a (revised)", status: "pending" });
  });

  test("adds new pending items with fresh non-colliding ids", () => {
    const store = freshStore();
    store.set("s1", ["a", "b"]);
    const plan = store.update("s1", { add: ["c"] });
    expect(plan).toHaveLength(3);
    expect(plan[2]).toEqual({ id: "p3", text: "c", status: "pending" });
  });

  test("removes items by id", () => {
    const store = freshStore();
    store.set("s1", ["a", "b", "c"]);
    const plan = store.update("s1", { remove: ["p2"] });
    expect(plan.map((i) => i.id)).toEqual(["p1", "p3"]);
  });

  test("rejects unknown ids with a clear error and does not mutate", () => {
    const store = freshStore();
    store.set("s1", ["a"]);
    expect(() => store.update("s1", { updates: [{ id: "p9", status: "done" }] })).toThrow(/p9/);
    // unchanged
    expect(store.current("s1")).toEqual([{ id: "p1", text: "a", status: "pending" }]);
  });

  test("rejects an invalid status", () => {
    const store = freshStore();
    store.set("s1", ["a"]);
    expect(() =>
      store.update("s1", { updates: [{ id: "p1", status: "bogus" as never }] }),
    ).toThrow(/status/i);
  });
});

describe("PlanStore persistence", () => {
  test("survives a reload by recreating the store from disk (latest wins)", () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-"));
    const storeDir = join(dir, "plans");
    const a = new PlanStore(storeDir);
    a.set("s1", ["a", "b"]);
    a.update("s1", { updates: [{ id: "p1", status: "done" }] });

    // brand-new store instance reading the same dir
    const b = new PlanStore(storeDir);
    expect(b.current("s1")).toEqual([
      { id: "p1", text: "a", status: "done" },
      { id: "p2", text: "b", status: "pending" },
    ]);
  });

  test("is independent per session", () => {
    const store = freshStore();
    store.set("s1", ["a"]);
    expect(store.current("s2")).toBeUndefined();
  });

  test("skips malformed lines so a corrupt write can't break boot", () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-"));
    const storeDir = join(dir, "plans");
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(
      join(storeDir, "s1.jsonl"),
      `${JSON.stringify({ items: [{ id: "p1", text: "old", status: "pending" }], timestamp: "x" })}\n` +
        "not json\n" +
        `${JSON.stringify({ items: [{ id: "p1", text: "new", status: "done" }], timestamp: "y" })}\n`,
    );
    const store = new PlanStore(storeDir);
    expect(store.current("s1")).toEqual([{ id: "p1", text: "new", status: "done" }]);
  });

  test("current() is undefined when nothing was ever set", () => {
    expect(freshStore().current("never")).toBeUndefined();
  });
});

describe("renderPlanSection", () => {
  test("returns undefined for an absent or empty plan", () => {
    expect(renderPlanSection(undefined)).toBeUndefined();
    expect(renderPlanSection([])).toBeUndefined();
  });

  test("renders checkbox-style statuses with ids under a Current plan heading", () => {
    const out = renderPlanSection([
      { id: "p1", text: "pending item", status: "pending" },
      { id: "p2", text: "active item", status: "in_progress" },
      { id: "p3", text: "finished item", status: "done" },
      { id: "p4", text: "dropped item", status: "cancelled" },
    ]);
    expect(out).toContain("## Current plan");
    expect(out).toContain("- [ ] (p1) pending item");
    expect(out).toContain("- [~] (p2) active item");
    expect(out).toContain("- [x] (p3) finished item");
    expect(out).toContain("- [-] (p4) dropped item");
  });

  test("bounds the number of rendered items", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: `p${i + 1}`,
      text: `item ${i + 1}`,
      status: "pending" as const,
    }));
    const out = renderPlanSection(many)!;
    expect(out).toContain("and 10 more");
    expect(out).not.toContain("(p60)");
  });
});
