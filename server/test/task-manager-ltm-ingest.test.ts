import { existsSync, readdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EventBus } from "../src/events.ts";
import { Indexer } from "../src/indexer.ts";
import { PersonaStore } from "../src/persona.ts";
import { PiAuthStore } from "../src/pi-auth.ts";
import { TaskStore } from "../src/tasks.ts";
import { TaskManager } from "../src/task-manager.ts";
import { fauxAssistantMessage, setupFaux, waitFor } from "./helpers.ts";

let faux: ReturnType<typeof setupFaux>;
beforeEach(() => {
  faux = setupFaux();
});
afterEach(() => {
  faux.unregister();
});

describe("TaskManager LTM ingest", () => {
  test("ingests the on-disk subagent session JSONL once after task completion", async () => {
    const ltm = {
      ingestSessionFile: vi.fn(async (_path: string) => ({
        sessionsSeen: 1,
        turnsIngested: 1,
        recordsCreated: 1,
        warnings: [],
      })),
    };
    const dataDir = mkdtempSync(join(tmpdir(), "tm-ltm-"));
    const indexer = new Indexer(join(dataDir, "index.db"));
    const tm = new TaskManager({
      dataDir,
      store: new TaskStore(join(dataDir, "tasks")),
      indexer,
      bus: new EventBus(),
      persona: new PersonaStore(join(dataDir, "persona")),
      authStore: new PiAuthStore(join(dataDir, "no-auth.json")),
      resolveModel: () => faux.getModel() as any,
      subagentModel: "faux/faux",
      workerTools: [],
      concurrency: 2,
      timeoutMs: 10_000,
      notifyParent: async () => {},
      ltm: () => ltm,
    });
    faux.setResponses([
      fauxAssistantMessage("first attempt", {
        stopReason: "error",
        errorMessage: "transient provider error",
      }),
      fauxAssistantMessage("REPORT: recovered after retry"),
    ]);

    const row = await tm.delegate({
      parentSessionId: "parent-1",
      task: "compute with retry",
      label: "compute with retry",
    });
    await waitFor(() => indexer.getTask(row.id)?.status === "completed");

    await waitFor(() => ltm.ingestSessionFile.mock.calls.length === 1);
    expect(ltm.ingestSessionFile).toHaveBeenCalledTimes(1);

    const final = indexer.getTask(row.id)!;
    expect(final.subagentSessionId).toBeTruthy();
    const subagentDir = join(dataDir, "sessions", "--subagent--");
    const [sessionFile] = readdirSync(subagentDir).filter((name) =>
      name.includes(final.subagentSessionId!),
    );
    const expectedSessionPath = join(subagentDir, sessionFile!);

    expect(ltm.ingestSessionFile).toHaveBeenCalledWith(expectedSessionPath);
    expect(existsSync(expectedSessionPath)).toBe(true);
  });
});
