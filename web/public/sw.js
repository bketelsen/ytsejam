// ytsejam offline shell service worker.
//
// Caches the static app shell (HTML + Vite-hashed assets + icons + manifest)
// so the installed PWA opens offline. Bypasses /api/* and non-GET requests
// (the agent backend is real-time; cached LLM replies are gibberish).
//
// See docs/plans/2026-06-14-pwa-tier2-offline-shell-design.md for design notes.
// Bump CACHE_VERSION when the SW's caching policy changes (NOT on every deploy
// — Vite asset hashes already cover content changes).

const CACHE_VERSION = "v2";
const CACHE_NAME = `ytsejam-shell-${CACHE_VERSION}`;

// Precached on install — guarantees a navigation-fallback target even when
// the user's first launch is via a PWA shortcut to `/?action=...` (which is
// a query-string variant that would otherwise miss cache.match's default
// `ignoreSearch: false`). `/` resolves to index.html via the server's SPA
// fallback, so this single entry covers every navigation URL.
const PRECACHE_URLS = ["/"];

// Network-only routes — never cache.
function isBypass(url) {
  if (url.pathname.startsWith("/api/")) return true;
  return false;
}

// Cache-worthy responses. Excludes 206 partial content (Cache.put rejects
// with TypeError on 206) which can slip past `res.ok` (200-299) because the
// fetch handler also serves range-able resources.
function isCacheable(res) {
  return res && res.ok && res.status !== 206;
}

self.addEventListener("install", (event) => {
  // Take over as soon as install completes — don't wait for old tabs to close.
  // Vite hashed assets are immutable, so silent takeover can't cause a stale
  // asset reference in a live tab.
  //
  // skipWaiting() called bare (not wrapped in waitUntil): the install
  // lifetime should be governed by the precache work, not by skipWaiting.
  // If precache fails, skipWaiting still happens — but the new SW activates
  // with whatever it managed to cache, which is the desired graceful-degrade.
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)),
  );
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
      // For navigations (`/`, `/?action=tasks`, `/some/spa/path`), fall back
      // to the cached `/` shell when the exact URL isn't cached. Without
      // this, cold-launching the PWA via a shortcut (`/?action=new`) after
      // only ever warming via `/` (start_url) is a cache miss → offline →
      // OS error page, defeating the offline-shell tier's whole point.
      // ignoreSearch on cache.match is the moral equivalent but isn't
      // widely supported; explicit fallback is simpler and portable.
      let cached = await cache.match(req);
      if (!cached && req.mode === "navigate") {
        cached = await cache.match("/");
      }

      if (cached) {
        // Refresh in background so the cache stays warm with the latest bytes.
        // NOTE: this nested waitUntil is legal ONLY because we're still
        // inside the respondWith promise (an "active" extendable event per
        // the Service Worker spec's "add lifetime promise" algorithm). If
        // anyone refactors so this fetch is kicked off in a .then() chained
        // after the IIFE resolves, it will throw InvalidStateError.
        // AbortSignal.timeout caps how long a slow refresh can hold the
        // SW alive on each cache-hit navigation.
        event.waitUntil(
          fetch(req, { signal: AbortSignal.timeout(5000) })
            .then((res) => {
              if (isCacheable(res)) return cache.put(req, res.clone());
            })
            .catch(() => {}),
        );
        return cached;
      }

      // No cache hit: fetch, cache on success, return.
      try {
        const res = await fetch(req);
        if (isCacheable(res)) {
          // clone() because the response body is a one-shot stream.
          // .catch with warn so quota/storage errors are observable in
          // devtools instead of silently degrading the cache.
          cache.put(req, res.clone()).catch((err) => {
            console.warn("[sw] cache.put failed:", err);
          });
        }
        return res;
      } catch (err) {
        // Offline + cold cache for a navigation: serve the cached `/`
        // shell so the SPA can at least render and show the disconnected
        // WS indicator. For non-navigation misses (a sub-resource fetch
        // failing offline), there's nothing useful to return — rethrow
        // so the browser surfaces the failure to the caller.
        if (req.mode === "navigate") {
          const shell = await cache.match("/");
          if (shell) return shell;
        }
        throw err;
      }
    })(),
  );
});
