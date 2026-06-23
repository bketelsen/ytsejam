import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PlanStore } from "../src/plans.ts";
import { createPlanTools } from "../src/tools/plan.ts";

function tools(sessionId = "s1") {
  const dir = mkdtempSync(join(tmpdir(), "plan-tools-"));
  const store = new PlanStore(join(dir, "plans"));
  const ts = createPlanTools(store, sessionId);
  const byName = Object.fromEntries(ts.map((t) => [t.name, t]));
  return { store, byName };
}

describe("createPlanTools", () => {
  test("registers plan_set, plan_update, plan_read and leaves them ungated", () => {
    const { byName } = tools();
    expect(Object.keys(byName).sort()).toEqual(["plan_read", "plan_set", "plan_update"]);
  });

  test("plan_set creates items and persists them", async () => {
    const { store, byName } = tools();
    const res = await byName.plan_set.execute("call", { items: ["alpha", "beta"] });
    expect(res.details.plan).toEqual([
      { id: "p1", text: "alpha", status: "pending" },
      { id: "p2", text: "beta", status: "pending" },
    ]);
    // persisted
    expect(store.current("s1")).toHaveLength(2);
    // rendered in the human-facing text
    expect((res.content[0] as { text: string }).text).toContain("(p1) alpha");
  });

  test("plan_update transitions status by id and persists", async () => {
    const { store, byName } = tools();
    await byName.plan_set.execute("c", { items: ["a", "b"] });
    const res = await byName.plan_update.execute("c", {
      updates: [{ id: "p2", status: "in_progress" }],
    });
    expect(res.details.plan.find((i: any) => i.id === "p2").status).toBe("in_progress");
    expect(store.current("s1")?.[1].status).toBe("in_progress");
  });

  test("plan_update rejects unknown ids with a clear error", async () => {
    const { byName } = tools();
    await byName.plan_set.execute("c", { items: ["a"] });
    await expect(
      byName.plan_update.execute("c", { updates: [{ id: "nope", status: "done" }] }),
    ).rejects.toThrow(/nope/);
  });

  test("plan_read returns the current plan", async () => {
    const { byName } = tools();
    await byName.plan_set.execute("c", { items: ["a"] });
    const res = await byName.plan_read.execute("c", {});
    expect(res.details.plan).toEqual([{ id: "p1", text: "a", status: "pending" }]);
  });

  test("plan_read reports an empty plan plainly", async () => {
    const { byName } = tools();
    const res = await byName.plan_read.execute("c", {});
    expect(res.details.plan).toEqual([]);
    expect((res.content[0] as { text: string }).text.toLowerCase()).toContain("no plan");
  });
});
