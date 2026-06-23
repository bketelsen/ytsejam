import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PiAuthStore } from "../src/pi-auth.ts";
import { PersonaStore } from "../src/persona.ts";
import { createApp, type AppDeps } from "../src/server.ts";
import { WorkdirStore, resolveWorkdir } from "../src/workdirs.ts";
import { makeManager, setupFaux } from "./helpers.ts";

let faux: ReturnType<typeof setupFaux>;
let deps: AppDeps;
let app: ReturnType<typeof createApp>["app"];
let workdirs: WorkdirStore;
let webDistDir: string;
let tmpData: string;

beforeEach(() => {
  faux = setupFaux();
  tmpData = mkdtempSync(join(tmpdir(), "cache-headers-data-"));
  webDistDir = mkdtempSync(join(tmpdir(), "cache-headers-web-"));

  // Populate webDist with the three target files + one asset that must
  // NOT get no-cache (used for the negative test).
  writeFileSync(join(webDistDir, "sw.js"), "/* fake sw for test */\n");
  writeFileSync(join(webDistDir, "index.html"), "<!doctype html><title>test</title>\n");
  writeFileSync(join(webDistDir, "manifest.webmanifest"), '{"name":"test","start_url":"/"}\n');

  // Negative-test target — Vite normally puts hashed bundles under /assets/.
  // Create a fake one to confirm the no-cache middleware doesn't over-broaden.
  const assetsDir = join(webDistDir, "assets");
  mkdirSync(assetsDir);
  writeFileSync(join(assetsDir, "index-FAKE_HASH.js"), "console.log('x');\n");

  workdirs = new WorkdirStore(`${tmpData}/workdirs`);
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
    persona: new PersonaStore(`${made.dataDir}/persona`),
    config: {
      port: 0,
      host: "127.0.0.1",
      dataDir: made.dataDir,
      authToken: "test-token",
      defaultModel: "faux/faux",
      webDistDir,
      generateTitles: false,
      piAuthPath: `${made.dataDir}/no-auth.json`,
      subagentModel: "faux/faux",
      taskConcurrency: 4,
      taskTimeoutMinutes: 15,
      contextFiles: false,
      sandbox: true,
    },
    authStore: new PiAuthStore(`${made.dataDir}/no-auth.json`),
    workdirs,
  };
  app = createApp(deps).app;
});

afterEach(() => {
  faux.unregister();
  rmSync(tmpData, { recursive: true, force: true });
  rmSync(webDistDir, { recursive: true, force: true });
});

describe("cache-control headers for PWA correctness", () => {
  test("serves /sw.js with Cache-Control: no-cache", async () => {
    const res = await app.request("/sw.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("serves /index.html with Cache-Control: no-cache", async () => {
    const res = await app.request("/index.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  // Regression for the PWA update-flow bug caught in cross-branch review:
  // browsers and the PWA never request `/index.html` literally — they
  // navigate to `/` and the SPA fallback serves index.html bytes. The
  // middleware matches on REQUEST PATH, not served file, so without an
  // explicit `app.use("/", ...)` the no-cache header never lands on real
  // navigation traffic. Both `/` and `/index.html` must be covered.
  test("serves bare GET / with Cache-Control: no-cache (real browser navigation path)", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  // PWA shortcuts (per Tier-5 manifest) launch with query strings like
  // /?action=tasks. Query strings don't affect Hono path matching, so the
  // `/` rule should cover these — verified by this regression test.
  test("serves PWA shortcut URLs (/?action=tasks) with Cache-Control: no-cache", async () => {
    const res = await app.request("/?action=tasks");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("serves /manifest.webmanifest with Cache-Control: no-cache", async () => {
    const res = await app.request("/manifest.webmanifest");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("does NOT set no-cache on /assets/* (Vite-hashed, separate cache policy)", async () => {
    const res = await app.request("/assets/index-FAKE_HASH.js");
    // If status is 200 and cache-control is null or empty (the default
    // serveStatic behavior), the negative test passes — we did NOT
    // accidentally over-broaden the rule.
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBeNull();
  });
});
