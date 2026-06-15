import { describe, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { createApp } from "../src/server.ts";

describe("createApp wss export", () => {
  test("exports the underlying ws.WebSocketServer alongside app and injectWebSocket", () => {
    const { app, injectWebSocket, wss } = createApp({
      manager: {},
      taskManager: {},
      scheduler: {},
      indexer: {},
      bus: {},
      persona: {},
      config: {
        authToken: "test-token",
        defaultModel: "faux/faux",
        webDistDir: "/tmp/nonexistent",
      },
      authStore: {},
    } as any);

    expect(app).toBeDefined();
    expect(typeof injectWebSocket).toBe("function");
    expect(wss).toBeInstanceOf(WebSocketServer);
  });
});
