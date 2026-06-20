/**
 * ytsejam server entrypoint.
 * Short-circuits matching CLI argv; otherwise loads config/data dirs, wires stores,
 * tools, managers, and scheduler, rebuilds derived index state, attaches the
 * best-effort LTM bridge, starts Hono HTTP + WebSocket on the configured host/port,
 * and registers SIGTERM/SIGINT graceful-shutdown drain handlers.
 */
import fs from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { EventBus } from "./events.ts";
import { Indexer } from "./indexer.ts";
import { AgentManager } from "./manager.ts";
import { loadLiveCopilotModels } from "./copilot-live-catalog.ts";
import { resolveModel } from "./models.ts";
import { PiAuthStore, resolveApiKey } from "./pi-auth.ts";
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
import { CopilotFactExtractor } from "./memory/fact-extractor.ts";
import { buildMemorySection } from "./memory/memory-section.ts";
import { recall } from "./memory/recall.ts";
import { projectTagForWorkdir } from "./memory/active-project.ts";
import { loadManifest } from "./memory/domain/manifest.ts";
import { memoryRoot } from "./memory/index.ts";
import { runCli } from "./cli/dispatch.ts";
import crypto from "node:crypto";
import { DreamScheduler } from "./memory/dream/scheduler.ts";
import { ProposalStore } from "./memory/dream/proposal-store.ts";
import { runDreamJob } from "./memory/dream/dream-job.ts";
import { makeGatherUserTurns } from "./memory/dream/sessions-reader.ts";
import { createDreamTools } from "./memory/dream/tools.ts";

// CLI short-circuit: if argv matches a CLI subcommand, run it and exit
// without booting the server. Returns null when argv doesn't match -- in
// which case we fall through to normal server boot.
const cliExit = await runCli(process.argv.slice(2));
if (cliExit !== null) process.exit(cliExit);

const config = loadConfig();

// Loaded once at boot; restart to pick up domains.yml changes (it's config, like the rest).
const domainManifest = (() => {
  try { return loadManifest(memoryRoot()); } catch { return []; }
})();

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

// Dream job: declared here (before manager) so sessionTools closure can capture them.
// proposalStore and maintenanceSessionId don't depend on LTM; they're safe to create early.
let maintenanceSessionId: string | null = null;
let dreamScheduler: DreamScheduler | null = null;
const proposalStore = new ProposalStore(path.join(process.env.LTM_STORE_DIR || path.join(config.dataDir, "ltm"), "dream"));
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
  sessionTools: (sessionId) => {
    const dreamTools = (() => {
      const l = memory.getLtm();
      return l
        ? createDreamTools({ apply: { ltm: l, store: proposalStore, now: () => new Date().toISOString() }, maintenanceSessionId: () => maintenanceSessionId }, sessionId)
        : [];
    })();
    return [
      ...createDelegationTools(() => taskManager, sessionId),
      ...createSchedulingTools(() => scheduler, sessionId),
      ...dreamTools,
    ];
  },
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
  ltm: () => memory.getLtm(),
  activeProjectTag: (sessionId) =>
    projectTagForWorkdir(
      domainManifest,
      resolveWorkdir(workdirs, sessionId, config.dataDir),
    ),
  recallSection: async (sessionId, query) => {
    const ltm = memory.getLtm();
    const domains = domainManifest;
    const workdir = resolveWorkdir(workdirs, sessionId, config.dataDir);
    return buildMemorySection(
      {
        profile: () => ltm?.profile(undefined, projectTagForWorkdir(domains, workdir) ?? undefined),
        recall,
        activeProjectTag: () => projectTagForWorkdir(domains, workdir),
      },
      sessionId,
      query,
    );
  },
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
  ltm: () => memory.getLtm(),
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
// safety net, not load-bearing. attachLtmBridge() catches + warns and leaves
// the process in cog-only mode; a supervisor then retries with backoff so a
// transient boot-time outage (e.g. the Copilot embedding endpoint briefly
// unresolvable) self-heals instead of stranding recall off until a manual
// restart.
let ltm: MemorySystem | null = null;
let reconciler: LtmReconciler | null = null;
let ltmReconnectTimer: NodeJS.Timeout | null = null;
let ltmAttachAttempts = 0;
// Log the down-state warning only on a transition (first failure, and again
// after a recovery), not once per retry tick -- the per-tick spam is exactly
// what the old single-shot init left in the journal.
let ltmWarnedDown = false;

async function attachLtmBridge(): Promise<boolean> {
  if (memory.getLtm()) return true; // already attached -- idempotent
  let opened: MemorySystem | null = null;
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
    const factExtractor = new CopilotFactExtractor({
      getApiKey: () => resolveApiKey("github-copilot", authStore),
      model: process.env.YTSEJAM_LTM_FACT_MODEL,
      debug: process.env.YTSEJAM_LTM_FACT_DEBUG === "1",
    });
    opened = MemorySystem.open({ storeDir: ltmStoreDir, embedder: embedderResult.embedder, factExtractor });
    // Gate against the MAJORITY (primary) stored dimension, not a single sampled
    // record: a lone off-dimension contaminant at the head of the log must not
    // make the gate compare against the wrong dimension (which can both let a
    // mismatched embedder through and disable LTM under the correct one).
    const dimReport = opened.dimensionReport();
    const mismatch = checkDimensionMismatch(dimReport.primary, embedderResult);
    if (mismatch) {
      throw new Error(mismatch);
    }
    // Surface D2 contamination loudly: if the store holds embeddings of more
    // than one dimension, the minority buckets are excluded from retrieval
    // (VectorIndex refuses off-dimension vectors) and need re-embedding.
    const dimBuckets = Object.keys(dimReport.counts).length;
    if (dimBuckets > 1) {
      const breakdown = Object.entries(dimReport.counts)
        .sort((a, b) => b[1] - a[1])
        .map(([d, n]) => `${d}-dim×${n}`)
        .join(", ");
      console.warn(
        `[memory] LTM store holds mixed embedding dimensions (${breakdown}); ` +
          `primary=${dimReport.primary}. Off-primary records are EXCLUDED from retrieval. ` +
          `Re-embed with \`ltm replay --rebuild\` under YTSEJAM_LTM_EMBEDDER=copilot to reclaim them.`,
      );
    }
    const intervalEnv = Number(process.env.LTM_RECONCILE_INTERVAL_MS);
    const ctorOpts: ConstructorParameters<typeof LtmReconciler>[0] = {
      ltm: opened,
      dataDir: config.dataDir,
    };
    if (Number.isFinite(intervalEnv) && intervalEnv > 0) {
      ctorOpts.intervalMs = intervalEnv;
    }
    reconciler = new LtmReconciler(ctorOpts);
    memory.attachLtm(opened);
    memory.attachReconciler(reconciler);
    reconciler.start();
    ltm = opened;
    void reconciler.whenFirstTickSettled().then(() => {
      const orphanCount = reconciler?.health().orphans?.observations ?? 0;
      if (orphanCount > 0) {
        console.warn(
          `[memory] LTM bridge: ${orphanCount} orphan observation(s) detected ` +
            "(run `ltm replay --rebuild --prune` to clean)",
        );
      }
    });
    const suffix = ltmAttachAttempts > 0 ? ` (after ${ltmAttachAttempts} retr${ltmAttachAttempts === 1 ? "y" : "ies"})` : "";
    console.log(`[memory] LTM bridge attached, store=${ltmStoreDir}, embedder=${embedderResult.label}${suffix}`);
    ltmWarnedDown = false;
    return true;
  } catch (err) {
    // Partial-init guard: MemorySystem.open() acquires a file lock and
    // registers in a process-static openDirs set inside its constructor.
    // If anything AFTER a successful open() throws, we leak the lock +
    // openDirs entry for the process lifetime AND any future open() of the
    // same dir will throw. Close the partial-init LTM here so the leak
    // window stays closed and the next retry can re-open cleanly.
    if (opened) {
      try {
        opened.close();
      } catch {
        // already-failed init -- swallow close errors, the warn below is the
        // operator-facing signal.
      }
    }
    ltm = null;
    reconciler = null;
    if (!ltmWarnedDown) {
      ltmWarnedDown = true;
      console.warn(
        `[memory] LTM bridge init failed (continuing cog-only, will retry): ${(err as Error).message}`,
      );
    }
    return false;
  }
}

// Boot attempt + bounded-backoff supervisor (30s → cap 5min). Retries only
// while the bridge is unattached; stops once attached. Unref'd so a pending
// retry never keeps the process alive on its own.
function scheduleLtmReconnect(): void {
  if (ltmReconnectTimer || memory.getLtm()) return;
  const baseMs = 30_000;
  const capMs = 300_000;
  const delay = Math.min(capMs, baseMs * 2 ** Math.min(ltmAttachAttempts, 4));
  ltmReconnectTimer = setTimeout(async () => {
    ltmReconnectTimer = null;
    ltmAttachAttempts++;
    const ok = await attachLtmBridge();
    if (!ok) scheduleLtmReconnect();
  }, delay);
  ltmReconnectTimer.unref?.();
}

if (!(await attachLtmBridge())) scheduleLtmReconnect();

// LTM bridge shutdown: drain the reconciler, detach, close the LTM store.
// Use once() so duplicate signals don't re-run. Does NOT call process.exit
// -- let the process exit naturally once all handles drain.
const shutdownLtm = async (signal: string): Promise<void> => {
  // Stop any pending reconnect attempt first, so a retry can't re-open the
  // store mid-drain.
  if (ltmReconnectTimer) {
    clearTimeout(ltmReconnectTimer);
    ltmReconnectTimer = null;
  }
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

// --- Dream job (nightly supervised memory maintenance) -------------------
if (process.env.DREAM_ENABLED !== "0") {
  const ltmStoreDir = process.env.LTM_STORE_DIR || path.join(config.dataDir, "ltm");
  const dreamDir = path.join(ltmStoreDir, "dream");
  const sessionsDir = path.join(config.dataDir, "sessions");
  const hour = Number(process.env.DREAM_HOUR ?? 3);
  const model = process.env.DREAM_MODEL ?? "claude-haiku-4.5";
  const minConfidence = Number(process.env.DREAM_MIN_CONFIDENCE ?? 0.6);
  const tokenBudget = Number(process.env.DREAM_MINE_TOKEN_BUDGET ?? 8000);
  const proposeOnly = process.env.DREAM_PROPOSE_ONLY === "1";

  const ensureMaintenanceSession = async (): Promise<string> => {
    if (maintenanceSessionId) {
      await manager.unarchiveSession(maintenanceSessionId).catch(() => {});
      return maintenanceSessionId;
    }
    const row = await manager.createSession();
    await manager.rename(row.id, "Memory maintenance");
    maintenanceSessionId = row.id;
    return row.id;
  };

  const run = async () => {
    const ltmInstance = memory.getLtm();
    if (!ltmInstance) return;
    await runDreamJob({
      ltm: ltmInstance,
      reconcile: (o) => (reconciler ? reconciler.reconcile(o) : Promise.resolve({ pruned: 0 } as { pruned: number })),
      store: proposalStore,
      storeDir: ltmStoreDir,
      dreamDir,
      gatherUserTurns: makeGatherUserTurns(sessionsDir),
      ensureMaintenanceSession,
      postReport: (sid, text) => manager.postAssistantNote(sid, text),
      getApiKey: () => resolveApiKey("github-copilot", authStore),
      model,
      minConfidence,
      tokenBudget,
      proposeOnly,
      idFor: (seed) => "p-" + crypto.createHash("sha256").update(seed).digest("hex").slice(0, 8),
      now: () => new Date().toISOString(),
    }).catch((e) => console.warn(`[dream] run error: ${(e as Error).message}`));
  };

  const readState = (): string | null => {
    try {
      return (JSON.parse(fs.readFileSync(path.join(dreamDir, "dream-state.json"), "utf8")) as { lastRunDate: string | null }).lastRunDate;
    } catch {
      return null;
    }
  };

  // First-boot baseline: persist a minimal dream-state so a daytime (re)start
  // past DREAM_HOUR doesn't trigger an immediate run; the next run waits for
  // the scheduled hour. runDreamJob later overwrites this with the full state.
  const recordBaseline = (date: string): void => {
    try {
      fs.mkdirSync(dreamDir, { recursive: true });
      fs.writeFileSync(
        path.join(dreamDir, "dream-state.json"),
        JSON.stringify({ lastRunDate: date, cursorMs: 0, maintenanceSessionId: null }, null, 2),
      );
    } catch (e) {
      console.warn(`[dream] could not write baseline dream-state: ${(e as Error).message}`);
    }
  };

  dreamScheduler = new DreamScheduler({ run, hour, lastRunDate: readState, nowDate: () => new Date(), recordBaseline });
  dreamScheduler.start();
}

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

  // Step 1: stop the scheduler's polling timer. Done FIRST so a scheduler
  // tick can't launch a new session AFTER the manager.abortAll sweep below
  // and orphan it. scheduler.stop is a sync clearInterval -- no inter-step
  // dependency on the later steps.
  try {
    scheduler.stop();
  } catch (err) {
    console.warn(`[shutdown] scheduler.stop: ${(err as Error).message}`);
  }

  // Stop the dream scheduler's polling timer (sync clearInterval, like scheduler.stop).
  try {
    dreamScheduler?.stop();
  } catch (err) {
    console.warn(`[shutdown] dreamScheduler.stop: ${(err as Error).message}`);
  }

  // Step 2: close every attached WebSocket with code 1001 (going away).
  // wss.clients is ws.WebSocketServer's standard Set<WebSocket>.
  //
  // CRITICAL: this MUST run before step 3 (server.close). Node's
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

  // Step 3: stop accepting new HTTP connections + wait for in-flight to finish.
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

  // Step 4: abort all in-flight subagent sessions.
  try {
    await manager.abortAll();
  } catch (err) {
    console.warn(`[shutdown] manager.abortAll: ${(err as Error).message}`);
  }

  // Step 5: cancel all in-flight tasks (durably records "cancelled" and
  // initiates harness.abort() fire-and-forget; see header docstring).
  try {
    await taskManager.cancelAll();
  } catch (err) {
    console.warn(`[shutdown] taskManager.cancelAll: ${(err as Error).message}`);
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

const { app, injectWebSocket, wss } = createApp({ manager, taskManager, scheduler, indexer, bus, persona, config, authStore, workdirs, skills, approvalCoordinator, memoryRootDir: memoryRoot() });
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
