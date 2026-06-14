import { serve } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ApprovalCoordinator } from "../src/approval/coordinator.ts";
import { PiAuthStore } from "../src/pi-auth.ts";
import { createApp } from "../src/server.ts";
import { PersonaStore } from "../src/persona.ts";
import { fauxAssistantMessage, makeManager, setupFaux } from "./helpers.ts";

let faux: ReturnType<typeof setupFaux>;
let server: ReturnType<typeof serve>;
let port: number;
let made: ReturnType<typeof makeManager>;
let approvalCoordinator: ApprovalCoordinator;

beforeEach(async () => {
  faux = setupFaux();
  made = makeManager(faux);
  approvalCoordinator = new ApprovalCoordinator({
    timeoutMs: 60_000,
    onRequest: (req) => {
      made.bus.emit({
        type: "approval_request",
        approvalId: req.approvalId,
        sessionId: req.sessionId,
        toolName: req.toolName,
        toolLabel: req.toolLabel,
        params: req.params,
      });
    },
    onResolved: (approvalId, decision) => {
      made.bus.emit({ type: "approval_resolved", approvalId, decision });
    },
  });
  const { app, injectWebSocket } = createApp({
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
    approvalCoordinator,
  });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      port = info.port;
      resolve();
    });
    injectWebSocket(server);
  });
});

afterEach(async () => {
  faux.unregister();
  await new Promise((r) => server.close(r));
});

function collect(ws: WebSocket): any[] {
  const events: any[] = [];
  ws.addEventListener("message", (e) => events.push(JSON.parse(String(e.data))));
  return events;
}

describe("websocket", () => {
  test("rejects bad token", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/api/ws?token=wrong`);
    // Wait for close; the unauthorized handler calls ws.close(4401) after open
    // so we need to tolerate an "open then close" sequence
    const isClosed = await new Promise<boolean>((resolve) => {
      let opened = false;
      ws.addEventListener("open", () => {
        opened = true;
      });
      ws.addEventListener("close", () => resolve(opened || true));
      // Give it a generous timeout in case open never fires
      setTimeout(() => resolve(ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING), 2000);
    });
    expect(isClosed).toBe(true);
    // The key security property: the socket is closed, not open/usable
    expect(ws.readyState).not.toBe(WebSocket.OPEN);
  });

  test("streams agent events for subscribed session, meta for all", async () => {
    faux.setResponses([fauxAssistantMessage("ws reply")]);
    const ws = new WebSocket(`ws://localhost:${port}/api/ws?token=test-token`);
    await new Promise((r) => ws.addEventListener("open", r));
    const events = collect(ws);

    const row = await made.manager.createSession();
    ws.send(JSON.stringify({ type: "subscribe", sessionId: row.id }));
    await new Promise((r) => setTimeout(r, 50));
    await made.manager.sendMessage(row.id, "hi");
    await made.manager.waitForIdle(row.id);
    await new Promise((r) => setTimeout(r, 100));

    const agentTypes = events.filter((e) => e.type === "agent").map((e) => e.event.type);
    expect(agentTypes).toContain("message_end");
    expect(events.some((e) => e.type === "session_meta")).toBe(true);
    ws.close();
  });

  test("sends pending approval snapshot on open", async () => {
    let approvalId = "";
    const pending = approvalCoordinator.request({
      sessionId: "s-pending",
      toolName: "bash",
      toolLabel: "Bash",
      params: {},
    });
    approvalId = approvalCoordinator.list()[0]!.approvalId;

    const ws = new WebSocket(`ws://localhost:${port}/api/ws?token=test-token`);
    const events = collect(ws);
    await new Promise((r) => ws.addEventListener("open", r));
    await new Promise((r) => setTimeout(r, 50));

    expect(events).toContainEqual({
      type: "pending_approvals",
      approvals: [{ approvalId, sessionId: "s-pending" }],
    });
    approvalCoordinator.resolve(approvalId, "deny");
    await pending;
    ws.close();
  });

  test("approval_request is scoped to subscribed session, resolved/mode events are global", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/api/ws?token=test-token`);
    await new Promise((r) => ws.addEventListener("open", r));
    const events = collect(ws);

    const row1 = await made.manager.createSession();
    const row2 = await made.manager.createSession();
    ws.send(JSON.stringify({ type: "subscribe", sessionId: row1.id }));
    await new Promise((r) => setTimeout(r, 50));

    const hidden = approvalCoordinator.request({ sessionId: row2.id, toolName: "bash", toolLabel: "Bash", params: {} });
    const shown = approvalCoordinator.request({ sessionId: row1.id, toolName: "write", toolLabel: "Write", params: {} });
    await new Promise((r) => setTimeout(r, 50));

    expect(events.filter((e) => e.type === "approval_request").map((e) => e.sessionId)).toEqual([row1.id]);
    made.bus.emit({ type: "approval_mode_changed", sessionId: row2.id, mode: "ask" });
    const shownId = approvalCoordinator.list().find((entry) => entry.sessionId === row1.id)!.approvalId;
    approvalCoordinator.resolve(shownId, "approve");
    await shown;
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toContainEqual({ type: "approval_mode_changed", sessionId: row2.id, mode: "ask" });
    expect(events.some((e) => e.type === "approval_resolved" && e.approvalId === shownId && e.decision === "approve")).toBe(true);

    const hiddenId = approvalCoordinator.list().find((entry) => entry.sessionId === row2.id)!.approvalId;
    approvalCoordinator.resolve(hiddenId, "deny");
    await hidden;
    ws.close();
  });

  test("approval_response client message resolves pending approval", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/api/ws?token=test-token`);
    await new Promise((r) => ws.addEventListener("open", r));
    const events = collect(ws);

    const pending = approvalCoordinator.request({
      sessionId: "s-response",
      toolName: "bash",
      toolLabel: "Bash",
      params: {},
    });
    const approvalId = approvalCoordinator.list()[0]!.approvalId;
    ws.send(JSON.stringify({ type: "approval_response", approvalId, decision: "deny" }));

    await expect(pending).resolves.toBe("deny");
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toContainEqual({ type: "approval_resolved", approvalId, decision: "deny" });
    ws.close();
  });

  test("unsubscribed sessions only get lightweight events", async () => {
    faux.setResponses([fauxAssistantMessage("quiet reply")]);
    const ws = new WebSocket(`ws://localhost:${port}/api/ws?token=test-token`);
    await new Promise((r) => ws.addEventListener("open", r));
    const events = collect(ws);

    const row = await made.manager.createSession(); // not subscribed
    await made.manager.sendMessage(row.id, "hi");
    await made.manager.waitForIdle(row.id);
    await new Promise((r) => setTimeout(r, 100));

    const agentTypes = events.filter((e) => e.type === "agent").map((e) => e.event.type);
    expect(agentTypes).toContain("agent_start");
    expect(agentTypes).toContain("agent_end");
    expect(agentTypes).not.toContain("message_update");
    expect(events.some((e) => e.type === "session_meta")).toBe(true);
    ws.close();
  });
});
