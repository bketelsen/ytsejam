# PWA Tier-2 offline shell — design

## Problem

ytsejam ships PWA installability (Tier 1) and manifest polish (Tier 5, just merged as
`3362e90`), but with no service worker the installed PWA is a network-required browser
chrome wrapper. The user gets the OS "no internet" page if they launch the app while
disconnected, even though the app's static shell (HTML/CSS/JS/icons) could be served
from cache and the WebSocket connection failure could surface through the gray-plug
health icon shipped in #92.

The Tier-2 step is: an offline-capable shell. When network is down the user opens the
PWA, sees the rendered app, and gets a visible disconnected-WS indicator — instead of
a browser error page.

## What "offline shell" does for ytsejam specifically

1. **Cold launch with no network** → SW serves cached `index.html` + assets + icons +
   manifest. The app boots, WebSocket connection fails, and the existing health icon
   (#92/#116) shows the disconnected state. User sees the app, not a browser error.
2. **Network drops mid-session** → WS disconnects (already handled by watchdog #116),
   but page-reload still works because the shell loads from cache.
3. **App update deploys while installed PWA is open** → next launch picks up the new
   shell, not a stale forever-cached version.

## What it explicitly does NOT do

- **Cache `/api/*` responses.** The agent is real-time conversational; cached LLM
  replies are gibberish. All `/api/*` requests bypass the SW cache (network-only).
- **Cache WebSocket data.** The SW doesn't intercept WS, and there's no offline-WS
  fallback to design.
- **Cache user data** (sessions, messages, tasks). They live server-side; ytsejam has
  no offline-write capability and won't grow one in this PR.
- **Background sync / push.** Tiers 3 and 4. Out of scope.

## Architecture

### Cache strategy: cache-first for the shell, network-only for /api

```
GET /sw.js                     → server, never cached
GET /api/*                     → SW pass-through (network-only)
WS  /ws/...                    → SW does not intercept
GET / or /index.html           → cache-first, then network refresh
GET /assets/*                  → cache-first (Vite hashes filenames, safe forever)
GET /icon-*.png, /manifest.*   → cache-first
GET <any other same-origin>    → cache-first, then network
```

Rationale for **cache-first over network-first**:
- Network-first adds a fetch round-trip to every page load even when the network is
  fine. Cache-first is instant when warm, and the SW updates the cache in the
  background after each launch.
- Vite emits content-hashed asset filenames (`assets/index-<hash>.js`), so a stale
  cache entry can never serve "old content for new HTML" — the new HTML references
  different hashes. Worst case is a one-launch lag for the shell to update, fixed
  by the update-detection flow below.

### Cache population: runtime, not build-time precache

Two options considered:

| approach | cost | tradeoff |
|---|---|---|
| build-time precache manifest | precise, no waste | maintain a vite plugin or post-build script |
| runtime fetch-and-cache | simple SW, smaller code | first offline launch only works after one online visit |

**Picked runtime.** Real users always visit before installing the PWA, so the cache
is warm by the time offline matters. Build-time precache earns its keep when shell
size matters (we're tiny) or when first-launch-offline is the use case (it isn't —
ytsejam needs the agent backend, so first launch is always online).

### Cache versioning: name-keyed, derived from build-time variable

Cache name format: `ytsejam-shell-v<N>`. The version is a constant in the SW source,
bumped manually when SW logic changes (cache strategy, asset list, etc). On activation
the SW deletes every same-origin cache whose name isn't the current one.

Why a hand-bumped version, not an auto-hash:
- Auto-hash on the SW file would change every build; users would see "new version,
  please reload" banners on every deploy even when nothing about the SW changed.
- The CACHED assets carry their own content hashes (Vite). The SW version only needs
  to bump when the SW's caching policy changes.

### The update trap (the gotcha)

If `/sw.js` is itself HTTP-cached by the browser, the user installs the old SW once
and **never sees a new one**, even after deploys. Two mandatory pieces:

1. **Server must serve `/sw.js` with `Cache-Control: no-cache`** (revalidate every
   request). Already needed for `/manifest.webmanifest` too; bundle the work.
2. **Server must serve `/index.html` with `Cache-Control: no-cache`** so the browser
   re-fetches the HTML, which references the new hashed assets and triggers a new
   SW byte-diff for browser revalidation.
3. Hashed assets (`/assets/*`) SHOULD get `Cache-Control: public, max-age=31536000,
   immutable` since their content hash guarantees they're immutable. **Deferred to a
   later PR** — current `serveStatic` default ("Expires"/"Last-Modified" heuristic)
   is correct, just suboptimal; this PR only adds the headers that correctness
   depends on.

### Update activation: skipWaiting + clients.claim

When a new SW installs, the default browser behavior is "wait until every tab using
the old SW is closed, then activate." For an installed PWA where the user keeps the
window open for hours, this means new code never lands without an explicit close.

Choices:

| option | UX |
|---|---|
| **A. `skipWaiting()` in install, `clients.claim()` in activate** | New SW takes over silently on next page load. Asset hashes are immutable so no mid-session breakage risk. |
| **B. Wait for natural lifecycle** | User sees update never until they close all PWA windows. Bad UX. |
| **C. Banner "new version, reload?"** | Best UX but needs UI surface. Tier 2++ concern. |

**Pick A.** Vite hashed assets are immutable so silent takeover can't break a
live session — the new SW takes effect on next navigation. C is a Tier-3 polish
ticket; A is the right "no extra UI, correct behavior" default.

### Registration: in App.tsx, prod-only

```ts
// web/src/main.tsx or App.tsx mount
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(err => {
      console.warn("SW registration failed:", err);
    });
  });
}
```

`import.meta.env.PROD` keeps the SW out of dev (Vite dev server doesn't serve the
built SW anyway, but explicit beats implicit and avoids any dev/prod surprise).

## Files

### New
- `web/public/sw.js` — the service worker itself. Plain JS (not TS, no bundling),
  served as-is. Estimated ~60-80 lines.
- `web/test/sw.test.mjs` — source-text + structural tests on `sw.js` (mirrors the
  `node:test`-based pattern from `pwa-manifest.test.mjs`).
- `server/test/cache-headers.test.ts` — vitest covering the new server cache-control
  routes.

### Modified
- `web/src/main.tsx` — add SW registration block (prod-only, gated on
  `serviceWorker in navigator`).
- `server/src/server.ts` — add explicit `Cache-Control: no-cache` for `/sw.js` and
  `/index.html` and `/manifest.webmanifest`. Add ETag/Last-Modified pass-through via
  `serveStatic` defaults so revalidation is cheap (`304 Not Modified`).

### Untouched
- Existing `serveStatic` for assets — keep the heuristic defaults for this PR.

## Out of scope

| | why |
|---|---|
| immutable cache headers for `/assets/*` | optimization, not correctness; separate PR |
| update-available banner UI | needs UI design; Tier 2++ |
| Workbox or any precache lib | runtime cache is simpler and fits this app |
| Background sync (Tier 3) | conversational UX, incoherent |
| Push notifications (Tier 4) | Notification API already covers tab-open case |
| Offline fallback page | the cached shell IS the fallback; no separate page needed |

## Risks + mitigations

- **First-deploy: existing users who already opened the PWA without an SW will not
  get one until they reload while online.** Acceptable; the PWA still works exactly
  as it does today.
- **Stale SW from a long-offline user.** If a user installs, goes offline for a
  month, and the cache schema changes meanwhile, they get the old shell. On next
  online launch the new SW installs cleanly via `skipWaiting`. Worst case: one
  launch with the old shell + new server. Vite asset hashes prevent reference
  mismatch.
- **Dev mode confusion.** SW registration is gated on `import.meta.env.PROD`. Vite
  dev server doesn't serve `sw.js` so any leak would be obvious.
- **Test stack has no SW environment.** We can't unit-test the SW's `fetch` handler
  execution directly. Tests are source-text + structural (matching the
  `pwa-manifest.test.mjs` pattern that just shipped). Behavioral confirmation
  requires manual offline-mode smoke after merge.

## Acceptance criteria (what reviewers + manual smoke check)

1. `web/public/sw.js` exists; declares a versioned cache name; implements an
   `install` event that calls `skipWaiting()`; implements an `activate` event that
   calls `clients.claim()` and deletes any cache whose name isn't the current
   version; implements a `fetch` event that bypasses for `/api/`, bypasses for
   non-GET, and otherwise tries cache then falls back to network and populates the
   cache on success.
2. `web/src/main.tsx` registers `/sw.js` only when `serviceWorker in navigator`
   AND `import.meta.env.PROD` is truthy.
3. `server/src/server.ts` sets `Cache-Control: no-cache` on responses for `/sw.js`,
   `/index.html`, and `/manifest.webmanifest`.
4. Source-text tests assert each of the above invariants and mutation-test by
   removing the invariant in a way that the test catches.
5. Gate green (web + server + build).
6. **Manual smoke (not gated, but Brian runs after merge):** install PWA →
   disable network → cold launch → app renders, WS shows disconnected.
