import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, test } from "vitest";
import { PlanStore, renderPlanSection } from "../src/plans.ts";

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "plan-"));
  return new PlanStore(join(dir, "plans"));
}

function planFile(store: PlanStore, sessionId: string): string {
  return join(store.storeDir, `${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}.jsonl`);
}

function lineCount(file: string): number {
  return readFileSync(file, "utf8").split("\n").filter(Boolean).length;
}

function runWorkerUpdate(args: {
  storeDir: string;
  sessionId: string;
  text: string;
  moduleUrl: string;
  barrier: SharedArrayBuffer;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const code = `
      import { parentPort, workerData } from "node:worker_threads";
      import { PlanStore } from ${JSON.stringify(args.moduleUrl)};

      const barrier = new Int32Array(workerData.barrier);
      Atomics.add(barrier, 0, 1);
      Atomics.notify(barrier, 0);
      while (Atomics.load(barrier, 1) === 0) Atomics.wait(barrier, 1, 0);

      const store = new PlanStore(workerData.storeDir);
      store.update(workerData.sessionId, { add: [workerData.text] });
      parentPort.postMessage("ok");
    `;
    const worker = new Worker(code, {
      eval: true,
      workerData: args,
    });
    worker.once("message", () => resolve());
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`worker exited with code ${code}`));
    });
  });
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

describe("PlanStore concurrency", () => {
  test("serializes overlapping same-session updates so none are lost", async () => {
    const store = freshStore();
    const sessionId = "same-session";
    store.set(sessionId, ["seed"]);

    const workerCount = 48;
    const barrier = new SharedArrayBuffer(8);
    const view = new Int32Array(barrier);
    const moduleUrl = new URL("../src/plans.ts", import.meta.url).href;
    const updates = Array.from({ length: workerCount }, (_, i) =>
      runWorkerUpdate({
        storeDir: store.storeDir,
        sessionId,
        text: `worker item ${i}`,
        moduleUrl,
        barrier,
      }),
    );

    const readyDeadline = Date.now() + 5000;
    while (Atomics.load(view, 0) < workerCount && Date.now() < readyDeadline) {
      Atomics.wait(view, 0, Atomics.load(view, 0), 100);
    }
    expect(Atomics.load(view, 0)).toBe(workerCount);
    Atomics.store(view, 1, 1);
    Atomics.notify(view, 1, workerCount);

    await Promise.all(updates);

    const final = store.current(sessionId) ?? [];
    expect(final).toHaveLength(workerCount + 1);
    expect(new Set(final.map((item) => item.text)).size).toBe(workerCount + 1);
    for (let i = 0; i < workerCount; i += 1) {
      expect(final.map((item) => item.text)).toContain(`worker item ${i}`);
    }
  });
});

describe("PlanStore compaction", () => {
  test("compacts a long session log to a bounded file while preserving the latest plan", () => {
    const store = freshStore();
    const sessionId = "compact-me";
    store.set(sessionId, ["seed"]);

    for (let i = 0; i < 225; i += 1) {
      store.update(sessionId, { add: [`step ${i}`] });
    }

    const file = planFile(store, sessionId);
    expect(lineCount(file)).toBeLessThan(50);
    expect(store.current(sessionId)).toHaveLength(226);
    expect(store.current(sessionId)?.at(-1)).toEqual({
      id: "p226",
      text: "step 224",
      status: "pending",
    });
    expect(readdirSync(store.storeDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("compacts only the mutated session and leaves other sessions independent", () => {
    const store = freshStore();
    store.set("busy", ["seed"]);
    store.set("quiet", ["a"]);
    store.update("quiet", { add: ["b"] });

    for (let i = 0; i < 225; i += 1) {
      store.update("busy", { add: [`busy ${i}`] });
    }

    expect(lineCount(planFile(store, "busy"))).toBeLessThan(50);
    expect(lineCount(planFile(store, "quiet"))).toBe(2);
    expect(store.current("quiet")).toEqual([
      { id: "p1", text: "a", status: "pending" },
      { id: "p2", text: "b", status: "pending" },
    ]);
  });

  test("still tolerates a corrupt trailing line after compaction", () => {
    const store = freshStore();
    const sessionId = "corrupt-after-compact";
    store.set(sessionId, ["seed"]);
    for (let i = 0; i < 225; i += 1) {
      store.update(sessionId, { add: [`step ${i}`] });
    }

    appendFileSync(planFile(store, sessionId), "not json\n");

    expect(store.current(sessionId)).toHaveLength(226);
    expect(store.current(sessionId)?.at(-1)?.text).toBe("step 224");
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
