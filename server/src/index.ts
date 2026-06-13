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
import { MemorySystem } from "ltm";
import * as memory from "./memory/index.ts";
import { LtmReconciler } from "./memory/bridge/ltm-reconciler.ts";
import { runCli } from "./cli/dispatch.ts";

// CLI short-circuit: if argv matches a CLI subcommand, run it and exit
// without booting the server. Returns null when argv doesn't match -- in
// which case we fall through to normal server boot.
const cliExit = await runCli(process.argv.slice(2));
if (cliExit !== null) process.exit(cliExit);

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

// LTM bridge: open store, construct reconciler, attach, start.
// Failures here must NOT block boot -- LTM is best-effort; the bridge is a
// safety net, not load-bearing. We catch + warn and continue with cog-only.
let ltm: MemorySystem | null = null;
let reconciler: LtmReconciler | null = null;
try {
  // `||` (not `??`) so LTM_STORE_DIR="" coerces to the default rather than
  // attempting MemorySystem.open({storeDir: ""}). Empty-string env is almost
  // certainly user misconfiguration, not an intentional override.
  const ltmStoreDir =
    process.env.LTM_STORE_DIR || path.join(config.dataDir, "ltm");
  ltm = MemorySystem.open({ storeDir: ltmStoreDir });
  const intervalEnv = Number(process.env.LTM_RECONCILE_INTERVAL_MS);
  const ctorOpts: ConstructorParameters<typeof LtmReconciler>[0] = {
    ltm,
    dataDir: config.dataDir,
  };
  if (Number.isFinite(intervalEnv) && intervalEnv > 0) {
    ctorOpts.intervalMs = intervalEnv;
  }
  reconciler = new LtmReconciler(ctorOpts);
  memory.attachLtm(ltm);
  memory.attachReconciler(reconciler);
  reconciler.start();
  console.log(`[memory] LTM bridge attached, store=${ltmStoreDir}`);
} catch (err) {
  console.warn(
    `[memory] LTM bridge init failed (continuing cog-only): ${(err as Error).message}`,
  );
  // Partial-init guard: MemorySystem.open() acquires a file lock and
  // registers in a process-static openDirs set inside its constructor.
  // If anything AFTER a successful open() throws (today only the reconciler
  // ctor + two assignments, but the surface is one PR change away from
  // doing real work), we leak the lock + openDirs entry for the process
  // lifetime AND any future open() of the same dir will throw. Close the
  // partial-init LTM here so the leak window stays closed.
  if (ltm) {
    try {
      ltm.close();
    } catch {
      // already-failed init -- swallow close errors, the warn above is the
      // operator-facing signal.
    }
  }
  ltm = null;
  reconciler = null;
}

// LTM bridge shutdown: drain the reconciler, detach, close the LTM store.
// Use once() so duplicate signals don't re-run. Does NOT call process.exit
// -- let the process exit naturally once all handles drain.
const shutdownLtm = async (signal: string): Promise<void> => {
  if (!reconciler && !ltm) return;
  console.log(`[memory] ${signal} received, draining LTM bridge`);
  try {
    if (reconciler) await reconciler.stop();
  } catch (err) {
    console.warn(
      `[memory] reconciler.stop() error: ${(err as Error).message}`,
    );
  }
  memory.attachReconciler(null);
  memory.attachLtm(null);
  try {
    if (ltm) ltm.close();
  } catch (err) {
    console.warn(
      `[memory] ltm.close() error: ${(err as Error).message}`,
    );
  }
  reconciler = null;
  ltm = null;
};
process.once("SIGTERM", () => void shutdownLtm("SIGTERM"));
process.once("SIGINT", () => void shutdownLtm("SIGINT"));

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
