import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { EventBus } from "../src/events.ts";
import { Indexer } from "../src/indexer.ts";
import { PersonaStore } from "../src/persona.ts";
import { PiAuthStore } from "../src/pi-auth.ts";
import { TaskStore } from "../src/tasks.ts";
import { TaskManager } from "../src/task-manager.ts";
import { composeWorkerPrompt } from "../src/persona.ts";
import { fauxAssistantMessage, fauxToolCall, setupFaux } from "./helpers.ts";

let faux: ReturnType<typeof setupFaux>;
beforeEach(() => {
  faux = setupFaux();
});
afterEach(() => faux.unregister());

async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("subagent workdir inheritance", () => {
  test(
    "a subagent dispatched from a session with a custom workdir has its bash tool resolve there",
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "tm-wd-"));
      const parentDir = mkdtempSync(join(tmpdir(), "tm-parent-"));
      const otherDir = mkdtempSync(join(tmpdir(), "tm-other-"));

      // resolveParentWorkdir returns one dir for parent A, a different one for parent B
      const workdirByParent: Record<string, string> = {
        "parent-A": parentDir,
        "parent-B": otherDir,
      };

      const store = new TaskStore(join(dataDir, "tasks"));
      const indexer = new Indexer(join(dataDir, "index.db"));
      const bus = new EventBus();
      const notified: Array<{ sessionId: string; text: string }> = [];

      // Build a minimal TaskManager with the worker tools we need to inspect
      // the bash cwd via the faux model issuing a `bash pwd` call.
      const { createBashTool } = await import("../src/tools/shell.ts");
      // The TaskManager appends per-task cwd tools, so workerTools is the
      // cwd-INDEPENDENT slot in production. To keep this test focused on the
      // inheritance path, we pass an empty workerTools and rely on the
      // per-task cwd-tools build inside TaskManager.run().
      const tm = new TaskManager({
        dataDir,
        store,
        indexer,
        bus,
        persona: new PersonaStore(join(dataDir, "persona")),
        authStore: new PiAuthStore(join(dataDir, "no-auth.json")),
        resolveModel: () => faux.getModel() as any,
        subagentModel: "faux/faux",
        workerTools: [], // cwd tools come from per-task build
        resolveParentWorkdir: (id) => workdirByParent[id] ?? dataDir,
        concurrency: 2,
        timeoutMs: 10_000,
        notifyParent: async (sessionId, text) => {
          notified.push({ sessionId, text });
        },
      });

      faux.setResponses([
        // task from parent-A: bash pwd then a final "REPORT"
        fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })]),
        fauxAssistantMessage("REPORT-A"),
        // task from parent-B: bash pwd then "REPORT"
        fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })]),
        fauxAssistantMessage("REPORT-B"),
      ]);

      const a = await tm.delegate({ parentSessionId: "parent-A", task: "T", label: "TA" });
      await waitFor(() => indexer.getTask(a.id)?.status === "completed", 10_000);
      const msgsA = await tm.getTranscript(a.id);
      const trA = msgsA.find((m: any) => m.role === "toolResult") as any;
      expect(JSON.stringify(trA?.content)).toContain(parentDir);
      expect(JSON.stringify(trA?.content)).not.toContain(otherDir);

      const b = await tm.delegate({ parentSessionId: "parent-B", task: "T", label: "TB" });
      await waitFor(() => indexer.getTask(b.id)?.status === "completed", 10_000);
      const msgsB = await tm.getTranscript(b.id);
      const trB = msgsB.find((m: any) => m.role === "toolResult") as any;
      expect(JSON.stringify(trB?.content)).toContain(otherDir);
      expect(JSON.stringify(trB?.content)).not.toContain(parentDir);
    },
  );

  test("composeWorkerPrompt surfaces the resolved workdir when provided", () => {
    const p = composeWorkerPrompt("You are Jeeves.", {
      dataDir: "/data",
      workdir: "/projects/cogmemory",
      now: new Date("2026-06-11T00:00:00Z"),
    });
    expect(p).toContain("/projects/cogmemory");
    // dataDir is no longer the path mentioned in the env note when workdir is given
    expect(p).not.toContain("under /data unless");
  });

  test("composeWorkerPrompt falls back to dataDir when no workdir is supplied", () => {
    const p = composeWorkerPrompt("You are Jeeves.", {
      dataDir: "/data",
      now: new Date("2026-06-11T00:00:00Z"),
    });
    expect(p).toContain("/data");
  });
});
