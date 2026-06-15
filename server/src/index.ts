import fs from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { EventBus } from "./events.ts";
import { Indexer } from "./indexer.ts";
import { AgentManager } from "./manager.ts";
import { loadLiveCopilotModels } from "./copilot-live-catalog.ts";
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
import { ApprovalCoordinator } from "./approval/coordinator.ts";
import { loadContextFiles } from "./context-files.ts";
import { MemorySystem } from "ltm";
import * as memory from "./memory/index.ts";
import { LtmReconciler } from "./memory/bridge/ltm-reconciler.ts";
import { checkDimensionMismatch, createLtmEmbedder, parseLtmEmbedderMode } from "./memory/embedder.ts";
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
const liveCopilotCatalog = await loadLiveCopilotModels(authStore);
const indexer = new Indexer(path.join(config.dataDir, "index.db"));
const bus = new EventBus();
const approvalCoordinator = new ApprovalCoordinator({
  timeoutMs: 5 * 60 * 1000,
  onRequest: (req) => {
    bus.emit({
      type: "approval_request",
      approvalId: req.approvalId,
      createdAt: req.createdAt,
      sessionId: req.sessionId,
      toolName: req.toolName,
      toolLabel: req.toolLabel,
      params: req.params,
    });
  },
  onResolved: (approvalId, decision) => {
    bus.emit({ type: "approval_resolved", approvalId, decision });
  },
});
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
  resolveModel: (ref) => resolveModel(ref, authStore, liveCopilotCatalog),
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
  approvalCoordinator,
});

taskManager = new TaskManager({
  dataDir: config.dataDir,
  store: new TaskStore(path.join(config.dataDir, "tasks")),
  indexer,
  bus,
  persona,
  authStore,
  resolveModel: (ref) => resolveModel(ref, authStore, liveCopilotCatalog),
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
  const mode = parseLtmEmbedderMode(process.env.YTSEJAM_LTM_EMBEDDER);
  const embedderResult = await createLtmEmbedder(authStore, {
    mode,
    cacheDir: path.join(ltmStoreDir, "embed-cache"),
    copilot: {
      model: process.env.YTSEJAM_LTM_COPILOT_MODEL,
      baseUrl: process.env.YTSEJAM_LTM_COPILOT_URL,
    },
    ollama: {
      model: process.env.YTSEJAM_LTM_OLLAMA_MODEL,
      baseUrl: process.env.YTSEJAM_LTM_OLLAMA_URL,
    },
  });
  ltm = MemorySystem.open({ storeDir: ltmStoreDir, embedder: embedderResult.embedder });
  const mismatch = checkDimensionMismatch(ltm.indexDimension(), embedderResult);
  if (mismatch) {
    throw new Error(mismatch);
  }
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
  console.log(`[memory] LTM bridge attached, store=${ltmStoreDir}, embedder=${embedderResult.label}`);
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
/**
 * Graceful shutdown orchestrator. Runs the 7-step drain when SIGTERM
 * or SIGINT arrives. Wired via process.once so a duplicate signal
 * (or a stuck step) does not re-enter — the second signal will fall
 * through to systemd's SIGKILL after TimeoutStopSec (45s).
 *
 * Each step is wrapped in try/catch and logs failure to the [shutdown]
 * prefix; we never bail mid-drain because one subsystem misbehaving
 * should not strand the others. Does NOT call process.exit -- once all
 * handles release, Node's event loop empties and the process exits
 * naturally (same idiom as shutdownLtm).
 *
 * IMPORTANT: taskManager.cancelAll() resolves once cancellations are
 * durably recorded + harness.abort() fire-and-forget calls are
 * INITIATED, not once subagent harnesses fully quiesce. A wedged tool
 * can hold the underlying harness.abort() for minutes. The cancel-wins
 * JSONL guard in TaskManager + recoverInterrupted on next boot make
 * that eventual settlement a harmless no-op. Do NOT block the drain
 * waiting for full harness quiescence. (See Task 2 quality review Q6.)
 */
let draining = false;
const drainAndExit = async (signal: string): Promise<void> => {
  if (draining) return; // belt-and-suspenders; process.once already guards
  draining = true;
  console.log(`[shutdown] ${signal} received, draining`);

  // Step 1: close every attached WebSocket with code 1001 (going away).
  // wss.clients is ws.WebSocketServer's standard Set<WebSocket>.
  //
  // CRITICAL: this MUST run before step 2 (server.close). Node's
  // http.Server.close(cb) waits for ALL open connections, including
  // upgraded WebSockets, to close before firing the callback. If we
  // awaited server.close first, the callback would never fire on a
  // browser with a live /api/ws connection -- the drain would stall
  // until systemd's TimeoutStopSec=45 SIGKILL, re-introducing the
  // exact hang #210 fixes. Tell clients to go first, then await the
  // HTTP server's natural quiesce. (See nodejs/node#53536 and the
  // Task 4 quality review for the empirical proof.)
  for (const ws of wss.clients) {
    try {
      ws.close(1001, "server shutting down");
    } catch (err) {
      console.warn(`[shutdown] ws.close: ${(err as Error).message}`);
    }
  }

  // Step 2: stop accepting new HTTP connections + wait for in-flight to finish.
  // server.close(cb) stops listening immediately and the cb fires once all
  // currently-open connections (including the WS sockets we just told to close
  // above) have closed. Wrap in a Promise.
  try {
    await new Promise<void>((resolve) => {
      server.close((err) => {
        if (err) console.warn(`[shutdown] server.close: ${err.message}`);
        resolve();
      });
    });
  } catch (err) {
    console.warn(`[shutdown] server.close threw: ${(err as Error).message}`);
  }

  // Step 3: abort all in-flight subagent sessions.
  try {
    await manager.abortAll();
  } catch (err) {
    console.warn(`[shutdown] manager.abortAll: ${(err as Error).message}`);
  }

  // Step 4: cancel all in-flight tasks (durably records "cancelled" and
  // initiates harness.abort() fire-and-forget; see header docstring).
  try {
    await taskManager.cancelAll();
  } catch (err) {
    console.warn(`[shutdown] taskManager.cancelAll: ${(err as Error).message}`);
  }

  // Step 5: stop the scheduler's polling timer.
  try {
    scheduler.stop();
  } catch (err) {
    console.warn(`[shutdown] scheduler.stop: ${(err as Error).message}`);
  }

  // Step 6: drain the LTM bridge (reconciler + memory store).
  try {
    await shutdownLtm(signal);
  } catch (err) {
    console.warn(`[shutdown] shutdownLtm: ${(err as Error).message}`);
  }

  // Step 7: close the indexer's sqlite handle + stop its checkpoint timer.
  try {
    indexer.close();
  } catch (err) {
    console.warn(`[shutdown] indexer.close: ${(err as Error).message}`);
  }

  console.log(`[shutdown] drain complete, awaiting handle release`);
  // Intentionally no process.exit; same idiom as shutdownLtm.
};

try {
  const h = await memory.health();
  console.log(`memory root: ${memory.memoryRoot()}, ${h.files ?? 0} files, last commit ${h.last_commit || "(none)"}`);
} catch (err) {
  console.warn(`memory health check failed: ${(err as Error).message} — memory disabled until it recovers`);
}

const { app, injectWebSocket, wss } = createApp({ manager, taskManager, scheduler, indexer, bus, persona, config, authStore, workdirs, skills, approvalCoordinator });
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

// Register shutdown handlers AFTER server + wss exist. drainAndExit closes
// over these `const` bindings; registering above would TDZ-throw if a signal
// arrived during the await memory.health() window that sits between
// drainAndExit's definition and server/wss initialization. Both step 1's WS
// close and step 2's server.close would ReferenceError, leaving HTTP/WS
// undrained even though steps 3-7 ran. Registering here closes that window.
process.once("SIGTERM", () => void drainAndExit("SIGTERM"));
process.once("SIGINT", () => void drainAndExit("SIGINT"));
