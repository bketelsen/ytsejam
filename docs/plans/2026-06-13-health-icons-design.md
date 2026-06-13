# Design — Health Status Icons (top-right of chat header)

> Closes #92 ("LTM bridge: surface unhealthy state in web UI").
> User comment on issue (2026-06-13): _"The top right corner of the screen should have a health
> status for the web socket and one for LTM memory. web socket should be an electrical plug,
> memory should be a brain. gray outline when unknown (on startup), green outline when good,
> red outline when unhealthy."_ — that comment is the spec; this memo just locks in mechanics.

## Goal

Render two unobtrusive status icons in the top-right of the chat surface so the user can
see — without asking — whether the WebSocket and LTM bridge are healthy.

## Surface

Two `lucide-react` icons sitting at the right edge of the chat header strip:

- `Plug` — WebSocket connection
- `Brain` — LTM bridge

Each icon has a 1px outline that is one of three colors:

- **gray** — unknown (initial mount, before first signal)
- **green** — healthy
- **red** — unhealthy

Hovering an icon surfaces a tooltip:

- Plug: `"WebSocket: connected"` / `"WebSocket: disconnected"` / `"WebSocket: connecting…"`
- Brain: `"LTM: healthy"` / `"LTM: <lastError.message>"` / `"LTM: status unknown"`

No click action in v1 (consistent with the issue's "no retry-from-UI button in v1").

## Header placement

Today's `<header>` in `web/src/components/Chat.tsx` is `md:hidden` — only the mobile burger
shows. The icons must be visible on both desktop and mobile. We lift the header to always-visible
and keep the burger `md:hidden` inside it. Right-align the icon strip with `ml-auto`.

```tsx
<header className="flex items-center gap-2 border-b border-border px-2 py-1.5">
  <Button variant="ghost" size="icon" onClick={onMenuClick} aria-label="Open sessions"
          className="md:hidden">
    <Menu />
  </Button>
  <div className="ml-auto flex items-center gap-2">
    <HealthIcon kind="ws" state={wsState} />
    <HealthIcon kind="ltm" state={ltmState} />
  </div>
</header>
```

This is the only layout change. Desktop gains a thin always-visible header strip (icons only);
mobile keeps the burger and gains the icons on the right.

## State sources

### WebSocket state

`useApp` already tracks a boolean `connected` (currently exported but unrendered). Promote it
to tri-state:

```ts
type WsState = "unknown" | "ok" | "bad";
```

- `"unknown"` is the initial value (before `ws.onopen` or `ws.onclose` fires)
- `connectWs` `onStatus(true)` → `"ok"`; `onStatus(false)` → `"bad"`
- The `connected: boolean` field on `useApp`'s return value is renamed `wsState: WsState` and
  callers updated. (Grep shows only `useApp.ts` writes/exports it; no reader exists today, so
  the rename is free.)

### LTM state

New endpoint `GET /api/memory/health`. Returns the `ltm` field of `memory.health()` verbatim
(or `null` if no reconciler is attached, e.g. dev runs without LTM):

```ts
// server response shape
{ ltm: HealthResult["ltm"] | null }
```

Front end polls every **10 seconds** from `useApp`. Tri-state derived per response:

- `"unknown"` — initial mount, OR fetch failed (network error / non-2xx), OR `ltm === null`
- `"ok"` — `ltm.reachable === true && ltm.consecutiveFailures < 3`
- `"bad"` — `ltm.reachable === false || ltm.consecutiveFailures >= 3`

Threshold `3` matches the original issue body's "probably 3" call. Hard-coded in `useApp`; a
constant `const LTM_UNHEALTHY_THRESHOLD = 3` lives at the top of `useApp.ts`. Detection budget:
≤10s polling + ≤30s default reconciler tick ≈ "within ~30s of LTM bridge starting to fail"
per the original acceptance criterion.

## Why poll, not push

The server has no LTM-health event today. A push path would mean a new `ServerEvent` variant,
reconciler→bus wiring, and a debounce. A 10s poll of a 1-line endpoint is materially cheaper
and matches the detection target. If a richer push channel ever lands (issue not filed), this
hook collapses to an event listener with no UI change.

## Component

`web/src/components/HealthIcon.tsx`:

```tsx
import { Plug, Brain } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type HealthState = "unknown" | "ok" | "bad";

const COLOR: Record<HealthState, string> = {
  unknown: "text-muted-foreground",  // gray
  ok:      "text-success",           // green (existing token; see index.css)
  bad:     "text-destructive",       // red (existing token)
};

const ICON: Record<"ws" | "ltm", LucideIcon> = { ws: Plug, ltm: Brain };

export function HealthIcon({ kind, state, title }: {
  kind: "ws" | "ltm";
  state: HealthState;
  title: string;
}) {
  const Icon = ICON[kind];
  return (
    <span title={title} aria-label={title} role="status" data-state={state}
          className={`inline-flex h-7 w-7 items-center justify-center rounded
                      border border-current ${COLOR[state]}`}>
      <Icon className="h-4 w-4" aria-hidden />
    </span>
  );
}
```

- The "outline" from the user comment = the `border border-current` ring; `text-*` controls
  both the icon stroke and the border, so all three states share one tailwind utility.
- `text-success` / `text-destructive` are already in the design tokens (see
  `web/src/index.css` — `--success`, `--destructive`). If `text-success` is not yet a
  utility, fall back to `text-emerald-500` for green (verify during implementation).
- `data-state` + `aria-label` give us a stable test hook and a screen-reader label.

## Endpoint

`server/src/server.ts` adds one route, after the existing `/api/sessions` block:

```ts
app.get("/api/memory/health", async (c) => {
  const h = await memory.health();
  return c.json({ ltm: h.ltm ?? null });
});
```

`memory` is already imported by other routes in this file (verify during implementation —
fall back to `import * as memory from "./memory/index.ts"` if not).

Auth: covered by the existing `/api` bearer-token middleware (already excludes only `/login`
and `/ws`).

## Polling hook in useApp

```ts
const LTM_UNHEALTHY_THRESHOLD = 3;
const LTM_POLL_MS = 10_000;

const [ltmState, setLtmState] = useState<HealthState>("unknown");
useEffect(() => {
  let cancelled = false;
  async function tick() {
    try {
      const r = await api<{ ltm: LtmHealth | null }>("/api/memory/health");
      if (cancelled) return;
      if (!r.ltm) { setLtmState("unknown"); return; }
      setLtmState(
        !r.ltm.reachable || r.ltm.consecutiveFailures >= LTM_UNHEALTHY_THRESHOLD
          ? "bad" : "ok"
      );
    } catch { if (!cancelled) setLtmState("unknown"); }
  }
  void tick();
  const id = setInterval(tick, LTM_POLL_MS);
  return () => { cancelled = true; clearInterval(id); };
}, []);
```

`LtmHealth` is a copy of the server's `HealthResult["ltm"]` shape, lifted into
`web/src/lib/types.ts` next to `ServerEvent`.

Last error message is exposed on the tooltip text in `App.tsx`:

```ts
const ltmTitle =
  ltmState === "unknown" ? "LTM: status unknown" :
  ltmState === "ok"      ? "LTM: healthy"        :
  `LTM: ${ltmLastError ?? "unhealthy"}`;
```

`useApp` also exports `ltmLastError: string | undefined` (the `lastError?.message` from the
last poll response) so `App.tsx` can build that tooltip.

## Tests

Server (`server/src/server.health.test.ts` — new):
- `GET /api/memory/health` returns `{ ltm: { reachable, consecutiveFailures, ... } }` when a
  reconciler is attached.
- `GET /api/memory/health` returns `{ ltm: null }` when no reconciler is attached.
- `GET /api/memory/health` requires the bearer token (401 without).

Web (`web/src/components/HealthIcon.test.tsx` — new):
- Renders `Plug` for `kind="ws"`, `Brain` for `kind="ltm"`.
- `data-state` reflects the `state` prop ("unknown" / "ok" / "bad").
- `aria-label` and `title` both reflect the `title` prop.

Web (`web/src/useApp.health.test.ts` — new, polling hook):
- Initial render: `ltmState === "unknown"`, `wsState === "unknown"`.
- After mocked fetch returns `{ ltm: { reachable: true, consecutiveFailures: 0 } }`:
  `ltmState === "ok"`.
- After mocked fetch returns `{ ltm: { reachable: true, consecutiveFailures: 3 } }`:
  `ltmState === "bad"`.
- After mocked fetch returns `{ ltm: { reachable: false, ... } }`: `ltmState === "bad"`.
- After mocked fetch rejects: `ltmState === "unknown"`.
- After mocked fetch returns `{ ltm: null }`: `ltmState === "unknown"`.

(WS state tested implicitly through `connected` callback — already covered today by the
ws.ts shape; we only rename the field, not the behavior.)

## Acceptance (lifted from issue + comment)

- Two icons appear top-right on both mobile and desktop.
- On cold start, both icons render with **gray** outline.
- Once WS connects, plug turns **green**; disconnect → **red**.
- Healthy LTM (the steady-state for a normal ytsejam run) → brain **green** within ≤10s of
  page load.
- Forcing LTM unhealthy (e.g. `chmod 000 ~/.ytsejam/data/ltm`, restart, wait one tick) →
  brain **red** within ≤30s. Reverting → brain **green** within ≤10s.
- E2E or manual smoke documented in the PR description.

## Out of scope (v1)

- No retry-from-UI button (consistent with the original issue).
- No push channel for LTM health.
- No banner / no "see logs for details" link — tooltip is the whole story.
- No history view of past unhealthy episodes.
