# Health Status Icons Implementation Plan

> Execute with the `develop` skill, task-by-task.

**Goal:** Surface WebSocket + LTM bridge health as two tri-state icons in the top-right of the
chat header (closes #92).

**Spec:** `docs/plans/2026-06-13-health-icons-design.md`

**Architecture:** New `GET /api/memory/health` endpoint exposes `memory.health().ltm`. New
`HealthIcon` component renders a `lucide-react` `Plug` (WS) and `Brain` (LTM) with a
`border-current` ring that switches between gray/green/red. `useApp` is extended with a
`wsState` (promoted from boolean `connected`) and a polled `ltmState` (10s interval against
the new endpoint). `App.tsx` places the icons in a now-always-visible header strip via
`ml-auto`, with the existing mobile burger kept `md:hidden`.

**Tech Stack:** Hono (server), React + Vite + Tailwind v4 (web), `lucide-react` icons,
`node:test` (server) + `vitest` (web).

**Worktree:** `/tmp/feat-92-health-icons`

**Branch:** `feat/92-health-icons`

---

## Task 1: Server endpoint — `GET /api/memory/health`

> **Post-ship note:** what actually shipped diverged from this section in two
> ways (see commits `32b9335` + `d841631`):
> 1. The test file lives at `server/test/memory-health.test.ts` (vitest, the
>    project's server test convention) — NOT `server/src/server.health.test.ts`.
>    Tests under `server/src/` are invisible to `scripts/gate.sh` (its vitest glob
>    is `test/**/*.test.ts`). The shape and the three cases below are otherwise
>    accurate; treat the file path and the `npx tsx --test` command as superseded.
> 2. The model server test is `server/test/api.test.ts` (vitest + `createApp(deps).app`
>    + `mkdtempSync` isolation), not `server/src/cog/*.test.ts`.

**Files:**
- Modify: `server/src/server.ts` (add route near other `app.get("/api/...")` calls)
- Test: `server/src/server.health.test.ts` (create)

### Step 1: Write the failing test

Use the same Hono `app.request()` pattern other server tests use. If no `server.test.ts`
exists today, model on `server/src/cog/*.test.ts` or any `node:test` file under `server/src/`.

Test cases (all in one file):

1. With a fake reconciler attached → `GET /api/memory/health` (with bearer token) returns
   `200` and body `{ ltm: { reachable: true, consecutiveFailures: 0 } }`.
2. With no reconciler attached → returns `200` and body `{ ltm: null }`.
3. Without a bearer token → returns `401`.

Build the app via the existing factory (look for `createApp` / `buildServer` / `serve` exports
in `server/src/server.ts` and `server/src/index.ts`; if the factory doesn't take injectable
memory today, the test stubs `memory.health()` via `import * as memory from "./memory/index.ts"`
+ a test-local monkey-patch, or you add a small `MemoryProvider` arg to the factory — pick the
lowest-impact path).

### Step 2: Run test to verify it fails

```
cd server && env -u NODE_ENV npx tsx --test src/server.health.test.ts
```

Expected: 404 on the route (test 1 + 2), test 3 may pass coincidentally.

### Step 3: Add the route

In `server/src/server.ts`, after `app.get("/api/sessions", ...)` and before the WS route:

```ts
app.get("/api/memory/health", async (c) => {
  const h = await memory.health();
  return c.json({ ltm: h.ltm ?? null });
});
```

Verify `memory` is the right import name in this file. If `health` is exported from a
different path (e.g. `./memory/store/health.ts` rather than `./memory/index.ts`), prefer the
top-level `./memory/index.ts` re-export — that is the canonical surface per
`server/src/memory/README.md`.

### Step 4: Run test to verify it passes

```
cd server && env -u NODE_ENV npx tsx --test src/server.health.test.ts
```

All three cases pass.

### Step 5: Commit

```bash
git add server/src/server.ts server/src/server.health.test.ts
git commit -m "feat(server): add GET /api/memory/health endpoint"
```

---

## Task 2: Web — `HealthIcon` component

**Test convention note:** the web project has NO vitest / @testing-library / jsdom. Tests run via
`node test/run.mjs` (node's native test runner, `.test.mjs` files) and use **source-text regex
audits**, not rendered-DOM tests. The model is `web/test/compaction-pill.test.mjs` — it reads
component source files with `readFileSync` and asserts shape with `assert.match`. We MUST match
this convention; do not add vitest or testing-library devDeps. Layout/rendering correctness is
verified by the manual smoke in Task 4 (cog pattern: "build-green + source-audit + no-layout-shift
CSS proof are necessary-not-sufficient; complete requires a human eye on the real device").

**Files:**
- Create: `web/src/components/HealthIcon.tsx`
- Test: `web/test/health-icon.test.mjs` (create)
- Modify: `web/test/run.mjs` (add `import "./health-icon.test.mjs";`)

### Step 1: Write the failing test

```js
// web/test/health-icon.test.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const src = readFileSync(join(root, "src/components/HealthIcon.tsx"), "utf8");

test("HealthIcon exports a HealthState union with unknown | ok | bad", () => {
  assert.match(src, /export\s+type\s+HealthState\s*=\s*["']unknown["']\s*\|\s*["']ok["']\s*\|\s*["']bad["']/);
});

test("HealthIcon imports Plug and Brain from lucide-react", () => {
  assert.match(src, /import\s*\{[^}]*\bPlug\b[^}]*\}\s*from\s*["']lucide-react["']/);
  assert.match(src, /import\s*\{[^}]*\bBrain\b[^}]*\}\s*from\s*["']lucide-react["']/);
});

test("HealthIcon maps states to color classes (unknown → muted-foreground, ok → success, bad → destructive)", () => {
  assert.match(src, /unknown:\s*["']text-muted-foreground["']/);
  assert.match(src, /ok:\s*["']text-success["']/);
  assert.match(src, /bad:\s*["']text-destructive["']/);
});

test("HealthIcon picks the icon by kind (ws → Plug, ltm → Brain)", () => {
  assert.match(src, /ws:\s*Plug/);
  assert.match(src, /ltm:\s*Brain/);
});

test("HealthIcon renders role='status' with title, aria-label, and data-state from props", () => {
  assert.match(src, /role=\{?["']status["']/);
  assert.match(src, /title=\{title\}/);
  assert.match(src, /aria-label=\{title\}/);
  assert.match(src, /data-state=\{state\}/);
});

test("HealthIcon uses border-current so the ring color follows the text-* class", () => {
  assert.match(src, /border\s+border-current/);
});

test("HealthIcon accepts kind, state, title props with the expected types", () => {
  assert.match(src, /kind:\s*["']ws["']\s*\|\s*["']ltm["']/);
  assert.match(src, /state:\s*HealthState/);
  assert.match(src, /title:\s*string/);
});
```

### Step 2: Run test to verify it fails

```
cd web && env -u NODE_ENV node test/health-icon.test.mjs
```

Expected: ENOENT on `src/components/HealthIcon.tsx`.

### Step 3: Implement the component

```tsx
// web/src/components/HealthIcon.tsx
import { Plug, Brain } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type HealthState = "unknown" | "ok" | "bad";

const COLOR: Record<HealthState, string> = {
  unknown: "text-muted-foreground",
  ok:      "text-success",
  bad:     "text-destructive",
};

const ICON: Record<"ws" | "ltm", LucideIcon> = { ws: Plug, ltm: Brain };

export function HealthIcon({
  kind, state, title,
}: { kind: "ws" | "ltm"; state: HealthState; title: string }) {
  const Icon = ICON[kind];
  return (
    <span
      title={title}
      aria-label={title}
      role="status"
      data-state={state}
      className={`inline-flex h-7 w-7 items-center justify-center rounded border border-current ${COLOR[state]}`}
    >
      <Icon className="h-4 w-4" aria-hidden />
    </span>
  );
}
```

(Verified during planning: `text-success`, `text-destructive`, and `text-muted-foreground` are
all valid Tailwind utilities in this project — `--success` is defined in `web/src/index.css`,
and `text-success` is already used at `web/src/components/TaskCard.tsx`.)

### Step 4: Wire into the test runner + verify it passes

Add the new test file to `web/test/run.mjs`:

```js
// add to the import block in run.mjs, alphabetically (between compaction-pill and message-...):
import "./health-icon.test.mjs";
```

Run targeted:

```
cd web && env -u NODE_ENV node test/health-icon.test.mjs
```

Then the full suite (the gate runs this):

```
cd web && env -u NODE_ENV node test/run.mjs
```

All cases pass.

### Step 5: Commit

```bash
git add web/src/components/HealthIcon.tsx web/test/health-icon.test.mjs web/test/run.mjs
git commit -m "feat(web): add HealthIcon component (Plug/Brain, tri-state outline)"
```

---

## Task 3: Web — wire state into `useApp`, render in `App.tsx`, lift `Chat` header

**Test convention reminder:** same as Task 2 — source-text audits via `node:test`. No vitest,
no rendered-DOM tests, no `renderHook`. We assert on the SHAPE of the code (presence of state,
the polling effect, type updates, JSX wiring). The 10s-poll → tri-state branch logic gets
verified by extracting the constants + asserting the relevant call sites; behavioral correctness
is confirmed by the manual smoke in Task 4.

**Files:**
- Modify: `web/src/useApp.ts` (rename `connected` → `wsState`; add `ltmState` + `ltmLastError`
  + 10s polling effect; add constants)
- Modify: `web/src/lib/ws.ts` (no behavior change; `onStatus` signature stays `(connected:
  boolean) => void`)
- Modify: `web/src/lib/types.ts` (add `LtmHealth` type alias mirroring
  `server/src/memory/types.ts`'s `HealthResult["ltm"]`)
- Modify: `web/src/lib/api.ts` (add `getMemoryHealth()` to the `client` object so the polling
  effect uses the existing typed-fetch helper)
- Modify: `web/src/components/Chat.tsx` (lift `<header>` out of `md:hidden`; add `headerRight`
  prop slot)
- Modify: `web/src/App.tsx` (build `wsTitle` / `ltmTitle`; pass icons into the new slot)
- Create: `web/test/health-status.test.mjs`
- Modify: `web/test/run.mjs` (add `import "./health-status.test.mjs";`)

### Step 1: Write the failing test

```js
// web/test/health-status.test.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const useApp = readFileSync(join(root, "src/useApp.ts"), "utf8");
const ws     = readFileSync(join(root, "src/lib/ws.ts"), "utf8");
const types  = readFileSync(join(root, "src/lib/types.ts"), "utf8");
const api    = readFileSync(join(root, "src/lib/api.ts"), "utf8");
const chat   = readFileSync(join(root, "src/components/Chat.tsx"), "utf8");
const app    = readFileSync(join(root, "src/App.tsx"), "utf8");

test("types.ts exports LtmHealth with reachable, consecutiveFailures, and optional lastError", () => {
  assert.match(types, /export\s+interface\s+LtmHealth\s*\{/);
  assert.match(types, /reachable:\s*boolean/);
  assert.match(types, /consecutiveFailures:\s*number/);
  assert.match(types, /lastError\?:\s*\{\s*message:\s*string;\s*at:\s*string;?\s*\}/);
});

test("api.ts adds client.getMemoryHealth returning { ltm: LtmHealth | null }", () => {
  assert.match(api, /getMemoryHealth\s*:\s*\(\s*\)\s*=>/);
  assert.match(api, /\/api\/memory\/health/);
  assert.match(api, /\{\s*ltm:\s*LtmHealth\s*\|\s*null\s*\}/);
});

test("ws.ts onStatus signature is unchanged (still passes boolean)", () => {
  assert.match(ws, /onStatus:\s*\(\s*connected:\s*boolean\s*\)\s*=>\s*void/);
});

test("useApp declares the HealthState union and the LTM threshold + poll interval constants", () => {
  assert.match(useApp, /HealthState\s*=\s*["']unknown["']\s*\|\s*["']ok["']\s*\|\s*["']bad["']/);
  assert.match(useApp, /const\s+LTM_UNHEALTHY_THRESHOLD\s*=\s*3/);
  assert.match(useApp, /const\s+LTM_POLL_MS\s*=\s*10_?000/);
});

test("useApp tracks wsState (replaces the old boolean `connected`) and seeds it to 'unknown'", () => {
  assert.match(useApp, /useState<HealthState>\(["']unknown["']\)/);
  assert.match(useApp, /setWsState\(c\s*\?\s*["']ok["']\s*:\s*["']bad["']\)/);
  // The old `setConnected` callback wiring must be gone.
  assert.doesNotMatch(useApp, /setConnected/);
});

test("useApp tracks ltmState + ltmLastError and runs a polling effect", () => {
  assert.match(useApp, /\[ltmState,\s*setLtmState\]/);
  assert.match(useApp, /\[ltmLastError,\s*setLtmLastError\]/);
  // tri-state derivation: reachable=false OR consecutiveFailures >= threshold => bad
  assert.match(useApp, /!\s*[A-Za-z_$][A-Za-z0-9_$]*\.reachable/);
  assert.match(useApp, /consecutiveFailures\s*>=\s*LTM_UNHEALTHY_THRESHOLD/);
  // null branch -> unknown
  assert.match(useApp, /setLtmState\(["']unknown["']\)/);
  // poll interval wired up
  assert.match(useApp, /setInterval\([^,]+,\s*LTM_POLL_MS\)/);
  // cleanup
  assert.match(useApp, /clearInterval/);
});

test("useApp return value exposes wsState, ltmState, ltmLastError (and drops `connected`)", () => {
  // The returned object literal must list the three new fields.
  assert.match(useApp, /\bwsState\b/);
  assert.match(useApp, /\bltmState\b/);
  assert.match(useApp, /\bltmLastError\b/);
  // The old boolean is gone from the return statement.
  assert.doesNotMatch(useApp, /^\s*connected,?\s*$/m);
});

test("Chat declares a headerRight prop and renders it in an always-visible header strip", () => {
  assert.match(chat, /headerRight\?\:\s*React\.ReactNode/);
  // The <header> element no longer hides at desktop (md:hidden was removed from <header>).
  const headerOpen = chat.match(/<header\b[^>]*>/);
  assert.ok(headerOpen, "Chat must still render a <header>");
  assert.doesNotMatch(headerOpen[0], /md:hidden/);
  // Burger button keeps md:hidden so it stays mobile-only.
  assert.match(
    chat,
    /<Button[^>]*onClick=\{onMenuClick\}[^>]*className=["'][^"']*\bmd:hidden\b[^"']*["']/
  );
  // headerRight slot rendered ml-auto
  assert.match(chat, /\{headerRight\s*&&\s*<div\s+className=["'][^"']*\bml-auto\b/);
});

test("App.tsx renders both HealthIcons and passes them via headerRight", () => {
  assert.match(app, /import\s*\{\s*HealthIcon\s*\}\s*from\s*["']\.\/components\/HealthIcon["']/);
  assert.match(app, /<HealthIcon\s+kind=["']ws["']/);
  assert.match(app, /<HealthIcon\s+kind=["']ltm["']/);
  assert.match(app, /headerRight=\{/);
  // Tooltip strings present in App.tsx
  assert.match(app, /WebSocket:\s*connecting/);
  assert.match(app, /WebSocket:\s*connected/);
  assert.match(app, /WebSocket:\s*disconnected/);
  assert.match(app, /LTM:\s*status unknown/);
  assert.match(app, /LTM:\s*healthy/);
});
```

### Step 2: Run test to verify it fails

```
cd web && env -u NODE_ENV node test/health-status.test.mjs
```

Expected: most cases fail (none of the new code exists yet); the `ws.ts onStatus` test should
pass (no change to that file).

### Step 3: Add `LtmHealth` to `web/src/lib/types.ts`

Mirror the server's `HealthResult["ltm"]` shape (copy the field set; do NOT import server types
— the web build cannot reach `server/`):

```ts
export interface LtmHealth {
  reachable: boolean;
  consecutiveFailures: number;
  lastTickAt?: string;
  lastTickStats?: {
    scannedFiles: number; scannedLines: number;
    replayed: number; skipped: number; errors: number;
  };
  lastError?: { message: string; at: string };
}
```

### Step 4: Add `getMemoryHealth` to `web/src/lib/api.ts`

The `api<T>(path)` helper is module-private. Add a client method that calls it:

```ts
import type { ..., LtmHealth } from "./types"; // extend the existing import line

// ... inside `export const client = { ... }`, alongside getPersona / getModels:
  getMemoryHealth: () => api<{ ltm: LtmHealth | null }>("/api/memory/health"),
```

### Step 5: Promote `connected` → `wsState` in `web/src/useApp.ts`

At the top of the file (under existing imports):

```ts
export type HealthState = "unknown" | "ok" | "bad";

const LTM_UNHEALTHY_THRESHOLD = 3;
const LTM_POLL_MS = 10_000;
```

Replace the `connected` state hook + WS wiring:

```ts
// delete: const [connected, setConnected] = useState(false);
const [wsState, setWsState] = useState<HealthState>("unknown");
// ...
wsRef.current = connectWs({
  onEvent,
  onStatus: (c) => setWsState(c ? "ok" : "bad"),
});
```

### Step 6: Add LTM polling effect + `lastError`

In `useApp`, add the state hooks + effect:

```ts
const [ltmState, setLtmState] = useState<HealthState>("unknown");
const [ltmLastError, setLtmLastError] = useState<string | undefined>(undefined);

useEffect(() => {
  let cancelled = false;
  async function tick() {
    try {
      const r = await client.getMemoryHealth();
      if (cancelled) return;
      if (!r.ltm) {
        setLtmState("unknown");
        setLtmLastError(undefined);
        return;
      }
      const bad = !r.ltm.reachable || r.ltm.consecutiveFailures >= LTM_UNHEALTHY_THRESHOLD;
      setLtmState(bad ? "bad" : "ok");
      setLtmLastError(r.ltm.lastError?.message);
    } catch {
      if (!cancelled) setLtmState("unknown");
    }
  }
  void tick();
  const id = setInterval(tick, LTM_POLL_MS);
  return () => { cancelled = true; clearInterval(id); };
}, []);
```

(`client` is the exported object from `./lib/api`; verify the existing `import { ... } from
"./lib/api"` in `useApp.ts` already includes `client`, and add it if not.)

Update the returned object literal: drop `connected`, add the three new fields:

```ts
return {
  // ... existing fields except `connected`
  wsState,
  ltmState,
  ltmLastError,
};
```

If any existing call site reads `app.connected` (grep first — current audit says none does),
update it; if none exists, the rename is free.

### Step 7: Lift the header in `web/src/components/Chat.tsx`

Today's `<header>` has `md:hidden`. Remove that, and add `md:hidden` to the burger button so it
stays mobile-only. Add a `headerRight` prop:

```tsx
// add to ChatProps:
headerRight?: React.ReactNode;

// in the JSX, replace the existing <header> block with:
<header className="flex items-center gap-2 border-b border-border px-2 py-1.5">
  <Button variant="ghost" size="icon" onClick={onMenuClick} aria-label="Open sessions"
          className="md:hidden">
    <Menu />
  </Button>
  {headerRight && <div className="ml-auto flex items-center gap-2">{headerRight}</div>}
</header>
```

(If the existing component doesn't already import `React` for `React.ReactNode`, either add
`import type { ReactNode } from "react"` and use `ReactNode`, or import `React` — match the
file's existing style.)

### Step 8: Render the icons in `web/src/App.tsx`

```tsx
import { HealthIcon } from "./components/HealthIcon";

// inside Main(), build the tooltip strings:
const wsTitle =
  app.wsState === "unknown" ? "WebSocket: connecting…" :
  app.wsState === "ok"      ? "WebSocket: connected"   :
                              "WebSocket: disconnected";
const ltmTitle =
  app.ltmState === "unknown" ? "LTM: status unknown" :
  app.ltmState === "ok"      ? "LTM: healthy"        :
                               `LTM: ${app.ltmLastError ?? "unhealthy"}`;

// pass headerRight to <Chat>:
<Chat
  ...
  headerRight={
    <>
      <HealthIcon kind="ws"  state={app.wsState}  title={wsTitle} />
      <HealthIcon kind="ltm" state={app.ltmState} title={ltmTitle} />
    </>
  }
/>
```

### Step 9: Wire the new test into the runner + run the full suite

Add to `web/test/run.mjs`:

```js
import "./health-status.test.mjs";
```

Then:

```
cd /tmp/feat-92-health-icons && env -u NODE_ENV bash scripts/gate.sh
```

Expected: full PASS. The gate log must mention both `health-icon` and `health-status` test
execution.

### Step 10: Commit

```bash
git add web/src/useApp.ts web/src/lib/types.ts web/src/lib/api.ts \
        web/src/components/Chat.tsx web/src/App.tsx \
        web/test/health-status.test.mjs web/test/run.mjs
git commit -m "feat(web): surface WS + LTM health icons in chat header"
```

---

## Task 4: Manual smoke + PR description draft

**Files:** none modified (this task is documentation work, performed by the lead before /ship).

### Step 1: Confirm gate green

```
cd /tmp/feat-92-health-icons && env -u NODE_ENV bash scripts/gate.sh
```

### Step 2: Build + serve from the worktree (dev mode, isolated)

```
cd /tmp/feat-92-health-icons && bash deploy/dev.sh
```

Open `http://localhost:3000/` (or the port `deploy/dev.sh` prints).

Smoke (record outcomes in the PR description):

1. **Cold start:** both icons render gray.
2. **After WS connects (≤1s):** plug turns green.
3. **After first LTM poll (≤10s):** brain turns green (assuming dev LTM is reachable; if not,
   it goes red within ≤10s — still a valid smoke).
4. **Force WS down:** kill the dev server briefly (Ctrl-C, restart). Plug → red while the
   server is down, → green after reconnect.
5. **Force LTM down:** stop the dev server, `chmod 000` the LTM dir under
   `/tmp/ytsejam-dev/data/ltm/` (or whatever the dev data dir uses), restart. Brain → red
   within ≤30s. Revert `chmod`, wait one reconciler tick. Brain → green within ≤10s.

### Step 3: Draft PR description

Use this skeleton (lead fills in observed timings):

```
Closes #92.

## What

Two `lucide-react` icons in the top-right of the chat header surface live health for the
WebSocket (Plug) and LTM bridge (Brain). Gray outline = unknown, green = healthy, red =
unhealthy. Tooltip shows status + `ltm.lastError.message` when present.

## How

- `GET /api/memory/health` returns `memory.health().ltm` (or `null` when no reconciler).
- `useApp` polls every 10s and tracks tri-state `ltmState` + `wsState` (promoted from the
  existing `connected` boolean).
- New `HealthIcon` component renders the Plug/Brain with a `border-current` ring colored by
  state.
- Chat header is now always visible (was `md:hidden`); burger stays `md:hidden`.

## Smoke (manual, on dev)

- Cold start: gray ✓
- WS connected: green within ~1s ✓
- LTM healthy: green within ~10s ✓
- LTM forced down (chmod 000 + restart): red within ~30s ✓
- LTM recovered: green within ~10s ✓
```

### Step 4: No commit

Hand off to `/ship`.

---

## Open decisions captured in the plan (no further questions)

- Threshold N=3 hard-coded in `useApp` (matches the original issue body).
- Polling interval = 10s (cheaper than a push event channel; meets the 30s detection target).
- Tooltip text strings are final per design memo; no i18n in v1.
- No retry-from-UI button (consistent with issue v1 scope).
- Header lift: header becomes always-visible across breakpoints; burger stays mobile-only.
