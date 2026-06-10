import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { foldTaskEvents, TaskStore, type TaskEvent } from "../src/tasks.ts";

const dir = () => join(mkdtempSync(join(tmpdir(), "tasks-")), "tasks");

const created: TaskEvent = {
  type: "created",
  taskId: "t1",
  parentSessionId: "p1",
  label: "research",
  task: "find things",
  model: "faux/faux",
  timestamp: "2026-06-09T10:00:00Z",
};

describe("foldTaskEvents", () => {
  test("folds the full lifecycle", () => {
    const pending = foldTaskEvents([created])!;
    expect(pending).toMatchObject({
      id: "t1",
      parentSessionId: "p1",
      label: "research",
      status: "pending",
      subagentSessionId: null,
      startedAt: null,
      finishedAt: null,
    });

    const done = foldTaskEvents([
      created,
      { type: "started", taskId: "t1", subagentSessionId: "s1", timestamp: "2026-06-09T10:00:01Z" },
      { type: "completed", taskId: "t1", report: "the answer", timestamp: "2026-06-09T10:00:05Z" },
    ])!;
    expect(done).toMatchObject({
      status: "completed",
      subagentSessionId: "s1",
      startedAt: "2026-06-09T10:00:01Z",
      finishedAt: "2026-06-09T10:00:05Z",
      resultSummary: "the answer",
    });
  });

  test("failed, cancelled, interrupted statuses", () => {
    const failed = foldTaskEvents([
      created,
      { type: "started", taskId: "t1", subagentSessionId: "s1", timestamp: "x" },
      { type: "failed", taskId: "t1", error: "boom", timestamp: "y" },
    ])!;
    expect(failed.status).toBe("failed");
    expect(failed.resultSummary).toBe("boom");

    expect(foldTaskEvents([created, { type: "cancelled", taskId: "t1", timestamp: "y" }])!.status).toBe("cancelled");
    expect(foldTaskEvents([created, { type: "interrupted", taskId: "t1", timestamp: "y" }])!.status).toBe("interrupted");
    expect(foldTaskEvents([])).toBeUndefined();
  });
});

describe("TaskStore", () => {
  test("append/read round-trip and listIds", () => {
    const store = new TaskStore(dir());
    expect(store.read("t1")).toEqual([]);
    expect(store.listIds()).toEqual([]);
    store.append(created);
    store.append({ type: "started", taskId: "t1", subagentSessionId: "s1", timestamp: "x" });
    store.append({ ...created, taskId: "t2" });
    expect(store.read("t1").length).toBe(2);
    expect(store.fold("t1")!.status).toBe("running");
    expect(new Set(store.listIds())).toEqual(new Set(["t1", "t2"]));
  });
});
