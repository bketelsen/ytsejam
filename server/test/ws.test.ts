import { serve } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../src/server.ts";
import { PersonaStore } from "../src/persona.ts";
import { fauxAssistantMessage, makeManager, setupFaux } from "./helpers.ts";

let faux: ReturnType<typeof setupFaux>;
let server: ReturnType<typeof serve>;
let port: number;
let made: ReturnType<typeof makeManager>;

beforeEach(async () => {
  faux = setupFaux();
  made = makeManager(faux);
  const { app, injectWebSocket } = createApp({
    manager: made.manager,
    indexer: made.indexer,
    bus: made.bus,
    persona: new PersonaStore(`${made.dataDir}/persona`),
    config: {
      port: 0,
      dataDir: made.dataDir,
      authToken: "test-token",
      defaultModel: "faux/faux",
      webDistDir: "/tmp/nonexistent",
      generateTitles: false,
    },
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
