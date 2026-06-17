import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import { EventBus, type ServerEvent } from "../src/events.ts";
import { Indexer } from "../src/indexer.ts";
import { PersonaStore } from "../src/persona.ts";
import { PiAuthStore } from "../src/pi-auth.ts";
import { TaskStore } from "../src/tasks.ts";
import { TaskManager } from "../src/task-manager.ts";
import { fauxAssistantMessage, fauxToolCall, setupFaux } from "./helpers.ts";

let faux: ReturnType<typeof setupFaux>;
beforeEach(() => {
  faux = setupFaux();
});
afterEach(() => faux.unregister());

interface MadeTm {
  tm: TaskManager;
  store: TaskStore;
  indexer: Indexer;
  bus: EventBus;
  dataDir: string;
  notified: Array<{ sessionId: string; text: string }>;
}

function makeTaskManager(opts: { concurrency?: number; timeoutMs?: number } = {}): MadeTm {
  const dataDir = mkdtempSync(join(tmpdir(), "tm-"));
  const store = new TaskStore(join(dataDir, "tasks"));
  const indexer = new Indexer(join(dataDir, "index.db"));
  const bus = new EventBus();
  const notified: Array<{ sessionId: string; text: string }> = [];
  const tm = new TaskManager({
    dataDir,
    store,
    indexer,
    bus,
    persona: new PersonaStore(join(dataDir, "persona")),
    authStore: new PiAuthStore(join(dataDir, "no-auth.json")),
    resolveModel: () => faux.getModel() as any,
    subagentModel: "faux/faux",
    workerTools: [],
    concurrency: opts.concurrency ?? 2,
    timeoutMs: opts.timeoutMs ?? 10_000,
    notifyParent: async (sessionId, text) => {
      notified.push({ sessionId, text });
    },
  });
  return { tm, store, indexer, bus, dataDir, notified };
}

async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function makeReactiveCompactionFaux() {
  return registerFauxProvider({
    provider: "openai",
    models: [{ id: "faux", contextWindow: 40_000, maxTokens: 256 }],
  });
}

function withReactiveCompactionEnv(dataDir: string): () => void {
  const prevDataDir = process.env.YTSEJAM_DATA_DIR;
  const prevMemoryDir = process.env.YTSEJAM_MEMORY_DIR;
  const prevOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.YTSEJAM_DATA_DIR = dataDir;
  process.env.OPENAI_API_KEY = "test-key-for-faux-compaction";
  delete process.env.YTSEJAM_MEMORY_DIR;
  return () => {
    if (prevDataDir === undefined) delete process.env.YTSEJAM_DATA_DIR;
    else process.env.YTSEJAM_DATA_DIR = prevDataDir;
    if (prevMemoryDir === undefined) delete process.env.YTSEJAM_MEMORY_DIR;
    else process.env.YTSEJAM_MEMORY_DIR = prevMemoryDir;
    if (prevOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenAiKey;
  };
}

function readDevLog(dataDir: string): string {
  const path = join(dataDir, "memory", "projects", "ytsejam", "dev-log.md");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

describe("TaskManager", () => {
  test("delegate runs a subagent to completion and notifies the parent", async () => {
    const { tm, indexer, bus, dataDir, notified } = makeTaskManager();
    const events: ServerEvent[] = [];
    bus.subscribe((e) => events.push(e));
    faux.setResponses([fauxAssistantMessage("REPORT: the answer is 42")]);

    const row = await tm.delegate({ parentSessionId: "parent-1", task: "compute", label: "compute" });
    expect(row.status).toBe("pending");

    await waitFor(() => indexer.getTask(row.id)?.status === "completed");
    const final = indexer.getTask(row.id)!;
    expect(final.resultSummary).toContain("42");
    expect(final.subagentSessionId).toBeTruthy();

    // parent notified with the report
    expect(notified).toHaveLength(1);
    expect(notified[0]!.sessionId).toBe("parent-1");
    expect(notified[0]!.text).toContain('[Task "compute" completed]');
    expect(notified[0]!.text).toContain("42");

    // task status events flowed over the bus
    const statuses = events.filter((e) => e.type === "task").map((e: any) => e.task.status);
    expect(statuses).toContain("running");
    expect(statuses).toContain("completed");

    // subagent session JSONL exists under the subagent cwd (never the chat cwd)
    const subDirs = readdirSync(join(dataDir, "sessions"));
    expect(subDirs).toContain("--subagent--");
    expect(subDirs).not.toContain("--chat--");

    // transcript is readable
    const messages = await tm.getTranscript(row.id);
    expect(messages.some((m: any) => m.role === "assistant")).toBe(true);
  });

  test("delegate report joins all assistant text blocks", async () => {
    const { tm, indexer, notified } = makeTaskManager();
    faux.setResponses([
      fauxAssistantMessage([
        { type: "text", text: "REPORT: line one" },
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "line two" },
      ] as any),
    ]);

    const row = await tm.delegate({ parentSessionId: "parent-1", task: "report", label: "report" });

    await waitFor(() => indexer.getTask(row.id)?.status === "completed");
    expect(indexer.getTask(row.id)!.resultSummary).toBe("REPORT: line one\nline two");
    expect(notified[0]!.text).toContain("REPORT: line one\nline two");
  });

  test("concurrency cap queues excess tasks", async () => {
    const { tm, indexer } = makeTaskManager({ concurrency: 1 });
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    faux.setResponses([
      async () => {
        await gate;
        return fauxAssistantMessage("first done");
      },
      fauxAssistantMessage("second done"),
    ]);

    const a = await tm.delegate({ parentSessionId: "p", task: "a", label: "a" });
    const b = await tm.delegate({ parentSessionId: "p", task: "b", label: "b" });

    await waitFor(() => indexer.getTask(a.id)?.status === "running");
    expect(indexer.getTask(b.id)?.status).toBe("pending"); // capped

    releaseFirst();
    await waitFor(() => indexer.getTask(b.id)?.status === "completed");
    expect(indexer.getTask(a.id)?.status).toBe("completed");
  });

  test("timeout aborts the subagent and fails the task", async () => {
    const { tm, indexer, notified } = makeTaskManager({ timeoutMs: 150 });
    faux.setResponses([
      async () => {
        // must outlast timeoutMs but resolve well within waitFor's window:
        // if abort() doesn't interrupt the faux factory, prompt() only settles
        // when this resolves, and the failed event is recorded after that
        await new Promise((r) => setTimeout(r, 2_000));
        return fauxAssistantMessage("too late");
      },
    ]);
    const row = await tm.delegate({ parentSessionId: "p", task: "slow", label: "slow" });
    await waitFor(() => indexer.getTask(row.id)?.status === "failed", 8_000);
    expect(indexer.getTask(row.id)!.resultSummary).toContain("timed out");
    await waitFor(() => notified.length === 1);
    expect(notified[0]!.text).toContain('[Task "slow" failed]');
  });

  test("cancel works for pending and running tasks without notifying the parent", async () => {
    const { tm, indexer, notified } = makeTaskManager({ concurrency: 1 });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    faux.setResponses([
      async () => {
        await gate;
        return fauxAssistantMessage("never used");
      },
    ]);
    const running = await tm.delegate({ parentSessionId: "p", task: "a", label: "a" });
    const pending = await tm.delegate({ parentSessionId: "p", task: "b", label: "b" });
    await waitFor(() => indexer.getTask(running.id)?.status === "running");

    expect(await tm.cancel(pending.id)).toBe(true);
    expect(indexer.getTask(pending.id)?.status).toBe("cancelled");

    // cancel() records the cancellation synchronously, then awaits harness.abort();
    // abort() awaits the run promise, which only settles once the gate releases —
    // so release the gate, then await cancel's return to avoid a deadlock
    const cancelRunning = tm.cancel(running.id);
    release();
    expect(await cancelRunning).toBe(true);
    await waitFor(() => indexer.getTask(running.id)?.status === "cancelled");
    await new Promise((r) => setTimeout(r, 200)); // give any stray notify a chance to fire
    expect(notified).toEqual([]);
    expect(await tm.cancel(running.id)).toBe(false); // already terminal
  });

  test("retries once when the provider kills generation mid-stream", async () => {
    const { tm, indexer, notified } = makeTaskManager();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: "/tmp/report.md", content: "partial" })], {
        stopReason: "error",
        errorMessage: "An unknown error occurred",
      }),
      fauxAssistantMessage("REPORT: recovered after retry"),
    ]);

    const row = await tm.delegate({ parentSessionId: "p", task: "research", label: "research" });
    await waitFor(() => indexer.getTask(row.id)?.status === "completed");
    expect(indexer.getTask(row.id)!.resultSummary).toContain("recovered after retry");
    expect(notified).toHaveLength(1);
    expect(notified[0]!.text).toContain('[Task "research" completed]');

    const messages = (await tm.getTranscript(row.id)) as any[];
    // the dangling tool call from the cut-off response was answered with an error result
    const synthetic = messages.find((m) => m.role === "toolResult" && m.isError);
    expect(synthetic).toBeTruthy();
    expect(synthetic.toolName).toBe("write");
    // and the retry prompt told the model why and how to proceed
    const nudge = messages.find(
      (m) => m.role === "user" && JSON.stringify(m.content).toLowerCase().includes("cut off"),
    );
    expect(nudge).toBeTruthy();
  });

  test("fails the task when the retry errors too", async () => {
    const { tm, indexer, notified } = makeTaskManager();
    faux.setResponses([
      fauxAssistantMessage("first attempt", { stopReason: "error", errorMessage: "boom one" }),
      fauxAssistantMessage("second attempt", { stopReason: "error", errorMessage: "boom two" }),
    ]);

    const row = await tm.delegate({ parentSessionId: "p", task: "research", label: "research" });
    await waitFor(() => indexer.getTask(row.id)?.status === "failed");
    expect(indexer.getTask(row.id)!.resultSummary).toContain("boom two");
    expect(notified).toHaveLength(1);
    expect(notified[0]!.text).toContain('[Task "research" failed]');
  });


  test("runs reactive compaction + retry on subagent context overflow", async () => {
    faux.unregister();
    faux = makeReactiveCompactionFaux() as any;
    const { tm, indexer, dataDir, notified } = makeTaskManager();
    const restoreEnv = withReactiveCompactionEnv(dataDir);
    try {
      faux.setResponses([
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long: 50000 tokens > 40000 maximum" }),
        fauxAssistantMessage("Summary of compacted overflow attempt."),
        fauxAssistantMessage("REPORT: recovered after reactive compaction"),
      ]);

      const row = await tm.delegate({ parentSessionId: "p", task: "overflow", label: "overflow" });
      await waitFor(() => indexer.getTask(row.id)?.status === "completed");
      const final = indexer.getTask(row.id)!;
      expect(final.resultSummary).toContain("recovered after reactive compaction");
      expect(notified).toHaveLength(1);
      expect(notified[0]!.text).toContain('[Task "overflow" completed]');
      expect(notified[0]!.text).toContain("recovered after reactive compaction");

      const devLog = readDevLog(dataDir);
      expect(devLog).toContain("subagent task " + row.id);
      expect(devLog).toContain("— reactive,");
      expect(devLog).toContain("Trigger: isContextOverflow.");
    } finally {
      restoreEnv();
    }
  });

  test("surrenders subagent task when reactive retry also overflows", async () => {
    faux.unregister();
    faux = makeReactiveCompactionFaux() as any;
    const { tm, indexer, dataDir, notified } = makeTaskManager();
    const restoreEnv = withReactiveCompactionEnv(dataDir);
    try {
      faux.setResponses([
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long: 50000 tokens > 40000 maximum" }),
        fauxAssistantMessage("Summary of compacted overflow attempt."),
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long: 50001 tokens > 40000 maximum" }),
      ]);

      const row = await tm.delegate({ parentSessionId: "p", task: "overflow twice", label: "overflow twice" });
      await waitFor(() => indexer.getTask(row.id)?.status === "failed");
      const final = indexer.getTask(row.id)!;
      expect(final.resultSummary).toContain("Diagnostic: prompt was ~");
      expect(final.resultSummary).toContain("tokens against contextWindow 40,000");
      expect(notified).toHaveLength(1);
      expect(notified[0]!.text).toContain('[Task "overflow twice" failed]');

      const devLog = readDevLog(dataDir);
      expect(devLog).toContain("subagent task " + row.id);
      expect(devLog).toContain("— reactive,");
    } finally {
      restoreEnv();
    }
  });

  test("recoverInterrupted marks stale running tasks and notifies parents", async () => {
    const { tm, store, indexer, notified } = makeTaskManager();
    // simulate a crash: events from a previous process, no live runner
    store.append({
      type: "created",
      taskId: "stale-1",
      parentSessionId: "p9",
      label: "stale",
      task: "x",
      model: "faux/faux",
      timestamp: new Date().toISOString(),
    });
    store.append({
      type: "started",
      taskId: "stale-1",
      subagentSessionId: "s9",
      timestamp: new Date().toISOString(),
    });
    await tm.recoverInterrupted();
    expect(indexer.getTask("stale-1")?.status).toBe("interrupted");
    expect(notified).toHaveLength(1);
    expect(notified[0]!).toMatchObject({ sessionId: "p9" });
    expect(notified[0]!.text).toContain("interrupted");
  });

  test("rebuildIndex repopulates the tasks table from JSONL", async () => {
    const { tm, store, indexer } = makeTaskManager();
    store.append({
      type: "created",
      taskId: "r1",
      parentSessionId: "p",
      label: "done already",
      task: "x",
      model: "faux/faux",
      timestamp: "2026-06-09T10:00:00Z",
    });
    store.append({ type: "completed", taskId: "r1", report: "fin", timestamp: "2026-06-09T10:01:00Z" });
    indexer.reset();
    await tm.rebuildIndex();
    expect(indexer.getTask("r1")).toMatchObject({ status: "completed", resultSummary: "fin" });
  });
});
