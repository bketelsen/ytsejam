import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const swPath = join(root, "public/sw.js");

/**
 * Read sw.js and strip its line and block comments before returning the
 * source text, so file-scope assertions can't be spoofed by explanatory
 * comments that contain the asserted literal.
 *
 * Same source-text testing hazard as pwa-manifest.test.mjs' App.tsx checks:
 * regex assertions are intentionally lightweight and refactor-tolerant, but
 * must not pass because a deleted behavior survives only in prose.
 */
function readSwCodeOnly() {
  const raw = readFileSync(swPath, "utf8");
  return raw
    // Block comments — non-greedy, dot matches newline via [\s\S].
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    // Line comments — to end of line. sw.js does not put `//` inside string
    // literals; if it ever does, switch this helper to an AST-aware parser.
    .replaceAll(/\/\/[^\n]*/g, "");
}

function skipIfSwMissing(t) {
  if (!existsSync(swPath)) {
    t.skip("sw.js missing; existence is tested separately");
    return true;
  }
  return false;
}

// A missing worker silently drops the whole offline-shell tier; keep the
// public-path contract explicit because registration depends on it.
test("sw.js exists in web/public/", () => {
  assert.ok(existsSync(swPath), `expected sw.js at ${swPath}`);
});

// Browser SW registration fails hard on syntax errors; catch that at source
// before installability/offline behavior can regress in production.
test("sw.js parses as JavaScript", (t) => {
  if (skipIfSwMissing(t)) return;
  const raw = readFileSync(swPath, "utf8");
  assert.doesNotThrow(() => new Function(raw), "sw.js must parse as JavaScript");
});

// Versioned cache names are what let activate distinguish current shell bytes
// from old ones and safely evict stale caches.
test("sw.js declares a versioned ytsejam shell CACHE_NAME template literal", (t) => {
  if (skipIfSwMissing(t)) return;
  const src = readSwCodeOnly();
  assert.match(
    src,
    /const\s+CACHE_NAME\s*=\s*`ytsejam-shell-\$\{[^}]+\}`\s*;/,
    "CACHE_NAME must be a versioned `ytsejam-shell-${...}` template literal",
  );
});

// skipWaiting should not be coupled to precache lifetime: the reviewed SW
// deliberately calls it bare so a precache rejection cannot poison takeover.
test("install handler calls skipWaiting bare, outside waitUntil", (t) => {
  if (skipIfSwMissing(t)) return;
  const src = readSwCodeOnly();
  const installStart = src.indexOf('self.addEventListener("install"');
  const activateStart = src.indexOf('self.addEventListener("activate"');
  assert.ok(installStart !== -1 && activateStart !== -1, "sw.js must define install and activate handlers");
  const installSrc = src.slice(installStart, activateStart);
  const skipIdx = installSrc.indexOf("self.skipWaiting()");
  const waitUntilIdx = installSrc.indexOf("event.waitUntil(");
  assert.ok(skipIdx !== -1, "install handler must call self.skipWaiting() (bare)");
  assert.ok(
    waitUntilIdx === -1 || skipIdx < waitUntilIdx,
    "install handler must call self.skipWaiting() bare before event.waitUntil precache work",
  );
});

// Precached `/` is the offline navigation fallback target; without it, first
// shortcut launches like /?action=new can miss the cache while offline.
test("install handler precaches PRECACHE_URLS containing root slash via cache.addAll", (t) => {
  if (skipIfSwMissing(t)) return;
  const src = readSwCodeOnly();
  assert.match(
    src,
    /const\s+PRECACHE_URLS\s*=\s*\[[^\]]*["']\/["'][^\]]*\]\s*;/,
    "PRECACHE_URLS must include '/' for the navigation shell fallback",
  );
  assert.match(
    src,
    /cache\.addAll\(\s*PRECACHE_URLS\s*\)/,
    "install handler must precache PRECACHE_URLS via cache.addAll(PRECACHE_URLS)",
  );
});

// Lenient install preserves upgrade opportunity on transient precache fetch
// failures; otherwise the new worker can fail to install entirely.
test("install handler catches cache.addAll precache failures", (t) => {
  if (skipIfSwMissing(t)) return;
  const src = readSwCodeOnly();
  const installStart = src.indexOf('self.addEventListener("install"');
  const activateStart = src.indexOf('self.addEventListener("activate"');
  assert.ok(installStart !== -1 && activateStart !== -1, "sw.js must define install and activate handlers");
  const installSrc = src.slice(installStart, activateStart);
  const addAllIdx = installSrc.indexOf("cache.addAll(PRECACHE_URLS)");
  const catchIdx = installSrc.indexOf(".catch(", addAllIdx);
  assert.ok(addAllIdx !== -1, "install handler must call cache.addAll(PRECACHE_URLS)");
  assert.ok(catchIdx !== -1, "install handler must .catch cache.addAll precache failures");
});

// Claiming clients avoids a confusing split-brain period where installed pages
// remain uncontrolled until the next reload.
test("activate handler calls clients.claim", (t) => {
  if (skipIfSwMissing(t)) return;
  const src = readSwCodeOnly();
  assert.match(src, /self\.clients\.claim\(\)/, "activate handler must call self.clients.claim()");
});

// Old versioned caches otherwise accumulate and can serve stale shell bytes or
// consume quota indefinitely.
test("activate handler enumerates cache keys and deletes old shell versions", (t) => {
  if (skipIfSwMissing(t)) return;
  const src = readSwCodeOnly();
  assert.match(src, /caches\.keys\(\)/, "activate handler must enumerate caches.keys() for cleanup");
  assert.match(src, /caches\.delete\(/, "activate handler must delete old cache versions with caches.delete(...)");
});

// API traffic is realtime and user-specific; caching it would produce stale or
// nonsensical agent responses.
test("fetch handler bypasses /api/ routes", (t) => {
  if (skipIfSwMissing(t)) return;
  const src = readSwCodeOnly();
  assert.match(src, /pathname\.startsWith\(["']\/api\/["']\)/, "fetch handler must bypass pathname.startsWith('/api/')");
});

// Mutating requests must never be cached or replayed from cache; only safe GET
// requests participate in the offline shell strategy.
test("fetch handler bypasses non-GET requests", (t) => {
  if (skipIfSwMissing(t)) return;
  const src = readSwCodeOnly();
  assert.match(src, /method\s*!==\s*["']GET["']/, "fetch handler must return early when request method !== 'GET'");
});

// Cross-origin responses can have opaque/CORS semantics and should not be
// folded into the app-shell cache.
test("fetch handler bypasses cross-origin requests", (t) => {
  if (skipIfSwMissing(t)) return;
  const src = readSwCodeOnly();
  assert.match(
    src,
    /url\.origin\s*!==\s*self\.location\.origin/,
    "fetch handler must bypass when url.origin !== self.location.origin",
  );
});

// Cache-first behavior is the offline-shell contract: open the shell cache and
// attempt a cache match before going to network on misses.
test("fetch handler opens CACHE_NAME before matching the request", (t) => {
  if (skipIfSwMissing(t)) return;
  const src = readSwCodeOnly();
  const openIdx = src.indexOf("caches.open(CACHE_NAME)");
  const matchIdx = src.indexOf("cache.match(req)");
  assert.ok(openIdx !== -1, "fetch handler must open caches.open(CACHE_NAME)");
  assert.ok(matchIdx !== -1, "fetch handler must attempt cache.match(req)");
  assert.ok(openIdx < matchIdx, "cache-first ordering requires caches.open(CACHE_NAME) before cache.match(req)");
});

// The critical shortcut-launch fix: navigation requests that miss exact URL
// matching still need to fall back to the cached root shell.
test("navigation cache miss falls back to cached root shell", (t) => {
  if (skipIfSwMissing(t)) return;
  const src = readSwCodeOnly();
  assert.match(
    src,
    /let\s+cached\s*=\s*await\s+cache\.match\(req\)\s*;[\s\S]*?if\s*\(\s*!cached\s*&&\s*req\.mode\s*===\s*["']navigate["']\s*\)\s*{\s*cached\s*=\s*await\s+cache\.match\(["']\/["']\)/,
    "navigation cache miss must fall back to cache.match('/')",
  );
});

// Offline + network failure on a navigation should still render the shell;
// there are two semantic navigate guards: miss fallback and catch fallback.
test("navigation network failure catch serves cached root shell", (t) => {
  if (skipIfSwMissing(t)) return;
  const src = readSwCodeOnly();
  const navigateChecks = src.match(/req\.mode\s*===\s*["']navigate["']/g) ?? [];
  assert.ok(
    navigateChecks.length >= 2,
    "fetch handler must check req.mode === 'navigate' in both cache-miss and network-fail fallback paths",
  );
});

// Response bodies are one-shot streams; cloning before cache.put preserves the
// original response for the browser while storing a copy.
test("fetch handler clones responses before cache.put", (t) => {
  if (skipIfSwMissing(t)) return;
  const src = readSwCodeOnly();
  const putCalls = src.match(/cache\.put\(/g) ?? [];
  const clonedPutCalls = src.match(/cache\.put\([^,]+,\s*res\.clone\(\)\)/g) ?? [];
  assert.ok(putCalls.length >= 1, "fetch handler must write successful responses with cache.put(...)");
  assert.equal(
    clonedPutCalls.length,
    putCalls.length,
    "every cache.put response argument must use res.clone() to avoid consuming the response stream",
  );
});

// Cache.put rejects partial-content 206 responses even though res.ok is true;
// the helper must filter them out to avoid noisy failed writes.
test("isCacheable excludes 206 partial content responses", (t) => {
  if (skipIfSwMissing(t)) return;
  const src = readSwCodeOnly();
  assert.match(src, /status\s*!==\s*206/, "isCacheable must exclude status !== 206 partial-content responses");
});

// Cache write failures on the miss path are otherwise invisible; a warning
// makes quota/storage failures diagnosable without breaking the response.
test("cache.put failure on miss path logs an observable warning", (t) => {
  if (skipIfSwMissing(t)) return;
  const src = readSwCodeOnly();
  assert.match(src, /console\.warn\(\s*["']\[sw\] cache\.put/, "cache.put failure must log via console.warn('[sw] cache.put...')");
});

// Older browsers may not implement AbortSignal.timeout; feature detection keeps
// background refresh from throwing synchronously on cache-hit navigations.
test("AbortSignal.timeout is feature-detected before use", (t) => {
  if (skipIfSwMissing(t)) return;
  const src = readSwCodeOnly();
  assert.match(
    src,
    /const\s+HAS_ABORT_TIMEOUT\s*=\s*typeof\s+AbortSignal\s*!==\s*["']undefined["']\s*&&\s*typeof\s+AbortSignal\.timeout\s*===\s*["']function["']/,
    "AbortSignal.timeout must be feature-detected (HAS_ABORT_TIMEOUT or typeof AbortSignal) before use",
  );
});

// --- main.tsx registration tests ---

const mainPath = join(root, "src/main.tsx");

function readMainSrcCodeOnly() {
  const raw = readFileSync(mainPath, "utf8");
  return raw
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/\/\/[^\n]*/g, "");
}

// Without the feature-detect, navigator.serviceWorker dereference would crash
// on older WebKit / privacy-restricted browsers that omit the property.
test("main.tsx feature-detects serviceWorker support before registering", () => {
  const src = readMainSrcCodeOnly();
  assert.match(
    src,
    /["']serviceWorker["']\s+in\s+navigator/,
    "main.tsx must check 'serviceWorker' in navigator before registering",
  );
});

// SW must NOT register in dev mode — Vite dev server serves no sw.js, and any
// stale dev-mode registration would 404 or worse, register a wildly stale
// artifact from a previous session and break HMR.
test("main.tsx gates SW registration on import.meta.env.PROD (no SW in dev)", () => {
  const src = readMainSrcCodeOnly();
  assert.match(
    src,
    /import\.meta\.env\.PROD/,
    "main.tsx must gate SW registration on import.meta.env.PROD",
  );
});

// The SW lives at /sw.js (root scope). A hashed or namespaced path would
// either 404 (Vite copies public/* as-is, no hashing) or change SW scope.
test("main.tsx registers /sw.js at root scope (not a hashed or namespaced path)", () => {
  const src = readMainSrcCodeOnly();
  assert.match(
    src,
    /navigator\.serviceWorker\.register\(\s*["']\/sw\.js["']/,
    "main.tsx must register exactly '/sw.js' (not a hashed or scoped path)",
  );
});
