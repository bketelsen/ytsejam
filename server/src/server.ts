import path from "node:path";
import fs from "node:fs";
import { Hono, type Context, type Next } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import type { Config } from "./config.ts";
import type { EventBus, ServerEvent } from "./events.ts";
import type { Indexer } from "./indexer.ts";
import type { AgentManager } from "./manager.ts";
import type { ApprovalCoordinator } from "./approval/coordinator.ts";
import * as memory from "./memory/index.ts";
import { listAvailableModels } from "./models.ts";
import type { PiAuthStore } from "./pi-auth.ts";
import type { PersonaStore } from "./persona.ts";
import type { SchedulerService } from "./scheduler.ts";
import type { SkillSummary, SkillsStore } from "./skills.ts";
import type { TaskManager } from "./task-manager.ts";
import type { WorkdirStore } from "./workdirs.ts";

const APPROVAL_PREFIX_SKILLS: SkillSummary[] = [
  {
    name: "yolo",
    description: "Force this turn to skip approval gates",
    triggers: ["yolo", "skip approval", "bypass approval"],
  },
  {
    name: "careful",
    description: "Force this turn to require approval for every mutating tool",
    triggers: ["careful", "require approval", "ask approval"],
  },
];

export interface AppDeps {
  manager: AgentManager;
  taskManager: TaskManager;
  scheduler: SchedulerService;
  indexer: Indexer;
  bus: EventBus;
  persona: PersonaStore;
  config: Config;
  authStore: PiAuthStore;
  /** Optional: when supplied, exposes POST /api/sessions/:id/cwd. */
  workdirs?: WorkdirStore;
  /** Optional: when supplied, exposes GET /api/skills. */
  skills?: SkillsStore;
  /** Optional approval coordinator for WS approval lifecycle messages. */
  approvalCoordinator?: ApprovalCoordinator;
}

export function createApp(deps: AppDeps) {
  const { manager, indexer, persona, config } = deps;
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  /** events every client gets regardless of subscription (sidebar liveness) */
  const LIGHTWEIGHT = new Set(["agent_start", "agent_end"]);

  function shouldSendWsEvent(event: ServerEvent, subscribed: string | null): boolean {
    if (event.type === "approval_request") return event.sessionId === subscribed;
    if (event.type === "approval_resolved" || event.type === "approval_mode_changed") return true;
    if (event.type !== "agent") return true;
    return event.sessionId === subscribed || LIGHTWEIGHT.has(event.event.type);
  }

  function isApprovalResponse(value: unknown): value is { type: "approval_response"; approvalId: string; decision: "approve" | "deny" } {
    if (typeof value !== "object" || value === null) return false;
    const msg = value as Record<string, unknown>;
    return msg.type === "approval_response" &&
      typeof msg.approvalId === "string" &&
      (msg.decision === "approve" || msg.decision === "deny");
  }

  app.post("/api/login", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (body.token !== config.authToken) return c.json({ error: "invalid token" }, 401);
    return c.json({ ok: true });
  });

  // auth for everything else under /api (login + ws exempt; ws does its own query-token check)
  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/login" || c.req.path === "/api/ws") return next();
    const header = c.req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : c.req.query("token");
    if (token !== config.authToken) return c.json({ error: "unauthorized" }, 401);
    return next();
  });

  app.get(
    "/api/ws",
    upgradeWebSocket((c) => {
      if (c.req.query("token") !== config.authToken) {
        return {
          onOpen: (_evt, ws) => ws.close(4401, "unauthorized"),
        };
      }
      let subscribed: string | null = null;
      let unsubscribeBus: (() => void) | null = null;
      return {
        onOpen: (_evt, ws) => {
          unsubscribeBus = deps.bus.subscribe((event: ServerEvent) => {
            if (shouldSendWsEvent(event, subscribed) && ws.readyState === 1 /* OPEN */) {
              ws.send(JSON.stringify(event));
            }
          });
          // Seed the client map on every reconnect. The real per-session
          // catch-up snapshot is sent after subscribe, when the server knows
          // which session this socket is viewing.
          if (deps.approvalCoordinator && ws.readyState === 1 /* OPEN */) {
            ws.send(JSON.stringify({
              type: "pending_approvals",
              approvals: [],
            }));
          }
        },
        onMessage: (evt, ws) => {
          try {
            const msg = JSON.parse(String(evt.data));
            if (msg.type === "subscribe" && typeof msg.sessionId === "string") {
              subscribed = msg.sessionId;
              if (deps.approvalCoordinator && ws.readyState === 1 /* OPEN */) {
                const approvals = deps.approvalCoordinator
                  .list()
                  .filter((approval) => approval.sessionId === subscribed);
                ws.send(JSON.stringify({
                  type: "pending_approvals",
                  approvals,
                }));
              }
            }
            if (msg.type === "unsubscribe") subscribed = null;
            if (isApprovalResponse(msg) && deps.approvalCoordinator) {
              deps.approvalCoordinator.resolve(msg.approvalId, msg.decision);
            }
          } catch {
            // ignore malformed client messages
          }
        },
        onClose: () => unsubscribeBus?.(),
      };
    }),
  );

  app.get("/api/sessions", (c) => {
    const includeArchived = c.req.query("archived") === "1";
    const sessions = indexer
      .listSessions({ includeArchived })
      .map((s) => ({
        ...s,
        running: manager.isRunning(s.id),
        compacting: manager.isCompacting(s.id),
      }));
    return c.json({ sessions });
  });

  app.get("/api/memory/health", async (c) => {
    const h = await memory.health();
    return c.json({ ltm: h.ltm ?? null });
  });

  app.post("/api/sessions", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const session = await manager.createSession(body.model);
    return c.json({ session: { ...session, running: false, compacting: false } });
  });

  app.get("/api/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const row = indexer.getSession(id);
    if (!row) return c.json({ error: "not found" }, 404);
    const messages = await manager.getMessages(id);
    return c.json({
      session: {
        ...row,
        running: manager.isRunning(id),
        compacting: manager.isCompacting(id),
        cwd: manager.resolveWorkdir(id),
      },
      messages,
    });
  });

  app.post("/api/sessions/:id/messages", async (c) => {
    const id = c.req.param("id");
    if (!indexer.getSession(id)) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.text !== "string" || !body.text.trim()) {
      return c.json({ error: "text is required" }, 400);
    }
    await manager.sendMessage(id, body.text);
    return c.json({ ok: true }, 202);
  });

  app.post("/api/sessions/:id/abort", async (c) => {
    await manager.abort(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.patch("/api/sessions/:id", async (c) => {
    const id = c.req.param("id");
    if (!indexer.getSession(id)) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.title === "string") await manager.rename(id, body.title);
    if (body.unread === false) manager.markRead(id);
    if (typeof body.model === "string") await manager.setModel(id, body.model);
    if (body.approvalMode !== undefined) {
      if (body.approvalMode !== "yolo" && body.approvalMode !== "ask") {
        return c.json({ error: "approvalMode must be 'yolo' or 'ask'" }, 400);
      }
      await manager.setApprovalMode(id, body.approvalMode);
    }
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/cwd", async (c) => {
    const id = c.req.param("id");
    if (!indexer.getSession(id)) return c.json({ error: "not found" }, 404);
    if (!deps.workdirs) return c.json({ error: "workdir store not configured" }, 501);
    const body = await c.req.json().catch(() => ({}));
    const cwd = body.cwd;
    if (typeof cwd !== "string" || !cwd.trim()) {
      return c.json({ error: "cwd is required" }, 400);
    }
    if (!path.isAbsolute(cwd)) {
      return c.json({ error: "cwd must be an absolute path" }, 400);
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(cwd);
    } catch {
      return c.json({ error: `cwd does not exist: ${cwd}` }, 400);
    }
    if (!stat.isDirectory()) {
      return c.json({ error: `cwd is not a directory: ${cwd}` }, 400);
    }
    deps.workdirs.append(id, { dir: cwd, timestamp: new Date().toISOString() });
    await manager.applyWorkdirChange(id);
    return c.json({ ok: true, cwd: manager.resolveWorkdir(id) });
  });

  app.post("/api/sessions/:id/archive", async (c) => {
    const id = c.req.param("id");
    if (!indexer.getSession(id)) return c.json({ error: "not found" }, 404);
    await manager.archiveSession(id);
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/unarchive", async (c) => {
    const id = c.req.param("id");
    // includeArchived: archived sessions are hidden from the default list,
    // so a lookup by id must opt in or this 404s every unarchive attempt.
    // The DB-only getSession bypasses archived-filtering, but be explicit.
    if (!indexer.getSession(id)) return c.json({ error: "not found" }, 404);
    await manager.unarchiveSession(id);
    return c.json({ ok: true });
  });

  app.get("/api/tasks", (c) => c.json({ tasks: indexer.listTasks() }));

  app.post("/api/tasks/:id/cancel", async (c) => {
    const id = c.req.param("id");
    if (!indexer.getTask(id)) return c.json({ error: "not found" }, 404);
    const ok = await deps.taskManager.cancel(id);
    if (!ok) return c.json({ error: "not cancellable" }, 409);
    return c.json({ ok: true });
  });

  app.get("/api/tasks/:id/transcript", async (c) => {
    const id = c.req.param("id");
    const task = indexer.getTask(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const messages = await deps.taskManager.getTranscript(id);
    return c.json({ task, messages });
  });

  app.get("/api/schedules", (c) => c.json({ schedules: indexer.listSchedules() }));

  app.delete("/api/schedules/:id", (c) => {
    const ok = deps.scheduler.cancel(c.req.param("id"));
    if (!ok) return c.json({ error: "not cancellable" }, 409);
    return c.json({ ok: true });
  });

  app.get("/api/persona", async (c) => c.json({ content: await persona.load() }));

  app.put("/api/persona", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.content !== "string") return c.json({ error: "content is required" }, 400);
    await persona.save(body.content);
    return c.json({ ok: true });
  });

  app.get("/api/skills", async (c) => {
    const onDisk = deps.skills ? await deps.skills.list() : [];
    // Synthetic per-turn approval-mode prefix overrides. They are not real
    // skills (no SKILL.md), they are commands parsed by approval/prefix.ts
    // and stripped from the message before agent dispatch. Surfaced here so
    // they appear in the slash overlay alongside real skills.
    const skills = [...onDisk, ...APPROVAL_PREFIX_SKILLS];
    return c.json({ skills });
  });

  app.get("/api/models", (c) =>
    c.json({ models: listAvailableModels({ oauth: deps.authStore }), defaultModel: config.defaultModel }),
  );

  // Cache-control for files whose freshness matters for the PWA update flow:
  //   - sw.js MUST revalidate every request, or the browser caches the old
  //     service worker and never sees deploys.
  //   - index.html MUST revalidate so updated bundle hashes are picked up.
  //   - manifest.webmanifest MUST revalidate so shortcut/icon edits land.
  //
  // ⚠ Hono path-matching gotcha: `app.use("/index.html", ...)` matches the
  // REQUEST PATH `/index.html`, not the file the SPA fallback serves. A
  // bare `GET /` (or `GET /?action=tasks` from a PWA shortcut) is a `/`
  // request that serveStatic resolves to the index.html bytes; the path
  // the middleware matches against is `/`, not `/index.html`. So BOTH
  // routes are required — without `app.use("/", ...)` the no-cache header
  // never lands on real-browser navigation traffic, and the entire update
  // flow silently breaks.
  //
  // Query strings don't affect Hono path matching, so `/` covers every
  // `/?action=…` shortcut URL too.
  //
  // We set this BEFORE serveStatic so the header lands on the response
  // body that serveStatic produces (via await next()).
  const noCacheMiddleware = async (c: Context, next: Next) => {
    await next();
    c.header("Cache-Control", "no-cache");
  };
  app.use("/sw.js", noCacheMiddleware);
  app.use("/", noCacheMiddleware);
  app.use("/index.html", noCacheMiddleware);
  app.use("/manifest.webmanifest", noCacheMiddleware);

  // static web app (built assets); SPA fallback to index.html
  // serveStatic root must be relative to process cwd; compute a relative path from cwd to webDistDir
  const relativeWebDist = path.relative(process.cwd(), config.webDistDir);
  app.use("/*", serveStatic({ root: relativeWebDist }));
  app.use("/*", serveStatic({ root: relativeWebDist, path: "index.html" }));

  return { app, injectWebSocket };
}
