# PWA Tier-2 offline shell — implementation plan

> Execute with the `develop` skill, task-by-task.

**Goal:** ship a hand-rolled service worker so the installed PWA opens its app shell offline, with correct cache-versioning, silent-update activation, and a cache-control header story that prevents the SW from getting stuck on its own first install.

**Spec:** `docs/plans/2026-06-14-pwa-tier2-offline-shell-design.md`

**Architecture:** Plain-JS service worker at `web/public/sw.js`, served as-is (no bundler). Cache-first for the shell + manifest + icons; pass-through (network-only) for `/api/*` and non-GET. Registration in `web/src/main.tsx`, gated on `serviceWorker in navigator && import.meta.env.PROD`. Server adds explicit `Cache-Control: no-cache` for `/sw.js`, `/index.html`, and `/manifest.webmanifest` so the update flow works.

**Tech Stack:** Service Worker API (plain JS, no Workbox), Vite (already in play, owns asset hashing), Hono `@hono/node-server` `serveStatic` (already serving the web bundle), vitest (server tests), `node:test` (web source-text tests, same pattern as `pwa-manifest.test.mjs`).

**Worktree:** `/home/bjk/projects/.worktrees/pwa-tier2-sw`

**Branch:** `feat/pwa-tier2-sw`

---

## Task 1: write the service worker (`web/public/sw.js`)

**Files:**
- Create: `web/public/sw.js`

### Step 1: Write the SW

Create `web/public/sw.js` with this exact content:

```javascript
// ytsejam offline shell service worker.
//
// Caches the static app shell (HTML + Vite-hashed assets + icons + manifest)
// so the installed PWA opens offline. Bypasses /api/* and non-GET requests
// (the agent backend is real-time; cached LLM replies are gibberish).
//
// See docs/plans/2026-06-14-pwa-tier2-offline-shell-design.md for design notes.
// Bump CACHE_VERSION when the SW's caching policy changes (NOT on every deploy
// — Vite asset hashes already cover content changes).

const CACHE_VERSION = "v1";
const CACHE_NAME = `ytsejam-shell-${CACHE_VERSION}`;

// Network-only routes — never cache.
function isBypass(url) {
  if (url.pathname.startsWith("/api/")) return true;
  return false;
}

self.addEventListener("install", (event) => {
  // Take over as soon as install completes — don't wait for old tabs to close.
  // Vite hashed assets are immutable, so silent takeover can't cause a stale
  // asset reference in a live tab.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop any old cache versions left behind by a previous SW.
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith("ytsejam-shell-") && n !== CACHE_NAME)
          .map((n) => caches.delete(n)),
      );
      // Claim every open client so they start using this SW immediately.
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // non-GET passes through to network
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // cross-origin passes through
  if (isBypass(url)) return; // /api/* passes through

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      if (cached) {
        // Refresh in background so the cache stays warm with the latest bytes.
        // Failures are silent — we already returned a usable response.
        event.waitUntil(
          fetch(req)
            .then((res) => {
              if (res && res.ok) return cache.put(req, res.clone());
            })
            .catch(() => {}),
        );
        return cached;
      }
      // No cache hit: fetch, cache on success, return.
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          // clone() because the response body is a one-shot stream.
          cache.put(req, res.clone()).catch(() => {});
        }
        return res;
      } catch (err) {
        // Offline + cold cache: nothing we can do, let the browser fail.
        throw err;
      }
    })(),
  );
});
```

### Step 2: Verify it parses

```bash
cd /home/bjk/projects/.worktrees/pwa-tier2-sw/web
env -u NODE_ENV node --check public/sw.js
```

Expected: silent success (exit 0).

### Step 3: Commit

```bash
git add web/public/sw.js
git commit -m "feat(web): add offline-shell service worker (sw.js)

Hand-rolled SW for the installed PWA: cache-first for the static
shell, network-only for /api/* and non-GET, silent skipWaiting +
clients.claim on activate, drops old cache versions.

See docs/plans/2026-06-14-pwa-tier2-offline-shell-design.md for
rationale (cache-first vs network-first, runtime population vs
build-time precache, hand-bumped CACHE_VERSION vs auto-hash)."
```

---

## Task 2: SW source-text tests (`web/test/sw.test.mjs`)

**Files:**
- Create: `web/test/sw.test.mjs`
- Modify: `web/test/run.mjs` (add the new file to the test list)

### Step 1: Find how `run.mjs` registers test files

```bash
cd /home/bjk/projects/.worktrees/pwa-tier2-sw
cat web/test/run.mjs
```

Note the existing entries (`pwa-manifest.test.mjs` is one) so the new file follows the same shape.

### Step 2: Write the test file

Create `web/test/sw.test.mjs`:

```javascript
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const swPath = join(root, "public/sw.js");

function readSwCodeOnly() {
  const raw = readFileSync(swPath, "utf8");
  return raw
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/\/\/[^\n]*/g, "");
}

test("sw.js exists in web/public/", () => {
  assert.ok(existsSync(swPath), `expected sw.js at ${swPath}`);
});

test("sw.js parses as valid JavaScript", () => {
  // node --check would catch this in CI, but the gate runs the suite without
  // a separate parse step; assert it here so a syntactically-broken SW
  // can't ship green.
  const raw = readFileSync(swPath, "utf8");
  // Function constructor in strict mode catches parse errors that import()
  // would also catch, without actually evaluating self/caches/etc.
  assert.doesNotThrow(
    () => new Function(raw),
    "sw.js failed to parse — fix the syntax error before shipping",
  );
});

test("sw.js declares a versioned cache name (CACHE_NAME = `ytsejam-shell-...`)", () => {
  // Version-named caches let the activate handler drop old ones without
  // wiping the user's warm cache during a same-version reload.
  const src = readSwCodeOnly();
  assert.match(
    src,
    /const\s+CACHE_NAME\s*=\s*`ytsejam-shell-/,
    "sw.js must declare CACHE_NAME as a `ytsejam-shell-${version}` template literal so the activate handler can target sibling versions",
  );
});

test("sw.js install handler calls skipWaiting() so updates land on next nav", () => {
  // Without skipWaiting, a new SW sits in 'waiting' state until every tab
  // using the old SW closes — for an installed PWA that the user keeps
  // open, updates would never land. Vite hashed assets are immutable so
  // silent takeover is safe.
  const src = readSwCodeOnly();
  assert.match(
    src,
    /addEventListener\(["']install["']/,
    "sw.js must register an install handler",
  );
  assert.match(
    src,
    /skipWaiting\(\)/,
    "sw.js install handler must call self.skipWaiting() for prompt updates",
  );
});

test("sw.js activate handler claims clients and drops stale cache versions", () => {
  const src = readSwCodeOnly();
  assert.match(
    src,
    /addEventListener\(["']activate["']/,
    "sw.js must register an activate handler",
  );
  assert.match(
    src,
    /clients\.claim\(\)/,
    "sw.js activate handler must call self.clients.claim() to take over open tabs",
  );
  assert.match(
    src,
    /caches\.keys\(\)/,
    "sw.js activate handler must enumerate caches.keys() to find old versions",
  );
  assert.match(
    src,
    /caches\.delete\(/,
    "sw.js activate handler must delete old cache versions",
  );
});

test("sw.js fetch handler bypasses /api/* (real-time agent, cached replies are gibberish)", () => {
  // The agent backend is conversational — a cached LLM reply is wrong by
  // definition. /api/* must pass through to network every time.
  const src = readSwCodeOnly();
  assert.match(
    src,
    /pathname\.startsWith\(["']\/api\/["']\)/,
    "sw.js must bypass /api/* in its fetch handler (real-time, no cache)",
  );
});

test("sw.js fetch handler bypasses non-GET requests", () => {
  // POST/PUT/DELETE etc. mutate server state; the SW cache layer would
  // hide responses and serve stale 200s. Only GET is cacheable.
  const src = readSwCodeOnly();
  assert.match(
    src,
    /method\s*!==\s*["']GET["']/,
    "sw.js fetch handler must short-circuit on non-GET requests",
  );
});

test("sw.js fetch handler bypasses cross-origin requests", () => {
  // The SW's scope is same-origin by registration, but the fetch event
  // sees cross-origin requests from <img>, <script type='module'> with
  // CDN imports, etc. Caching them is out of scope; pass through.
  const src = readSwCodeOnly();
  assert.match(
    src,
    /url\.origin\s*!==\s*self\.location\.origin/,
    "sw.js fetch handler must pass through cross-origin requests",
  );
});

test("sw.js uses cache-first (cache.match before fetch) for cacheable GETs", () => {
  // Cache-first means instant loads when warm; the design rejects
  // network-first because every load would pay a round-trip even online.
  // Anchor on caches.open + cache.match appearing in the fetch handler.
  const src = readSwCodeOnly();
  // The two calls must both exist, AND cache.match must appear textually
  // before the bare `fetch(req)` call inside the fetch event handler.
  const openIdx = src.indexOf("caches.open(CACHE_NAME)");
  const matchIdx = src.indexOf("cache.match(req)");
  assert.ok(openIdx !== -1, "sw.js must caches.open(CACHE_NAME) in the fetch handler");
  assert.ok(matchIdx !== -1, "sw.js must call cache.match(req) in the fetch handler");
  assert.ok(
    openIdx < matchIdx,
    "caches.open must precede cache.match (cache-first strategy)",
  );
});

test("sw.js calls response.clone() before caching (one-shot body stream)", () => {
  // A Response body is a one-shot stream. Without clone(), returning the
  // response AND caching it would consume the body twice and crash.
  const src = readSwCodeOnly();
  assert.match(
    src,
    /res\.clone\(\)/,
    "sw.js must call res.clone() before cache.put — Response bodies are one-shot",
  );
});
```

### Step 3: Add the file to `run.mjs`

```bash
cd /home/bjk/projects/.worktrees/pwa-tier2-sw
# Read current run.mjs and add 'sw.test.mjs' to the file list in the same
# shape as 'pwa-manifest.test.mjs'. If run.mjs uses readdirSync, no edit
# needed.
grep -nE "pwa-manifest|test\.mjs|readdir" web/test/run.mjs
```

If `run.mjs` enumerates files via `readdirSync`, no edit is needed (new file picked up automatically). If it lists files explicitly, add `sw.test.mjs` to the list alongside `pwa-manifest.test.mjs`.

### Step 4: Run the test file

```bash
cd /home/bjk/projects/.worktrees/pwa-tier2-sw/web
env -u NODE_ENV node test/sw.test.mjs
```

Expected: all 10 tests PASS.

### Step 5: Run the full web suite to confirm no regression

```bash
cd /home/bjk/projects/.worktrees/pwa-tier2-sw/web
env -u NODE_ENV node test/run.mjs
```

Expected: 66 (pre-existing from main) + 10 (new) = 76 tests, all PASS.

### Step 6: Mutation-test each invariant

For each of the following, remove the named feature from `web/public/sw.js`, re-run `node test/sw.test.mjs`, confirm the named test fails, then `git checkout web/public/sw.js`:

| mutation | should fail |
|---|---|
| change `CACHE_NAME` to a plain string `"ytsejam-shell"` (no template literal) | "declares a versioned cache name" |
| remove `self.skipWaiting()` from install | "install handler calls skipWaiting" |
| remove `self.clients.claim()` from activate | "activate handler claims clients" |
| remove the `caches.delete` loop | "activate handler...drops stale cache versions" |
| remove the `/api/` bypass | "fetch handler bypasses /api/" |
| remove the `method !== "GET"` check | "fetch handler bypasses non-GET" |
| remove the cross-origin check | "fetch handler bypasses cross-origin" |
| swap `cache.match` BEFORE `caches.open` (i.e. swap to network-first) | "uses cache-first" |
| remove `res.clone()` | "calls response.clone() before caching" |

Re-run `node test/sw.test.mjs` after restore to confirm green at 10/10.

### Step 7: Commit

```bash
git add web/test/sw.test.mjs web/test/run.mjs
git commit -m "test(web): source-text + structural tests for sw.js

10 tests covering: file exists, parses, versioned cache name,
install/skipWaiting, activate/claim/delete-old, fetch bypasses
(/api/, non-GET, cross-origin), cache-first ordering, response
clone before put. All mutation-tested (each invariant fails its
named test when removed).

Pattern mirrors web/test/pwa-manifest.test.mjs: node:test, source
regex assertions with comment-stripping helper, no behavioral
runtime (test stack has no SW environment)."
```

---

## Task 3: register the SW in `web/src/main.tsx`

**Files:**
- Modify: `web/src/main.tsx`

### Step 1: Inspect `main.tsx`

```bash
cd /home/bjk/projects/.worktrees/pwa-tier2-sw
cat web/src/main.tsx
```

Identify the end of the file (after the React root render call) — the SW registration block goes there.

### Step 2: Add the registration block

Append to `web/src/main.tsx`:

```typescript
// PWA offline shell — register the service worker in prod builds.
// Gated on import.meta.env.PROD so dev never gets one (Vite dev server
// doesn't serve sw.js anyway, but explicit beats implicit).
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      // Registration failure is non-fatal: the app still works, just
      // without offline shell. Log so production breakage is visible
      // in devtools without crashing the app.
      console.warn("[pwa] service worker registration failed:", err);
    });
  });
}
```

### Step 3: Typecheck

```bash
cd /home/bjk/projects/.worktrees/pwa-tier2-sw/web
env -u NODE_ENV npx tsc -b
```

Expected: silent success.

### Step 4: Build

```bash
cd /home/bjk/projects/.worktrees/pwa-tier2-sw/web
env -u NODE_ENV npx vite build
```

Expected: silent success. Confirms the import.meta.env.PROD branch type-checks under Vite's env-module shape.

### Step 5: Verify `sw.js` is in `dist/`

```bash
ls -la /home/bjk/projects/.worktrees/pwa-tier2-sw/web/dist/sw.js
```

Expected: file present (Vite copies `public/*` to `dist/` as-is).

### Step 6: Add a source-text test that asserts the registration block exists

Append this test to `web/test/sw.test.mjs`:

```javascript
test("main.tsx registers /sw.js, gated on serviceWorker support + PROD build", () => {
  // SW registration must be opt-in to prod: dev mode (Vite dev server)
  // doesn't ship a sw.js, and any dev-mode registration would 404 or
  // worse, register a wildly stale dev artifact.
  const mainSrc = readFileSync(join(root, "src/main.tsx"), "utf8")
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/\/\/[^\n]*/g, "");
  assert.match(
    mainSrc,
    /serviceWorker["\s]+in\s+navigator/,
    "main.tsx must feature-detect serviceWorker before registering",
  );
  assert.match(
    mainSrc,
    /import\.meta\.env\.PROD/,
    "main.tsx must gate SW registration on import.meta.env.PROD (no SW in dev)",
  );
  assert.match(
    mainSrc,
    /navigator\.serviceWorker\.register\(["']\/sw\.js["']\)/,
    "main.tsx must register /sw.js (not a hashed path)",
  );
});
```

### Step 7: Run the suite

```bash
cd /home/bjk/projects/.worktrees/pwa-tier2-sw/web
env -u NODE_ENV node test/sw.test.mjs
```

Expected: 11 tests PASS.

### Step 8: Mutation-test

| mutation | should fail |
|---|---|
| remove `"serviceWorker" in navigator` check | "main.tsx must feature-detect serviceWorker" |
| remove `import.meta.env.PROD` gate | "main.tsx must gate SW registration on import.meta.env.PROD" |
| change `/sw.js` to `/service-worker.js` | "main.tsx must register /sw.js" |

Restore after each.

### Step 9: Commit

```bash
git add web/src/main.tsx web/test/sw.test.mjs
git commit -m "feat(web): register sw.js on load in prod builds

Gated on (serviceWorker in navigator) AND import.meta.env.PROD so
dev never registers. Failure is logged (devtools warning) but
non-fatal — app still works, just without offline shell.

Test asserts feature-detect + PROD gate + correct /sw.js path."
```

---

## Task 4: server cache-control headers for `/sw.js`, `/index.html`, `/manifest.webmanifest`

**Files:**
- Modify: `server/src/server.ts`
- Create: `server/test/cache-headers.test.ts`

### Step 1: Inspect current static-serving block

```bash
cd /home/bjk/projects/.worktrees/pwa-tier2-sw
sed -n '230,245p' server/src/server.ts
```

The two `app.use("/*", serveStatic(...))` lines are at the bottom of the app builder.

### Step 2: Add explicit cache-control middleware BEFORE serveStatic

In `server/src/server.ts`, immediately before the `// static web app` comment block (around line 235), insert this middleware:

```typescript
  // Cache-control for files whose freshness matters for the PWA update flow:
  //   - sw.js MUST revalidate every request, or the browser caches the old
  //     service worker and never sees deploys.
  //   - index.html MUST revalidate so updated bundle hashes are picked up.
  //   - manifest.webmanifest MUST revalidate so shortcut/icon edits land.
  // We set this BEFORE serveStatic so the header sticks on the response
  // before the static handler serves the body.
  app.use("/sw.js", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-cache");
  });
  app.use("/index.html", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-cache");
  });
  app.use("/manifest.webmanifest", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-cache");
  });
```

### Step 3: Typecheck

```bash
cd /home/bjk/projects/.worktrees/pwa-tier2-sw/server
env -u NODE_ENV npx tsc --noEmit
```

Expected: silent success.

### Step 4: Write the test

Create `server/test/cache-headers.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../src/server.js";
// Reuse the same test-deps shape other server tests use; this import path
// may need adjustment based on what's already in server/test/.

// We need a fake webDist with a sw.js + index.html + manifest.webmanifest so
// serveStatic actually has a body to return.
let webDistDir: string;

beforeAll(() => {
  webDistDir = mkdtempSync(join(tmpdir(), "ytsejam-cache-headers-"));
  writeFileSync(join(webDistDir, "sw.js"), "/* fake sw */\n");
  writeFileSync(join(webDistDir, "index.html"), "<!doctype html><title>x</title>\n");
  writeFileSync(join(webDistDir, "manifest.webmanifest"), '{"name":"x"}\n');
});

afterAll(() => {
  rmSync(webDistDir, { recursive: true, force: true });
});

describe("cache-control headers for PWA correctness", () => {
  // Test stub: each case fetches the named path via app.request() and
  // asserts the Cache-Control header. The exact `buildApp` deps signature
  // depends on what's already in server/test/ — match the smallest
  // existing test's pattern (e.g. cog.test.ts, server.test.ts).
  it("serves /sw.js with Cache-Control: no-cache", async () => {
    // Implementer: assemble buildApp with webDistDir set to webDistDir
    // above, then await app.request("/sw.js"); assert
    // res.headers.get("cache-control") === "no-cache".
    expect.fail("stub — implement using existing buildApp test harness shape");
  });

  it("serves /index.html with Cache-Control: no-cache", async () => {
    expect.fail("stub — implement using existing buildApp test harness shape");
  });

  it("serves /manifest.webmanifest with Cache-Control: no-cache", async () => {
    expect.fail("stub — implement using existing buildApp test harness shape");
  });

  it("does NOT set no-cache on arbitrary other static paths (e.g. /assets/index-abc.js)", async () => {
    // Negative test: assets/* should NOT get the no-cache treatment
    // (they're content-hashed; immutable headers are a separate PR but
    // we mustn't accidentally over-broaden the rule).
    expect.fail("stub — implement using existing buildApp test harness shape");
  });
});
```

**Implementer note:** the `buildApp` signature and the way other server tests assemble it (config + dependencies) differs across the codebase. Before fleshing out the stubs, run `grep -rn "buildApp\|createServer\|new Hono" server/test/ server/src/ | head -20` to find the smallest existing test that exercises the HTTP layer and copy its setup shape. Replace `expect.fail(...)` with the real `app.request(...)` calls + header assertions.

### Step 5: Run server tests

```bash
cd /home/bjk/projects/.worktrees/pwa-tier2-sw/server
env -u NODE_ENV npx vitest run test/cache-headers.test.ts
```

Expected: 4 tests PASS.

### Step 6: Mutation-test

| mutation | should fail |
|---|---|
| remove the `/sw.js` middleware | "serves /sw.js with Cache-Control: no-cache" |
| remove the `/index.html` middleware | "serves /index.html with Cache-Control: no-cache" |
| remove the `/manifest.webmanifest` middleware | "serves /manifest.webmanifest with Cache-Control: no-cache" |
| broaden to `app.use("/*", ...)` | "does NOT set no-cache on arbitrary other static paths" |

Restore after each.

### Step 7: Commit

```bash
git add server/src/server.ts server/test/cache-headers.test.ts
git commit -m "feat(server): no-cache headers for sw.js, index.html, manifest

Required for the PWA Tier-2 update flow: without these, the
browser HTTP-caches the SW (and the HTML referencing the new
asset hashes) and the user never sees a deploy.

Narrowly scoped to the three files whose freshness matters for
correctness; immutable headers for /assets/* (content-hashed)
are a separate optimization PR."
```

---

## Task 5: full gate + branch verification

### Step 1: Run the gate

```bash
cd /home/bjk/projects/.worktrees/pwa-tier2-sw
env -u NODE_ENV bash scripts/gate.sh
```

Expected: `=== gate: PASSED ===`, with web tests at 76 (66 pre-existing + 10 new in sw.test.mjs + 1 added in Task 3) and server tests at 482 (478 pre-existing + 4 new in cache-headers.test.ts).

### Step 2: Verify the branch commit graph

```bash
cd /home/bjk/projects/.worktrees/pwa-tier2-sw
git log --oneline 3362e90..HEAD
```

Expected: 4 commits (Task 1, Task 2, Task 3, Task 4), each touching only the files named in its task.

### Step 3: Push the branch

```bash
cd /home/bjk/projects/.worktrees/pwa-tier2-sw
git push -u origin feat/pwa-tier2-sw
```

### Step 4: Hand off to /review for cross-model spec + quality

`/review` skill — same Opus reviewer used in PR #131. Spec compliance first, then quality. Seed the quality brief with these self-audit concerns:

1. **`event.waitUntil(self.skipWaiting())`** — `skipWaiting` returns a Promise, and the install handler wrapping it in `waitUntil` is correct, but is there a subtle gotcha when the install fails partway?
2. **Background refresh `event.waitUntil(fetch(...).then(...))`** — the cache-update-after-return pattern works, but does a slow background fetch keep the SW alive longer than expected and affect any other lifecycle?
3. **`cache.put` on a partial/erroring response** — guarded by `res.ok` check, but does any 3xx redirect chain produce a response that's `ok: true` but contains an unusable body?
4. **Server middleware order** — the new `app.use("/sw.js", ...)` etc. come BEFORE `app.use("/*", serveStatic(...))`. Is Hono's middleware ordering such that `await next()` correctly chains into the serveStatic handler and the header lands on its response?
5. **Test stub `expect.fail` in Task 4** — the implementer is told to flesh these out; if they don't, the test passes-via-throw (vitest counts a failing test as failure, but does the implementer "complete" the task without filling in the body? Brief them clearly).
6. **`new Function(raw)`** for parsing in Task 2 — is this strict enough to catch top-level await or other modern syntax issues? Or is `node --check` a better proxy?

After /review passes:

### Step 5: Open PR + merge

`/ship` skill or manual:

```bash
gh pr create --title "feat: PWA Tier-2 offline shell (service worker)" --body "(plan reference + spec link + cross-model review summary)"
gh pr merge --squash --delete-branch
```

### Step 6: Cleanup + cog hygiene

```bash
git worktree remove /home/bjk/projects/.worktrees/pwa-tier2-sw
cd /home/bjk/projects/ytsejam
git pull --ff-only origin main
```

Then dev-log entry + observations + close any related issues.

### Step 7: Manual smoke (post-merge, on Brian's actual install)

Brian, on the installed PWA:
1. Open devtools → Application → Service Workers; confirm `sw.js` is registered, activated.
2. Application → Cache Storage; confirm `ytsejam-shell-v1` is populated after a navigation or two.
3. Devtools → Network → throttling → Offline.
4. Reload the PWA. App shell should render; WS should show disconnected.
5. Restore network. App should reconnect (existing WS watchdog from #116).

Report any issues — they become Tier-2.1 fixes, not blockers on the merge.

---

## Out of scope (deliberately, documented)

- Immutable cache headers for `/assets/*` (content-hashed, would be an optimization PR)
- Update-available banner UI (needs UI design; Tier 2++)
- Workbox or any precache library (runtime cache is simpler and fits this app)
- Background sync (Tier 3) — incoherent for synchronous-agent UX
- Push notifications (Tier 4) — Notification API already covers tab-open
- Offline fallback page (the cached shell IS the fallback)
