import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { EventBus } from "../src/events.ts";
import { PiAuthStore } from "../src/pi-auth.ts";
import { PersonaStore } from "../src/persona.ts";
import { createApp, type AppDeps } from "../src/server.ts";
import * as memory from "../src/memory/index.ts";

let tmpData: string;
let oldMemoryDir: string | undefined;
let deps: AppDeps;
let app: ReturnType<typeof createApp>["app"];

const auth = { Authorization: "Bearer test-token" };

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

beforeEach(() => {
  tmpData = mkdtempSync(join(tmpdir(), "memory-health-"));
  oldMemoryDir = process.env.YTSEJAM_MEMORY_DIR;
  process.env.YTSEJAM_MEMORY_DIR = join(tmpData, "memory");
  memory.attachReconciler(null);
  deps = makeDeps(tmpData);
  app = createApp(deps).app;
});

afterEach(() => {
  memory.attachReconciler(null);
  if (oldMemoryDir === undefined) delete process.env.YTSEJAM_MEMORY_DIR;
  else process.env.YTSEJAM_MEMORY_DIR = oldMemoryDir;
  rmSync(tmpData, { recursive: true, force: true });
});

describe("GET /api/memory/health", () => {
  test("returns LTM health when a reconciler is attached", async () => {
    memory.attachReconciler({
      health: () => ({
        reachable: true,
        consecutiveFailures: 0,
        lastTickAt: "2026-06-19T00:00:00.000Z",
        orphans: { observations: 3 },
      }),
      reconcile: async () => ({
        scannedFiles: 0,
        scannedLines: 0,
        replayed: 0,
        rebuilt: 0,
        pruned: 0,
        skipped: 0,
        errors: 0,
      }),
    });

    const res = await app.request("/api/memory/health", { headers: auth });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ltm: {
        reachable: true,
        consecutiveFailures: 0,
        lastTickAt: "2026-06-19T00:00:00.000Z",
        orphans: { observations: 3 },
      },
    });
  });

  test("omits orphan health when the reconciler has not computed it yet", async () => {
    memory.attachReconciler({
      health: () => ({ reachable: true, consecutiveFailures: 0 }),
      reconcile: async () => ({
        scannedFiles: 0,
        scannedLines: 0,
        replayed: 0,
        rebuilt: 0,
        pruned: 0,
        skipped: 0,
        errors: 0,
      }),
    });

    const res = await app.request("/api/memory/health", { headers: auth });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ltm: { reachable: true, consecutiveFailures: 0 },
    });
  });

  test("returns null LTM health when no reconciler is attached", async () => {
    const res = await app.request("/api/memory/health", { headers: auth });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ltm: null });
  });

  test("requires a bearer token", async () => {
    const res = await app.request("/api/memory/health");

    expect(res.status).toBe(401);
  });
});
