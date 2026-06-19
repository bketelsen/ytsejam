import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PiAuthStore } from "../src/pi-auth.ts";
import { PersonaStore } from "../src/persona.ts";
import { createApp, type AppDeps } from "../src/server.ts";
import { WorkdirStore, resolveWorkdir, recentWorkdirs } from "../src/workdirs.ts";
import { makeManager, setupFaux } from "./helpers.ts";

let faux: ReturnType<typeof setupFaux>;
let deps: AppDeps;
let app: ReturnType<typeof createApp>["app"];
let workdirs: WorkdirStore;
let tmpData: string;
let memoryRootDir: string;

beforeEach(() => {
  faux = setupFaux();
  tmpData = mkdtempSync(join(tmpdir(), "wd-sugg-"));
  memoryRootDir = join(tmpData, "memory");
  mkdirSync(memoryRootDir, { recursive: true });

  workdirs = new WorkdirStore(join(tmpData, "workdirs"));

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
    persona: new PersonaStore(join(tmpData, "persona")),
    config: {
      port: 0,
      host: "127.0.0.1",
      dataDir: tmpData,
      authToken: "test-token",
      defaultModel: "faux/faux",
      webDistDir: "/tmp/nonexistent",
      generateTitles: false,
      piAuthPath: join(tmpData, "no-auth.json"),
      subagentModel: "faux/faux",
      taskConcurrency: 4,
      taskTimeoutMinutes: 15,
      contextFiles: false,
    },
    authStore: new PiAuthStore(join(tmpData, "no-auth.json")),
    workdirs,
    memoryRootDir,
  };
  app = createApp(deps).app;
});

afterEach(() => faux.unregister());

const auth = { Authorization: "Bearer test-token" };

describe("GET /api/workdirs/suggestions", () => {
  test("requires auth", async () => {
    const res = await app.request("/api/workdirs/suggestions");
    expect(res.status).toBe(401);
  });

  test("returns empty knownProjects and recent when no data", async () => {
    const res = await app.request("/api/workdirs/suggestions", { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ knownProjects: [], recent: [] });
  });

  test("knownProjects reflects domains with workingDir", async () => {
    // Seed a domains.yml with one domain that has a workingDir
    writeFileSync(
      join(memoryRootDir, "domains.yml"),
      [
        "domains:",
        "  - id: myproject",
        "    path: myproject",
        "    label: My Project",
        "    workingDir: /home/user/myproject",
        "  - id: nodir",
        "    path: nodir",
      ].join("\n"),
    );

    // Recreate app with fresh deps so it picks up the new domains.yml
    app = createApp({ ...deps, memoryRootDir }).app;

    const res = await app.request("/api/workdirs/suggestions", { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.knownProjects).toEqual([
      { path: "/home/user/myproject", label: "My Project" },
    ]);
    // the "nodir" domain must NOT appear
    expect(body.knownProjects).toHaveLength(1);
  });

  test("knownProjects uses domain id as label when label is absent", async () => {
    writeFileSync(
      join(memoryRootDir, "domains.yml"),
      [
        "domains:",
        "  - id: nolabel",
        "    path: nolabel",
        "    workingDir: /srv/nolabel",
      ].join("\n"),
    );

    app = createApp({ ...deps, memoryRootDir }).app;
    const res = await app.request("/api/workdirs/suggestions", { headers: auth });
    const body = (await res.json()) as any;
    expect(body.knownProjects).toEqual([{ path: "/srv/nolabel", label: "nolabel" }]);
  });

  test("recent reflects deduped latest workdirs across sessions, excluding dataDir", async () => {
    const wdStoreDir = join(tmpData, "workdirs");
    mkdirSync(wdStoreDir, { recursive: true });

    // Session A: ended at /home/user/alpha
    writeFileSync(
      join(wdStoreDir, "sess-a.jsonl"),
      [
        JSON.stringify({ dir: "/home/user/beta", timestamp: "2026-01-01T10:00:00Z" }),
        JSON.stringify({ dir: "/home/user/alpha", timestamp: "2026-01-01T11:00:00Z" }),
      ].join("\n") + "\n",
    );
    // Session B: ended at /home/user/beta
    writeFileSync(
      join(wdStoreDir, "sess-b.jsonl"),
      JSON.stringify({ dir: "/home/user/beta", timestamp: "2026-01-01T12:00:00Z" }) + "\n",
    );
    // Session C: ended at dataDir (should be excluded)
    writeFileSync(
      join(wdStoreDir, "sess-c.jsonl"),
      JSON.stringify({ dir: tmpData, timestamp: "2026-01-01T09:00:00Z" }) + "\n",
    );

    const res = await app.request("/api/workdirs/suggestions", { headers: auth });
    const body = (await res.json()) as any;

    // /home/user/alpha and /home/user/beta appear; tmpData is excluded
    expect(body.recent).toContain("/home/user/alpha");
    expect(body.recent).toContain("/home/user/beta");
    expect(body.recent).not.toContain(tmpData);
    // deduped: each path appears once
    expect(body.recent.filter((r: string) => r === "/home/user/beta")).toHaveLength(1);
  });
});

describe("recentWorkdirs helper", () => {
  test("returns empty array when store dir is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "rw-"));
    const store = new WorkdirStore(join(dir, "workdirs"));
    expect(recentWorkdirs(store, 10)).toEqual([]);
  });

  test("returns latest event per session, deduped, most-recent first", () => {
    const dir = mkdtempSync(join(tmpdir(), "rw-"));
    const storeDir = join(dir, "workdirs");
    mkdirSync(storeDir, { recursive: true });

    // session-1 last went to /a, session-2 last went to /b (more recent), session-3 also /a
    writeFileSync(
      join(storeDir, "session-1.jsonl"),
      JSON.stringify({ dir: "/a", timestamp: "2026-01-01T10:00:00Z" }) + "\n",
    );
    writeFileSync(
      join(storeDir, "session-2.jsonl"),
      JSON.stringify({ dir: "/b", timestamp: "2026-01-01T12:00:00Z" }) + "\n",
    );
    writeFileSync(
      join(storeDir, "session-3.jsonl"),
      JSON.stringify({ dir: "/a", timestamp: "2026-01-01T11:00:00Z" }) + "\n",
    );

    const store = new WorkdirStore(storeDir);
    const result = recentWorkdirs(store, 10);

    // deduped: /a only once, /b only once
    expect(result).toHaveLength(2);
    // /b is most-recent (12:00) so should be first
    expect(result[0]).toBe("/b");
    expect(result[1]).toBe("/a");
  });

  test("respects limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "rw-"));
    const storeDir = join(dir, "workdirs");
    mkdirSync(storeDir, { recursive: true });

    for (let i = 0; i < 5; i++) {
      writeFileSync(
        join(storeDir, `session-${i}.jsonl`),
        JSON.stringify({ dir: `/path/${i}`, timestamp: `2026-01-0${i + 1}T00:00:00Z` }) + "\n",
      );
    }

    const store = new WorkdirStore(storeDir);
    const result = recentWorkdirs(store, 3);
    expect(result).toHaveLength(3);
  });

  test("excludes specified default dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "rw-"));
    const storeDir = join(dir, "workdirs");
    mkdirSync(storeDir, { recursive: true });
    const defaultDir = "/my/default/datadir";

    writeFileSync(
      join(storeDir, "session-a.jsonl"),
      JSON.stringify({ dir: defaultDir, timestamp: "2026-01-01T10:00:00Z" }) + "\n",
    );
    writeFileSync(
      join(storeDir, "session-b.jsonl"),
      JSON.stringify({ dir: "/real/workdir", timestamp: "2026-01-01T11:00:00Z" }) + "\n",
    );

    const store = new WorkdirStore(storeDir);
    const result = recentWorkdirs(store, 10, defaultDir);
    expect(result).not.toContain(defaultDir);
    expect(result).toContain("/real/workdir");
  });
});
