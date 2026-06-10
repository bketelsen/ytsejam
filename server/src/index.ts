import fs from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { EventBus } from "./events.ts";
import { Indexer } from "./indexer.ts";
import { AgentManager } from "./manager.ts";
import { resolveModel } from "./models.ts";
import { PiAuthStore } from "./pi-auth.ts";
import { PersonaStore } from "./persona.ts";
import { SchedulerService } from "./scheduler.ts";
import { ScheduleStore } from "./schedules.ts";
import { createApp } from "./server.ts";
import { TaskManager } from "./task-manager.ts";
import { TaskStore } from "./tasks.ts";
import { createTools } from "./tools/index.ts";
import { createDelegationTools } from "./tools/delegation.ts";
import { createSchedulingTools } from "./tools/scheduling.ts";

const config = loadConfig();

// Ensure dataDir exists before sqlite tries to create its file
fs.mkdirSync(config.dataDir, { recursive: true });

const authStore = new PiAuthStore(config.piAuthPath);
const indexer = new Indexer(path.join(config.dataDir, "index.db"));
const bus = new EventBus();
const persona = new PersonaStore(path.join(config.dataDir, "persona"));
// taskManager and scheduler are created after manager (they inject into it);
// the tools late-bind through closures, which only run when a session opens
let taskManager!: TaskManager;
let scheduler!: SchedulerService;
const manager = new AgentManager({
  dataDir: config.dataDir,
  indexer,
  bus,
  persona,
  resolveModel: (ref) => resolveModel(ref, authStore),
  defaultModel: config.defaultModel,
  tools: createTools(config.dataDir),
  sessionTools: (sessionId) => [
    ...createDelegationTools(() => taskManager, sessionId),
    ...createSchedulingTools(() => scheduler, sessionId),
  ],
  generateTitles: config.generateTitles,
  authStore,
});

taskManager = new TaskManager({
  dataDir: config.dataDir,
  store: new TaskStore(path.join(config.dataDir, "tasks")),
  indexer,
  bus,
  persona,
  authStore,
  resolveModel: (ref) => resolveModel(ref, authStore),
  subagentModel: config.subagentModel,
  workerTools: createTools(config.dataDir), // web + system tools; no delegation (no recursion)
  concurrency: config.taskConcurrency,
  timeoutMs: config.taskTimeoutMinutes * 60_000,
  notifyParent: (sessionId, text) => manager.injectMessage(sessionId, text),
});

scheduler = new SchedulerService({
  store: new ScheduleStore(path.join(config.dataDir, "schedules")),
  indexer,
  bus,
  inject: (sessionId, text) => manager.injectMessage(sessionId, text),
  createTargetSession: async (label) => {
    const row = await manager.createSession();
    await manager.rename(row.id, label);
    return row.id;
  },
});

// sqlite is derived: rebuild from JSONL on boot so offline JSONL edits are reflected
await manager.rebuildIndex();
await taskManager.rebuildIndex();
await taskManager.recoverInterrupted();
await scheduler.rebuildIndex();
await scheduler.catchUp();
scheduler.start();

const { app, injectWebSocket } = createApp({ manager, taskManager, scheduler, indexer, bus, persona, config, authStore });
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`ytsejam listening on http://localhost:${info.port}`);
  console.log(`data dir: ${config.dataDir}`);
});
injectWebSocket(server);
