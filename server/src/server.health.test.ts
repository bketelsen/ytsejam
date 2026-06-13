import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { EventBus } from "./events.ts";
import { PiAuthStore } from "./pi-auth.ts";
import { PersonaStore } from "./persona.ts";
import { createApp, type AppDeps } from "./server.ts";
import * as memory from "./memory/index.ts";

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
      webDistDir: "/tmp/nonexistent",
      generateTitles: false,
      piAuthPath: join(dataDir, "no-auth.json"),
      subagentModel: "faux/faux",
      taskConcurrency: 4,
      taskTimeoutMinutes: 15,
      contextFiles: false,
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
      health: () => ({ reachable: true, consecutiveFailures: 0 }),
      reconcile: async () => ({ scannedFiles: 0, scannedLines: 0, replayed: 0, skipped: 0, errors: 0 }),
    });

    const res = await app.request("/api/memory/health", { headers: auth });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ltm: { reachable: true, consecutiveFailures: 0 } });
  });

  test("returns null LTM health when no reconciler is attached", async () => {
    const res = await app.request("/api/memory/health", { headers: auth });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ltm: null });
  });

  test("requires a bearer token", async () => {
    const res = await app.request("/api/memory/health");

    assert.equal(res.status, 401);
  });
});
