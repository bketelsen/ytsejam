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
