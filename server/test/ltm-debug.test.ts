import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { EventBus } from "../src/events.ts";
import * as memory from "../src/memory/index.ts";
import { PiAuthStore } from "../src/pi-auth.ts";
import { PersonaStore } from "../src/persona.ts";
import { createApp, type AppDeps } from "../src/server.ts";

const auth = { authorization: "Bearer test-token" };
const emptyProfile = {
  identity: [],
  preferences: [],
  directives: [],
  attributes: [],
  dormant: [],
};

let tmpData: string;
let app: ReturnType<typeof createApp>["app"];

function makeDeps(dataDir: string): AppDeps {
  return {
    manager: {
      isRunning: () => false,
      isCompacting: () => false,
    } as unknown as AppDeps["manager"],
    taskManager: {} as unknown as AppDeps["taskManager"],
    scheduler: {} as unknown as AppDeps["scheduler"],
    indexer: {
      listSessions: () => [],
    } as unknown as AppDeps["indexer"],
    bus: new EventBus(),
    persona: new PersonaStore(join(dataDir, "persona")),
    config: {
      port: 0,
      host: "127.0.0.1",
      dataDir,
      authToken: "test-token",
      defaultModel: "faux/faux",
      webDistDir: dataDir,
      generateTitles: false,
      piAuthPath: join(dataDir, "no-auth.json"),
      subagentModel: "faux/faux",
      taskConcurrency: 4,
      taskTimeoutMinutes: 15,
      contextFiles: false,
      defaultApprovalMode: "yolo",
    },
    authStore: new PiAuthStore(join(dataDir, "no-auth.json")),
  };
}

function attachStubLtm() {
  memory.attachLtm({
    composeContext: async (query: string, opts: { k?: number; tokenBudget?: number }) => {
      expect(query).toBe("hello");
      expect(opts).toMatchObject({ k: 3, tokenBudget: 500 });
      return "## composed stub";
    },
    profile: () => emptyProfile,
    explain: async (query: string, k?: number) => {
      expect(query).toBe("hello");
      expect(k).toBe(3);
      return [
        {
          record: {
            id: "rec-1",
            kind: "turn",
            sessionId: "sess-1",
            entryId: "entry-1",
            role: "user",
            timestamp: "2026-06-17T12:34:56.000Z",
            text: "x".repeat(200),
            salience: 0.7,
            accessCount: 0,
            state: "active",
            embedding: [1, 2, 3],
          },
          score: 0.99,
          breakdown: {
            total: 0.99,
            vector: 0.1,
            lexical: 0.2,
            recency: 0.3,
            salience: 0.4,
            retention: 0.6,
          },
        },
      ];
    },
  } as never);
}

beforeEach(() => {
  tmpData = mkdtempSync(join(tmpdir(), "ltm-debug-"));
  app = createApp(makeDeps(tmpData)).app;
});

afterEach(() => {
  memory.attachLtm(null);
  rmSync(tmpData, { recursive: true, force: true });
});

describe("GET /api/admin/ltm-debug/compose", () => {
  test("returns composed context, profile, and compact explain results", async () => {
    attachStubLtm();

    const res = await app.request("/api/admin/ltm-debug/compose?q=hello&k=3&budget=500", {
      headers: auth,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      query: "hello",
      k: 3,
      budget: 500,
      composed: "## composed stub",
      profile: emptyProfile,
      explain: [
        {
          id: "rec-1",
          role: "user",
          date: "2026-06-17",
          text: "x".repeat(160),
          total: 0.99,
          vector: 0.1,
          lexical: 0.2,
          recency: 0.3,
          salience: 0.4,
          retention: 0.6,
        },
      ],
    });
  });

  test("returns 400 when q is missing", async () => {
    memory.attachLtm({
      composeContext: async () => "unused",
      profile: () => emptyProfile,
      explain: async () => [],
    } as never);

    const res = await app.request("/api/admin/ltm-debug/compose", { headers: auth });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "q is required" });
  });

  test("returns 503 when LTM is not attached", async () => {
    memory.attachLtm(null);

    const res = await app.request("/api/admin/ltm-debug/compose?q=hello", { headers: auth });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "ltm not attached" });
  });
});
