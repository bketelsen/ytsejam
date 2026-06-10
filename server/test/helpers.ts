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
  const dataDir = mkdtempSync(join(tmpdir(), "ytsejam-"));
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
