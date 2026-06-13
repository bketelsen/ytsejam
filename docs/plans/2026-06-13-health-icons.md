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

**Files:**
- Create: `web/src/components/HealthIcon.tsx`
- Test: `web/src/components/HealthIcon.test.tsx` (create)

### Step 1: Write the failing test

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { HealthIcon } from "./HealthIcon";

describe("HealthIcon", () => {
  it("renders a Plug icon for kind='ws'", () => {
    render(<HealthIcon kind="ws" state="ok" title="WS healthy" />);
    const el = screen.getByRole("status");
    expect(el.querySelector("svg")).toBeTruthy();
    expect(el.getAttribute("data-state")).toBe("ok");
    expect(el.getAttribute("aria-label")).toBe("WS healthy");
    expect(el.getAttribute("title")).toBe("WS healthy");
  });

  it("renders a Brain icon for kind='ltm'", () => {
    render(<HealthIcon kind="ltm" state="bad" title="LTM down" />);
    const el = screen.getByRole("status");
    expect(el.querySelector("svg")).toBeTruthy();
    expect(el.getAttribute("data-state")).toBe("bad");
  });

  it.each([
    ["unknown", "text-muted-foreground"],
    ["ok",      "text-success"],
    ["bad",     "text-destructive"],
  ] as const)("applies %s color class", (state, cls) => {
    render(<HealthIcon kind="ws" state={state} title="t" />);
    expect(screen.getByRole("status").className).toContain(cls);
  });
});
```

If `text-success` is not a valid Tailwind class in this project (check
`web/src/index.css` + `tailwind.config.*` if present), substitute the actual green token used
by `compacting…` pill (`text-warning` is in use, suggesting `text-success` likely exists; if
not, use `text-emerald-500` and align the test).

### Step 2: Run test to verify it fails

```
cd web && env -u NODE_ENV npx vitest run src/components/HealthIcon.test.tsx
```

Expected: module-not-found.

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

### Step 4: Run test to verify it passes

```
cd web && env -u NODE_ENV npx vitest run src/components/HealthIcon.test.tsx
```

All cases pass.

### Step 5: Commit

```bash
git add web/src/components/HealthIcon.tsx web/src/components/HealthIcon.test.tsx
git commit -m "feat(web): add HealthIcon component (Plug/Brain, tri-state outline)"
```

---

## Task 3: Web — wire state into `useApp` and render in `App.tsx`

**Files:**
- Modify: `web/src/useApp.ts` (rename `connected` → `wsState`; add `ltmState` + `ltmLastError`
  + 10s polling effect; add constants)
- Modify: `web/src/lib/ws.ts` (no behavior change; `onStatus` signature stays `(connected:
  boolean) => void`)
- Modify: `web/src/lib/types.ts` (add `LtmHealth` type alias mirroring
  `server/src/memory/types.ts`'s `HealthResult["ltm"]`)
- Modify: `web/src/components/Chat.tsx` (lift `<header>` out of `md:hidden`; add `ml-auto`
  icon strip slot)
- Modify: `web/src/App.tsx` (build `wsTitle` / `ltmTitle`; pass icons into the new slot)
- Test: `web/src/useApp.health.test.ts` (create)

### Step 1: Write the failing test (`useApp.health.test.ts`)

Use `vitest` + `@testing-library/react`'s `renderHook` with timer mocks:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useApp } from "./useApp";

describe("useApp ltm health polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Stub other useApp dependencies (sessions fetch, ws) per existing test patterns —
    // copy from any pre-existing useApp test or App test, otherwise stub fetch globally.
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("starts at 'unknown'", () => {
    const { result } = renderHook(() => useApp());
    expect(result.current.ltmState).toBe("unknown");
    expect(result.current.wsState).toBe("unknown");
  });

  it("flips to 'ok' on healthy poll", async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/api/memory/health"))
        return new Response(JSON.stringify({ ltm: { reachable: true, consecutiveFailures: 0 } }), { status: 200 });
      return new Response("[]", { status: 200 });
    }) as never;
    const { result } = renderHook(() => useApp());
    await waitFor(() => expect(result.current.ltmState).toBe("ok"));
  });

  it("flips to 'bad' on consecutiveFailures >= 3", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ltm: { reachable: true, consecutiveFailures: 3 } }), { status: 200 })
    ) as never;
    const { result } = renderHook(() => useApp());
    await waitFor(() => expect(result.current.ltmState).toBe("bad"));
  });

  it("flips to 'bad' on reachable=false", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ltm: { reachable: false, consecutiveFailures: 0 } }), { status: 200 })
    ) as never;
    const { result } = renderHook(() => useApp());
    await waitFor(() => expect(result.current.ltmState).toBe("bad"));
  });

  it("stays 'unknown' on fetch error", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("network"); }) as never;
    const { result } = renderHook(() => useApp());
    await act(async () => { vi.advanceTimersByTime(10_001); });
    expect(result.current.ltmState).toBe("unknown");
  });

  it("returns to 'unknown' when ltm is null", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ltm: null }), { status: 200 })
    ) as never;
    const { result } = renderHook(() => useApp());
    await act(async () => { vi.advanceTimersByTime(10_001); });
    expect(result.current.ltmState).toBe("unknown");
  });
});
```

If `useApp` does many other side effects on mount that fight the test, stub them at module
boundary (e.g. mock `./lib/ws`, mock `./lib/api`) — match whatever existing useApp / App
tests do. Do NOT redesign `useApp` to make it testable; the polling effect should be the only
new I/O.

### Step 2: Run test to verify it fails

```
cd web && env -u NODE_ENV npx vitest run src/useApp.health.test.ts
```

Expected: `ltmState`/`wsState` undefined on the hook result.

### Step 3: Promote `connected` → `wsState` in `useApp`

```ts
// at top of useApp.ts
export type HealthState = "unknown" | "ok" | "bad";

const LTM_UNHEALTHY_THRESHOLD = 3;
const LTM_POLL_MS = 10_000;

// inside useApp:
const [wsState, setWsState] = useState<HealthState>("unknown");
// ...
wsRef.current = connectWs({
  onEvent,
  onStatus: (c) => setWsState(c ? "ok" : "bad"),
});
// (delete the old `connected` useState; nothing reads it)
```

### Step 4: Add LTM polling effect + lastError

```ts
const [ltmState, setLtmState] = useState<HealthState>("unknown");
const [ltmLastError, setLtmLastError] = useState<string | undefined>(undefined);

useEffect(() => {
  let cancelled = false;
  async function tick() {
    try {
      const r = await api<{ ltm: LtmHealth | null }>("/api/memory/health");
      if (cancelled) return;
      if (!r.ltm) { setLtmState("unknown"); setLtmLastError(undefined); return; }
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

Where `api<T>(url)` is the existing typed-fetch helper in `web/src/lib/api.ts`; use whatever
function existing useApp code calls for GETs against `/api/...` (it already attaches the
bearer token).

Add to the return:
```ts
return {
  ...,
  wsState,
  ltmState,
  ltmLastError,
};
```

Remove the old `connected` field from the return object.

### Step 5: Add `LtmHealth` type to `web/src/lib/types.ts`

Mirror the server's `HealthResult["ltm"]` shape (copy the field set; do NOT import server
types — the web build cannot reach `server/`):

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

### Step 6: Lift the header in `Chat.tsx`

Remove `md:hidden` from the `<header>`. Add `md:hidden` to the burger button. Add a slot for
the right-side strip via a new prop `headerRight?: React.ReactNode`:

```tsx
// new prop
headerRight?: React.ReactNode;

// inside the component:
<header className="flex items-center gap-2 border-b border-border px-2 py-1.5">
  <Button variant="ghost" size="icon" onClick={onMenuClick} aria-label="Open sessions"
          className="md:hidden">
    <Menu />
  </Button>
  {headerRight && <div className="ml-auto flex items-center gap-2">{headerRight}</div>}
</header>
```

### Step 7: Render icons in `App.tsx`

```tsx
import { HealthIcon } from "./components/HealthIcon";

// inside Main():
const wsTitle =
  app.wsState === "unknown" ? "WebSocket: connecting…" :
  app.wsState === "ok"      ? "WebSocket: connected"   :
                              "WebSocket: disconnected";
const ltmTitle =
  app.ltmState === "unknown" ? "LTM: status unknown" :
  app.ltmState === "ok"      ? "LTM: healthy"        :
                               `LTM: ${app.ltmLastError ?? "unhealthy"}`;

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

### Step 8: Run all tests + gate

```
cd /tmp/feat-92-health-icons && env -u NODE_ENV bash scripts/gate.sh
```

Expected: full PASS, including the three new test files.

### Step 9: Commit

```bash
git add web/src/useApp.ts web/src/lib/ws.ts web/src/lib/types.ts \
        web/src/components/Chat.tsx web/src/App.tsx \
        web/src/useApp.health.test.ts
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
