// ytsejam offline shell service worker.
//
// Caches the static app shell (HTML + Vite-hashed assets + icons + manifest)
// so the installed PWA opens offline. Bypasses /api/* and non-GET requests
// (the agent backend is real-time; cached LLM replies are gibberish).
//
// See docs/plans/2026-06-14-pwa-tier2-offline-shell-design.md for design notes.
// Bump CACHE_VERSION when the SW's caching policy changes (NOT on every deploy
// — Vite asset hashes already cover content changes).

const CACHE_VERSION = "v3";
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

// Capture once at module load: AbortSignal.timeout is the cheapest "this
// fetch can't hang forever" guard, but it's Safari 16+ / Chrome 103+ /
// Firefox 100+ (~mid-2022). On older browsers it's undefined and calling
// it throws TypeError synchronously, which would poison the cache-hit
// path. Feature-detect once and pass `undefined` (i.e. no signal) on the
// pre-2022 minority — they lose the timeout cap on background refresh
// but cache-hit navigations still work.
const HAS_ABORT_TIMEOUT = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function";
function refreshSignal(ms) {
  return HAS_ABORT_TIMEOUT ? AbortSignal.timeout(ms) : undefined;
}

self.addEventListener("install", (event) => {
  // Take over as soon as install completes — don't wait for old tabs to close.
  // Vite hashed assets are immutable, so silent takeover can't cause a stale
  // asset reference in a live tab.
  //
  // skipWaiting() called bare (not wrapped in waitUntil): it's fire-and-
  // forget per spec, doesn't need lifetime extension, and separating it
  // from the precache means a precache rejection rejects ONLY the precache
  // waitUntil, not the skipWaiting promise.
  self.skipWaiting();
  // Precache `/` (the navigation fallback). Wrapped in .catch so a
  // transient fetch failure at install time (server hiccup, dev/prod
  // mismatch, brief 5xx) doesn't fail the whole install. Failed install
  // would mean the new SW never activates — keeping the app exactly as it
  // was pre-install, which is correct but loses the upgrade opportunity.
  // Lenient catch trades "guaranteed fallback target on first install"
  // for "install always succeeds; cache fills at runtime on next online
  // visit" — more consistent with the design's runtime-first philosophy.
  // On the catch path, the navigation fallback target won't exist until a
  // normal online visit caches `/` via the fetch handler, so cold offline
  // launch via a shortcut would still hit the OS error page. Acceptable:
  // it's the same failure mode users would have had pre-Tier-2.
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .catch((err) => {
        console.warn(
          "[sw] precache failed; install proceeds without shell fallback:",
          err,
        );
      }),
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

      // NAVIGATIONS → NETWORK-FIRST. The HTML shell references Vite-hashed
      // bundles, so a STALE cached shell points the app at old/missing asset
      // hashes after a deploy (sw.js is unchanged on a normal deploy, so the
      // SW never reinstalls and a stale-while-revalidate shell would serve the
      // old bundle until a second load / hard refresh — the stale-bundle bug).
      // Always try the network so an online client gets the fresh index.html
      // immediately; fall back to the cached `/` shell only when offline. We
      // store the response under "/" (the canonical shell key) so the offline
      // fallback works regardless of the `?action=…` query string.
      if (req.mode === "navigate") {
        try {
          const res = await fetch(req);
          if (isCacheable(res)) {
            cache.put("/", res.clone()).catch((err) => {
              console.warn("[sw] shell cache.put failed:", err);
            });
          }
          return res;
        } catch {
          // Offline: serve the cached shell (exact URL, then the `/` fallback
          // — covers cold PWA launch via a `/?action=…` shortcut) so the SPA
          // still renders and shows the disconnected indicator.
          const shell = (await cache.match(req)) || (await cache.match("/"));
          if (shell) return shell;
          throw new Error("offline and no cached app shell");
        }
      }

      // NON-NAVIGATION (Vite-hashed assets, icons, manifest) →
      // stale-while-revalidate. Hashed asset URLs are immutable, so a cache
      // hit is always correct; the background refresh keeps non-hashed
      // resources (icons/manifest) warm.
      const cached = await cache.match(req);
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
          fetch(req, { signal: refreshSignal(5000) })
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
        // Non-navigation miss offline (e.g. a sub-resource fetch failing):
        // nothing useful to return — rethrow so the browser surfaces the
        // failure. (Navigations are handled network-first above, with their
        // own cached-`/`-shell offline fallback.)
        throw err;
      }
    })(),
  );
});
