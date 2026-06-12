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
import { createGlobalTools } from "./tools/index.ts";
import { createDelegationTools } from "./tools/delegation.ts";
import { createSchedulingTools } from "./tools/scheduling.ts";
import { CogBriefProvider } from "./cog/brief.ts";
import { SkillsStore } from "./skills.ts";
import { createCogTools } from "./tools/cog.ts";
import { createSkillTool } from "./tools/skills.ts";
import { WorkdirStore, resolveWorkdir } from "./workdirs.ts";
import { ArchiveStore } from "./archive-store.ts";
import { loadContextFiles } from "./context-files.ts";
import * as memory from "./memory/index.ts";

const config = loadConfig();

// Ensure dataDir exists before sqlite tries to create its file
fs.mkdirSync(config.dataDir, { recursive: true });

const authStore = new PiAuthStore(config.piAuthPath);
const indexer = new Indexer(path.join(config.dataDir, "index.db"));
const bus = new EventBus();
const persona = new PersonaStore(path.join(config.dataDir, "persona"));
const cogBrief = new CogBriefProvider();
const skills = new SkillsStore(path.join(config.dataDir, "skills"));
const workdirs = new WorkdirStore(path.join(config.dataDir, "workdirs"));
const archiveStore = new ArchiveStore(path.join(config.dataDir, "archived"));
try {
  await skills.seed(path.join(import.meta.dirname, "../skills"));
} catch (err) {
  // skills are optional, like memory — never block boot on seeding
  console.warn(`skill seeding failed: ${(err as Error).message}`);
}
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
  tools: [
    ...createGlobalTools(),
    ...createCogTools(),
    createSkillTool(skills),
  ],
  sessionTools: (sessionId) => [
    ...createDelegationTools(() => taskManager, sessionId),
    ...createSchedulingTools(() => scheduler, sessionId),
  ],
  resolveWorkdir: (sessionId) => resolveWorkdir(workdirs, sessionId, config.dataDir),
  isArchived: (sessionId) => archiveStore.isArchived(sessionId),
  markArchived: (sessionId, archived) =>
    archiveStore.append(sessionId, { archived, timestamp: new Date().toISOString() }),
  loadContextFiles: (cwd) => loadContextFiles(cwd, { disabled: !config.contextFiles }),
  generateTitles: config.generateTitles,
  authStore,
  cogBrief,
  skills,
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
  // worker tools are built per task in task-manager.ts so the bash/file
  // tools resolve against the parent session's working dir; pass only the
  // cwd-independent (global) tools here
  workerTools: createGlobalTools(),
  resolveParentWorkdir: (parentSessionId) =>
    resolveWorkdir(workdirs, parentSessionId, config.dataDir),
  loadContextFiles: (cwd) => loadContextFiles(cwd, { disabled: !config.contextFiles }),
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

try {
  const h = await memory.health();
  console.log(`memory root: ${memory.memoryRoot()}, ${h.files ?? 0} files, last commit ${h.last_commit || "(none)"}`);
} catch (err) {
  console.warn(`memory health check failed: ${(err as Error).message} — memory disabled until it recovers`);
}

const { app, injectWebSocket } = createApp({ manager, taskManager, scheduler, indexer, bus, persona, config, authStore, workdirs });
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  const allInterfaces = info.address === "0.0.0.0" || info.address === "::";
  const displayHost = allInterfaces ? "<all interfaces>" : info.address;
  console.log(`ytsejam listening on http://${displayHost}:${info.port}`);
  console.log(`data dir: ${config.dataDir}`);
  if (allInterfaces) {
    console.warn("ytsejam: listening on all interfaces — ensure a reverse proxy and auth review are in place before exposing to a network");
  }
});
injectWebSocket(server);
