import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type Model } from "@earendil-works/pi-ai";
import { EventBus } from "../src/events.ts";
import { Indexer } from "../src/indexer.ts";
import { AgentManager } from "../src/manager.ts";
import type { AgentManagerOptions } from "../src/manager.ts";
import { PiAuthStore } from "../src/pi-auth.ts";
import { PersonaStore } from "../src/persona.ts";
import { SchedulerService } from "../src/scheduler.ts";
import { ScheduleStore } from "../src/schedules.ts";
import { TaskStore } from "../src/tasks.ts";
import { TaskManager } from "../src/task-manager.ts";

export function setupFaux() {
  const faux = registerFauxProvider();
  return faux;
}

export function makeManager(
  faux: ReturnType<typeof registerFauxProvider>,
  overrides: Partial<AgentManagerOptions> = {},
) {
  // Honor a caller-supplied dataDir so tests can pre-create state (e.g. a
  // workdir store) under it; otherwise allocate a fresh tmp dir.
  const dataDir = overrides.dataDir ?? mkdtempSync(join(tmpdir(), "ytsejam-"));
  const indexer = new Indexer(join(dataDir, "index.db"));
  const bus = new EventBus();
  const fauxModel = faux.getModel() as Model<any>;
  const manager = new AgentManager({
    dataDir,
    indexer,
    bus,
    persona: new PersonaStore(join(dataDir, "persona")),
    resolveModel: () => fauxModel,
    defaultModel: "faux/faux",
    tools: [],
    generateTitles: false,
    authStore: new PiAuthStore(join(dataDir, "no-auth.json")),
    ...overrides,
  });
  const taskManager = new TaskManager({
    dataDir,
    store: new TaskStore(join(dataDir, "tasks")),
    indexer,
    bus,
    persona: new PersonaStore(join(dataDir, "persona")),
    authStore: new PiAuthStore(join(dataDir, "no-auth.json")),
    resolveModel: () => fauxModel,
    subagentModel: "faux/faux",
    workerTools: [],
    concurrency: 2,
    timeoutMs: 10_000,
    notifyParent: (sessionId, text) => manager.injectMessage(sessionId, text),
  });
  const scheduler = new SchedulerService({
    store: new ScheduleStore(join(dataDir, "schedules")),
    indexer,
    bus,
    inject: (sessionId, text) => manager.injectMessage(sessionId, text),
    createTargetSession: async (label) => {
      const row = await manager.createSession();
      await manager.rename(row.id, label);
      return row.id;
    },
  });
  return { manager, taskManager, scheduler, indexer, bus, dataDir };
}

export { fauxAssistantMessage, fauxToolCall };

/**
 * Poll `predicate` until it returns true or `ms` elapses. Used by event-bus
 * tests to wait for async work to settle without sleeping a fixed duration.
 */
export async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Register a faux provider whose model has the small context window and
 * maxTokens used by the reactive-compaction tests. The narrow window is what
 * triggers the overflow → compaction path.
 */
export function makeReactiveCompactionFaux(): ReturnType<typeof registerFauxProvider> {
  return registerFauxProvider({
    provider: "openai",
    models: [{ id: "faux", contextWindow: 40_000, maxTokens: 256 }],
  });
}

/**
 * Stash + override the process.env that the reactive-compaction path reads
 * (data dir, memory dir, OpenAI key); returns a restore function that the
 * test's `finally` should call. The OPENAI_API_KEY value is a sentinel —
 * the faux provider doesn't actually call OpenAI, but the code path checks
 * for presence.
 */
export function withReactiveCompactionEnv(dataDir: string): () => void {
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
