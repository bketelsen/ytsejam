import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ApprovalCoordinator } from "../src/approval/coordinator.ts";
import type { ServerEvent } from "../src/events.ts";
import { PiAuthStore } from "../src/pi-auth.ts";
import { PersonaStore } from "../src/persona.ts";
import { createApp, type AppDeps } from "../src/server.ts";
import { fauxAssistantMessage, makeManager, setupFaux } from "./helpers.ts";

let faux: ReturnType<typeof setupFaux>;
let made: ReturnType<typeof makeManager>;
let deps: AppDeps;
let app: ReturnType<typeof createApp>["app"];

const auth = { Authorization: "Bearer test-token" };

beforeEach(() => {
  faux = setupFaux();
  made = makeManager(faux);
  deps = {
    manager: made.manager,
    taskManager: made.taskManager,
    scheduler: made.scheduler,
    indexer: made.indexer,
    bus: made.bus,
    persona: new PersonaStore(`${made.dataDir}/persona`),
    config: {
      port: 0,
      host: "127.0.0.1",
      dataDir: made.dataDir,
      authToken: "test-token",
      defaultModel: "faux/faux",
      webDistDir: "/tmp/nonexistent",
      generateTitles: false,
      piAuthPath: `${made.dataDir}/no-auth.json`,
      subagentModel: "faux/faux",
      taskConcurrency: 4,
      taskTimeoutMinutes: 15,
      contextFiles: false,
    },
    authStore: new PiAuthStore(`${made.dataDir}/no-auth.json`),
  };
  app = createApp(deps).app;
});

afterEach(() => faux.unregister());

function jsonHeaders() {
  return { ...auth, "content-type": "application/json" };
}

async function createSession() {
  const row = await deps.manager.createSession();
  return row;
}

describe("approval-mode session API", () => {
  test("PATCH approvalMode=ask updates GET/index cache and appends JSONL", async () => {
    const row = await createSession();
    const res = await app.request(`/api/sessions/${row.id}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ approvalMode: "ask" }),
    });
    expect(res.status).toBe(200);

    const got = (await (await app.request(`/api/sessions/${row.id}`, { headers: auth })).json()) as any;
    expect(got.session.approvalMode).toBe("ask");
    expect(deps.indexer.getSession(row.id)?.approvalMode).toBe("ask");

    const lines = readFileSync(row.path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.some((entry) => entry.type === "set_approval_mode" && entry.mode === "ask")).toBe(true);
  });

  test("setApprovalMode round-trips through JSONL on rebuild", async () => {
    const row = await createSession();
    expect(deps.indexer.getSession(row.id)?.approvalMode).toBe("yolo");

    const res = await app.request(`/api/sessions/${row.id}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ approvalMode: "ask" }),
    });
    expect(res.status).toBe(200);
    expect(deps.indexer.getSession(row.id)?.approvalMode).toBe("ask");

    deps.indexer.setApprovalMode(row.id, "yolo");
    expect(deps.indexer.getSession(row.id)?.approvalMode).toBe("yolo");

    await deps.manager.rebuildIndex();
    expect(deps.indexer.getSession(row.id)?.approvalMode).toBe("ask");
  });

  test.each(["bogus", null, 1, false, {}, [], "undefined"])(
    "PATCH rejects invalid approvalMode %j",
    async (approvalMode) => {
      const row = await createSession();
      const res = await app.request(`/api/sessions/${row.id}`, {
        method: "PATCH",
        headers: jsonHeaders(),
        body: JSON.stringify({ approvalMode }),
      });
      expect(res.status).toBe(400);
      expect(deps.indexer.getSession(row.id)?.approvalMode).toBe("yolo");
    },
  );

  test("valid approvalMode emits session_meta and approval_mode_changed", async () => {
    const row = await createSession();
    const events: ServerEvent[] = [];
    const unsubscribe = deps.bus.subscribe((event) => events.push(event));
    try {
      const res = await app.request(`/api/sessions/${row.id}`, {
        method: "PATCH",
        headers: jsonHeaders(),
        body: JSON.stringify({ approvalMode: "ask" }),
      });
      expect(res.status).toBe(200);
    } finally {
      unsubscribe();
    }

    expect(events.some((event) => event.type === "session_meta" && event.session.id === row.id && event.session.approvalMode === "ask")).toBe(true);
    expect(events).toContainEqual({ type: "approval_mode_changed", sessionId: row.id, mode: "ask" });
  });

  test("PATCH without approvalMode preserves existing title/unread behavior", async () => {
    faux.setResponses([fauxAssistantMessage("api approval reply")]);
    const row = await createSession();
    await deps.manager.sendMessage(row.id, "hi");
    await deps.manager.waitForIdle(row.id);
    expect(deps.indexer.getSession(row.id)?.unread).toBe(true);

    const res = await app.request(`/api/sessions/${row.id}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ title: "Renamed", unread: false }),
    });
    expect(res.status).toBe(200);
    expect(deps.indexer.getSession(row.id)).toMatchObject({
      title: "Renamed",
      unread: false,
      approvalMode: "yolo",
    });
  });

  test("ApprovalCoordinator callbacks can bridge through the bus", async () => {
    const events: ServerEvent[] = [];
    const coord = new ApprovalCoordinator({
      timeoutMs: 60_000,
      onRequest: (req) => {
        events.push({
          type: "approval_request",
          approvalId: req.approvalId,
          sessionId: req.sessionId,
          toolName: req.toolName,
          toolLabel: req.toolLabel,
          params: req.params,
        });
      },
      onResolved: (approvalId, decision) => {
        events.push({ type: "approval_resolved", approvalId, decision });
      },
    });

    const pending = coord.request({
      sessionId: "s1",
      toolName: "bash",
      toolLabel: "Bash",
      params: { command: "pwd" },
    });
    const req = events.find((event): event is Extract<ServerEvent, { type: "approval_request" }> => event.type === "approval_request");
    expect(req).toMatchObject({
      type: "approval_request",
      sessionId: "s1",
      toolName: "bash",
      toolLabel: "Bash",
      params: { command: "pwd" },
    });

    expect(coord.resolve(req!.approvalId, "approve")).toBe(true);
    await expect(pending).resolves.toBe("approve");
    expect(events).toContainEqual({ type: "approval_resolved", approvalId: req!.approvalId, decision: "approve" });
  });
});
