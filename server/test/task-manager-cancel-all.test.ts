import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { EventBus } from "../src/events.ts";
import { Indexer } from "../src/indexer.ts";
import { PersonaStore } from "../src/persona.ts";
import { PiAuthStore } from "../src/pi-auth.ts";
import { TaskStore } from "../src/tasks.ts";
import { TaskManager } from "../src/task-manager.ts";

function makeTaskManager(): TaskManager {
  const dataDir = mkdtempSync(join(tmpdir(), "tm-cancel-all-"));
  return new TaskManager({
    dataDir,
    store: new TaskStore(join(dataDir, "tasks")),
    indexer: new Indexer(join(dataDir, "index.db")),
    bus: new EventBus(),
    persona: new PersonaStore(join(dataDir, "persona")),
    authStore: new PiAuthStore(join(dataDir, "no-auth.json")),
    resolveModel: () => ({ provider: "faux", id: "faux", contextWindow: 100_000, maxTokens: 4096 }) as any,
    subagentModel: "faux/faux",
    workerTools: [],
    concurrency: 2,
    timeoutMs: 10_000,
    notifyParent: async () => {},
  });
}

function seedActive(tm: TaskManager, ids: string[]): void {
  const active = (tm as any).active as Map<string, unknown>;
  for (const id of ids) active.set(id, { taskId: id });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TaskManager.cancelAll", () => {
  test("calls cancel(id) on every active task and resolves once all return", async () => {
    const tm = makeTaskManager();
    seedActive(tm, ["task-1", "task-2", "task-3"]);
    let releaseTask2!: () => void;
    const task2Gate = new Promise<boolean>((resolve) => {
      releaseTask2 = () => resolve(true);
    });
    const cancel = vi.spyOn(tm, "cancel").mockImplementation(async (id) => {
      if (id === "task-2") return task2Gate;
      return true;
    });

    let settled = false;
    const cancelAll = (tm as any).cancelAll().then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(cancel).toHaveBeenCalledTimes(3);
    expect(cancel).toHaveBeenNthCalledWith(1, "task-1");
    expect(cancel).toHaveBeenNthCalledWith(2, "task-2");
    expect(cancel).toHaveBeenNthCalledWith(3, "task-3");
    expect(settled).toBe(false);

    releaseTask2();
    await cancelAll;
    expect(settled).toBe(true);
  });

  test("is a no-op when the active set is empty", async () => {
    const tm = makeTaskManager();
    const cancel = vi.spyOn(tm, "cancel").mockResolvedValue(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await (tm as any).cancelAll();

    expect(cancel).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  test("resolves even when one cancel() throws", async () => {
    const tm = makeTaskManager();
    seedActive(tm, ["task-1", "task-2", "task-3"]);
    const cancel = vi.spyOn(tm, "cancel").mockImplementation(async (id) => {
      if (id === "task-2") throw new Error("middle failed");
      return true;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect((tm as any).cancelAll()).resolves.toBeUndefined();

    expect(cancel).toHaveBeenCalledTimes(3);
    expect(cancel).toHaveBeenNthCalledWith(1, "task-1");
    expect(cancel).toHaveBeenNthCalledWith(2, "task-2");
    expect(cancel).toHaveBeenNthCalledWith(3, "task-3");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[task-manager.cancelAll] cancel failed for task task-2: middle failed"),
    );
  });
});
