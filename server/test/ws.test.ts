import { serve } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

  test("sends empty pending approval snapshot on open", async () => {
    const pending = approvalCoordinator.request({
      sessionId: "s-pending",
      toolName: "bash",
      toolLabel: "Bash",
      params: {},
    });
    const approvalId = approvalCoordinator.list()[0]!.approvalId;

    const ws = new WebSocket(`ws://localhost:${port}/api/ws?token=test-token`);
    const events = collect(ws);
    await new Promise((r) => ws.addEventListener("open", r));
    await new Promise((r) => setTimeout(r, 50));

    expect(events).toContainEqual({
      type: "pending_approvals",
      approvals: [],
    });
    expect(events.some((e) => e.type === "pending_approvals" && e.approvals.some((a: any) => a.approvalId === approvalId))).toBe(false);
    approvalCoordinator.resolve(approvalId, "deny");
    await pending;
    ws.close();
  });

  test("subscribe sends pending approval snapshot scoped to subscribed session", async () => {
    const pendingA = approvalCoordinator.request({
      sessionId: "s-a",
      toolName: "bash",
      toolLabel: "Bash",
      params: { cmd: "a" },
    });
    const pendingB = approvalCoordinator.request({
      sessionId: "s-b",
      toolName: "write",
      toolLabel: "Write",
      params: { path: "b" },
    });
    const approvalA = approvalCoordinator.list().find((entry) => entry.sessionId === "s-a")!;
    const approvalB = approvalCoordinator.list().find((entry) => entry.sessionId === "s-b")!;

    const ws = new WebSocket(`ws://localhost:${port}/api/ws?token=test-token`);
    const events = collect(ws);
    await new Promise((r) => ws.addEventListener("open", r));
    await new Promise((r) => setTimeout(r, 50));
    events.length = 0;

    ws.send(JSON.stringify({ type: "subscribe", sessionId: "s-a" }));
    await new Promise((r) => setTimeout(r, 50));

    const snapshots = events.filter((e) => e.type === "pending_approvals");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual({ type: "pending_approvals", approvals: [approvalA] });
    expect(snapshots[0].approvals.some((approval: any) => approval.approvalId === approvalB.approvalId)).toBe(false);

    approvalCoordinator.resolve(approvalA.approvalId, "deny");
    approvalCoordinator.resolve(approvalB.approvalId, "deny");
    await pendingA;
    await pendingB;
    ws.close();
  });

  test("second subscribe sends fresh pending approval snapshot for new session", async () => {
    const pendingA = approvalCoordinator.request({
      sessionId: "s-a",
      toolName: "bash",
      toolLabel: "Bash",
      params: { cmd: "a" },
    });
    const pendingB = approvalCoordinator.request({
      sessionId: "s-b",
      toolName: "write",
      toolLabel: "Write",
      params: { path: "b" },
    });
    const approvalA = approvalCoordinator.list().find((entry) => entry.sessionId === "s-a")!;
    const approvalB = approvalCoordinator.list().find((entry) => entry.sessionId === "s-b")!;

    const ws = new WebSocket(`ws://localhost:${port}/api/ws?token=test-token`);
    const events = collect(ws);
    await new Promise((r) => ws.addEventListener("open", r));
    await new Promise((r) => setTimeout(r, 50));
    events.length = 0;

    ws.send(JSON.stringify({ type: "subscribe", sessionId: "s-a" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(events.filter((e) => e.type === "pending_approvals").at(-1)).toEqual({
      type: "pending_approvals",
      approvals: [approvalA],
    });
    events.length = 0;

    ws.send(JSON.stringify({ type: "subscribe", sessionId: "s-b" }));
    await new Promise((r) => setTimeout(r, 50));

    const snapshots = events.filter((e) => e.type === "pending_approvals");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual({ type: "pending_approvals", approvals: [approvalB] });
    expect(snapshots[0].approvals.some((approval: any) => approval.approvalId === approvalA.approvalId)).toBe(false);

    approvalCoordinator.resolve(approvalA.approvalId, "deny");
    approvalCoordinator.resolve(approvalB.approvalId, "deny");
    await pendingA;
    await pendingB;
    ws.close();
  });

  test("unsubscribe does not send pending approval snapshot", async () => {
    const pending = approvalCoordinator.request({
      sessionId: "s-unsubscribe",
      toolName: "bash",
      toolLabel: "Bash",
      params: {},
    });
    const approvalId = approvalCoordinator.list()[0]!.approvalId;

    const ws = new WebSocket(`ws://localhost:${port}/api/ws?token=test-token`);
    const events = collect(ws);
    await new Promise((r) => ws.addEventListener("open", r));
    await new Promise((r) => setTimeout(r, 50));
    ws.send(JSON.stringify({ type: "subscribe", sessionId: "s-unsubscribe" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(events.some((e) => e.type === "pending_approvals" && e.approvals.some((a: any) => a.approvalId === approvalId))).toBe(true);
    events.length = 0;

    ws.send(JSON.stringify({ type: "unsubscribe" }));
    await new Promise((r) => setTimeout(r, 50));

    expect(events.filter((e) => e.type === "pending_approvals")).toHaveLength(0);
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

  test("malformed approval_response messages are ignored and keep socket open", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/api/ws?token=test-token`);
    await new Promise((r) => ws.addEventListener("open", r));
    const resolveSpy = vi.spyOn(approvalCoordinator, "resolve");

    ws.send(JSON.stringify({ type: "approval_response", approvalId: 5, decision: "approve" }));
    ws.send(JSON.stringify({ type: "approval_response", approvalId: "x", decision: "timeout" }));
    ws.send(JSON.stringify({ type: "approval_response" }));
    await new Promise((r) => setTimeout(r, 50));

    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(resolveSpy).not.toHaveBeenCalled();

    const pending = approvalCoordinator.request({
      sessionId: "s-valid-after-malformed",
      toolName: "bash",
      toolLabel: "Bash",
      params: {},
    });
    const approvalId = approvalCoordinator.list()[0]!.approvalId;
    resolveSpy.mockClear();
    ws.send(JSON.stringify({ type: "approval_response", approvalId, decision: "approve" }));
    await expect(pending).resolves.toBe("approve");
    expect(resolveSpy).toHaveBeenCalledWith(approvalId, "approve");
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
