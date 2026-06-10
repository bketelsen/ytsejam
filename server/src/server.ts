import path from "node:path";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import type { Config } from "./config.ts";
import type { EventBus, ServerEvent } from "./events.ts";
import type { Indexer } from "./indexer.ts";
import type { AgentManager } from "./manager.ts";
import { listAvailableModels } from "./models.ts";
import type { PiAuthStore } from "./pi-auth.ts";
import type { PersonaStore } from "./persona.ts";
import type { TaskManager } from "./task-manager.ts";

export interface AppDeps {
  manager: AgentManager;
  taskManager: TaskManager;
  indexer: Indexer;
  bus: EventBus;
  persona: PersonaStore;
  config: Config;
  authStore: PiAuthStore;
}

export function createApp(deps: AppDeps) {
  const { manager, indexer, persona, config } = deps;
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  /** events every client gets regardless of subscription (sidebar liveness) */
  const LIGHTWEIGHT = new Set(["agent_start", "agent_end"]);

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
            const send =
              event.type !== "agent" ||
              event.sessionId === subscribed ||
              LIGHTWEIGHT.has(event.event.type);
            if (send && ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(event));
          });
        },
        onMessage: (evt) => {
          try {
            const msg = JSON.parse(String(evt.data));
            if (msg.type === "subscribe") subscribed = msg.sessionId;
            if (msg.type === "unsubscribe") subscribed = null;
          } catch {
            // ignore malformed client messages
          }
        },
        onClose: () => unsubscribeBus?.(),
      };
    }),
  );

  app.get("/api/sessions", (c) => {
    const sessions = indexer
      .listSessions()
      .map((s) => ({ ...s, running: manager.isRunning(s.id) }));
    return c.json({ sessions });
  });

  app.post("/api/sessions", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const session = await manager.createSession(body.model);
    return c.json({ session: { ...session, running: false } });
  });

  app.get("/api/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const row = indexer.getSession(id);
    if (!row) return c.json({ error: "not found" }, 404);
    const messages = await manager.getMessages(id);
    return c.json({ session: { ...row, running: manager.isRunning(id) }, messages });
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
    return c.json({ ok: true });
  });

  app.delete("/api/sessions/:id", async (c) => {
    const id = c.req.param("id");
    if (!indexer.getSession(id)) return c.json({ error: "not found" }, 404);
    await manager.deleteSession(id);
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

  app.get("/api/persona", async (c) => c.json({ content: await persona.load() }));

  app.put("/api/persona", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.content !== "string") return c.json({ error: "content is required" }, 400);
    await persona.save(body.content);
    return c.json({ ok: true });
  });

  app.get("/api/models", (c) =>
    c.json({ models: listAvailableModels({ oauth: deps.authStore }), defaultModel: config.defaultModel }),
  );

  // static web app (built assets); SPA fallback to index.html
  // serveStatic root must be relative to process cwd; compute a relative path from cwd to webDistDir
  const relativeWebDist = path.relative(process.cwd(), config.webDistDir);
  app.use("/*", serveStatic({ root: relativeWebDist }));
  app.use("/*", serveStatic({ root: relativeWebDist, path: "index.html" }));

  return { app, injectWebSocket };
}
