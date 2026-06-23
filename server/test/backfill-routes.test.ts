import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PiAuthStore } from "../src/pi-auth.ts";
import { PersonaStore } from "../src/persona.ts";
import { createApp, type AppDeps } from "../src/server.ts";
import { WorkdirStore, resolveWorkdir } from "../src/workdirs.ts";
import * as memory from "../src/memory/index.ts";
import { makeManager, setupFaux } from "./helpers.ts";

let faux: ReturnType<typeof setupFaux>;
let deps: AppDeps;
let app: ReturnType<typeof createApp>["app"];
let tmpData: string;
let backfillDir: string;
const tmpdirs: string[] = [];

beforeEach(() => {
  faux = setupFaux();
  tmpData = mkdtempSync(join(tmpdir(), "backfill-routes-"));
  tmpdirs.push(tmpData);
  const workdirs = new WorkdirStore(`${tmpData}/workdirs`);
  const made = makeManager(faux, {
    dataDir: tmpData,
    resolveWorkdir: (sessionId) => resolveWorkdir(workdirs, sessionId, tmpData),
  });
  deps = {
    manager: made.manager,
    taskManager: made.taskManager,
    scheduler: made.scheduler,
    indexer: made.indexer,
    bus: made.bus,
    persona: new PersonaStore(`${tmpData}/persona`),
    config: {
      port: 0,
      host: "127.0.0.1",
      dataDir: tmpData,
      authToken: "test-token",
      defaultModel: "faux/faux",
      webDistDir: "/tmp/nonexistent",
      generateTitles: false,
      contextFiles: false,
      sandbox: true,
      piAuthPath: `${tmpData}/no-auth.json`,
      subagentModel: "faux/faux",
      taskConcurrency: 4,
      taskTimeoutMinutes: 15,
    },
    authStore: new PiAuthStore(`${tmpData}/no-auth.json`),
    workdirs,
  };
  app = createApp(deps).app;

  backfillDir = mkdtempSync(join(tmpdir(), "backfill-fixtures-"));
  tmpdirs.push(backfillDir);
  for (let i = 0; i < 3; i++) {
    const sid = `019eb000-0000-7000-0000-00000000004${i}`;
    writeFileSync(
      join(backfillDir, `2026-06-10T00-00-00-000Z_${sid}.jsonl`),
      JSON.stringify({
        type: "session",
        version: 3,
        id: sid,
        timestamp: "2026-06-10T00:00:00.000Z",
        cwd: "chat",
      }) + "\n",
    );
  }
});

afterEach(() => {
  memory.attachLtm(null);
  faux.unregister();
  while (tmpdirs.length) {
    const d = tmpdirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort tmpdir cleanup
    }
  }
});

describe("admin backfill routes", () => {
  test("POST requires Bearer auth", async () => {
    const res = await app.request("/api/admin/ltm-backfill", {
      method: "POST",
      body: JSON.stringify({ dir: backfillDir }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  test("POST returns 503 when LTM is not attached", async () => {
    memory.attachLtm(null);
    const res = await app.request("/api/admin/ltm-backfill", {
      method: "POST",
      body: JSON.stringify({ dir: backfillDir }),
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
    });
    expect(res.status).toBe(503);
  });

  test("POST returns 400 when dir is missing", async () => {
    memory.attachLtm({
      ingestSessionFile: async () => ({ sessionsSeen: 0, turnsIngested: 0, recordsCreated: 0, warnings: [] }),
    } as never);
    const res = await app.request("/api/admin/ltm-backfill", {
      method: "POST",
      body: JSON.stringify({}),
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
    });
    expect(res.status).toBe(400);
  });

  test("full lifecycle: POST returns jobId, GET returns progress, DELETE cancels", async () => {
    memory.attachLtm({
      ingestSessionFile: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { sessionsSeen: 1, turnsIngested: 1, recordsCreated: 1, warnings: [] };
      },
    } as never);
    const postRes = await app.request("/api/admin/ltm-backfill", {
      method: "POST",
      body: JSON.stringify({ dir: backfillDir, ratePerSec: 100, batchSize: 10, pauseMs: 0 }),
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    });
    expect(postRes.status).toBe(200);
    const { jobId } = (await postRes.json()) as { jobId: string };
    expect(jobId).toMatch(/^backfill-/);

    const getRes = await app.request(`/api/admin/ltm-backfill/${jobId}`, {
      headers: { authorization: "Bearer test-token" },
    });
    expect(getRes.status).toBe(200);
    const progress = (await getRes.json()) as {
      jobId: string;
      processed: number;
      total: number;
      warnings: string[];
    };
    expect(progress).toMatchObject({ jobId });
    expect(typeof progress.processed).toBe("number");
    expect(typeof progress.total).toBe("number");
    expect(Array.isArray(progress.warnings)).toBe(true);

    const delRes = await app.request(`/api/admin/ltm-backfill/${jobId}`, {
      method: "DELETE",
      headers: { authorization: "Bearer test-token" },
    });
    expect(delRes.status).toBe(204);
  });

  test("POST returns 409 when a job is already running", async () => {
    memory.attachLtm({
      ingestSessionFile: async () => {
        await new Promise((r) => setTimeout(r, 100));
        return { sessionsSeen: 1, turnsIngested: 0, recordsCreated: 1, warnings: [] };
      },
    } as never);
    const first = await app.request("/api/admin/ltm-backfill", {
      method: "POST",
      body: JSON.stringify({ dir: backfillDir }),
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    });
    expect(first.status).toBe(200);
    const { jobId } = (await first.json()) as { jobId: string };
    const second = await app.request("/api/admin/ltm-backfill", {
      method: "POST",
      body: JSON.stringify({ dir: backfillDir }),
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    });
    expect(second.status).toBe(409);
    await app.request(`/api/admin/ltm-backfill/${jobId}`, {
      method: "DELETE",
      headers: { authorization: "Bearer test-token" },
    });
  });

  test("concurrent POSTs: only one wins; the others get 409 (no race)", async () => {
    memory.attachLtm({
      ingestSessionFile: async () => {
        await new Promise((r) => setTimeout(r, 100));
        return { sessionsSeen: 1, turnsIngested: 1, recordsCreated: 1, warnings: [] };
      },
    } as never);
    // Fire 3 POSTs concurrently with Promise.all — they all race through the
    // body parse simultaneously. Only ONE should succeed; the rest must 409.
    const reqs = Array.from({ length: 3 }, () =>
      app.request("/api/admin/ltm-backfill", {
        method: "POST",
        body: JSON.stringify({ dir: backfillDir, ratePerSec: 100, batchSize: 10, pauseMs: 0 }),
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      }),
    );
    const responses = await Promise.all(reqs);
    const okCount = responses.filter((r) => r.status === 200).length;
    const conflictCount = responses.filter((r) => r.status === 409).length;
    expect(okCount).toBe(1);
    expect(conflictCount).toBe(2);
  });

  test("GET returns 404 for unknown jobId", async () => {
    const res = await app.request("/api/admin/ltm-backfill/backfill-bogus-id", {
      headers: { authorization: "Bearer test-token" },
    });
    expect(res.status).toBe(404);
  });
});
