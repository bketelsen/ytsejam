# Design: compaction pill in the web UI

**Date:** 2026-06-13
**Status:** Approved
**Branch (intended):** `compaction-pill`

## Summary

Show a `compacting…` pill in the active session's chat header and an amber pulse dot in the sidebar row while context compaction is in progress for that session. State is driven by two new server-emitted WebSocket events (`compaction_start`, `compaction_end`) plus a new `compacting` boolean on session metadata for reconnect/page-load rehydration.

## Goals

- User sees, at a glance, when a session is compacting (so a delayed response reads as "reorganizing context" not "stuck").
- Awareness of background compactions on non-active sessions (reactive overflow path fires post-`agent_end`, possibly on a session the user isn't watching).
- State survives page reload and WebSocket reconnect (via session metadata).
- Zero impact on existing `running` indicator or message rendering.

## Non-goals

- No tooltip with token counts, durations, or model info (telemetry already lives in JSONL + dev-log via `recordCompactionEvent`; not a UI surface today).
- No differentiation by trigger (proactive vs reactive) or outcome (succeeded vs surrendered) in v1. The events carry these fields for future use; the pill ignores them.
- No animation beyond the existing `animate-pulse` Tailwind utility.
- No "last compaction stats" panel.
- No reconnect-triggered `session_meta` replay for resync (page refresh covers it).

## Architecture

### Server: event surface

Two new variants on `ServerEvent` (`server/src/events.ts`):

```ts
| { type: "compaction_start"; sessionId: string; trigger: "proactive" | "reactive" }
| { type: "compaction_end";   sessionId: string; status:  "succeeded" | "surrendered" | "failed" }
```

These are bus events independent of the harness `AgentEvent` stream — they do **not** go through `FORWARDED_EVENTS`. They are LIGHTWEIGHT-equivalent: every connected client receives them regardless of subscription (sidebar needs them for non-active sessions). The WebSocket fan-out in `server/src/server.ts` already sends all non-`agent` events to every client; verify the new types fall through that path correctly (they will — the gating only filters `type === "agent"`).

### Server: emit sites

`server/src/manager.ts` has three regions where compaction fires. Wrap each with a `compaction_start` emit before the await and a `compaction_end` emit after, mapping outcome to status:

| Call site | Method (approx line) | Trigger | Status mapping |
|---|---|---|---|
| post-`agent_end` reactive retry path | `onHarnessEvent` (~L313) | `"reactive"` | `result.succeeded ? "succeeded" : "surrendered"`; catch → `"failed"` |
| pre-`sendMessage` idle drain | `runPendingCompactionAtIdle` (~L403) | `"proactive"` | same mapping |
| `emitCompactionSurrender` paths that bypass `runCompactionIfPending` | turn_end retry-exhausted surrender (~L370–L373) | (reactive surrender, no new compaction call) | emit `compaction_end{status: "surrendered"}` only if a `compaction_start` was previously emitted for this session — i.e. if we are clearing a flag that was set earlier in the chain |

The emit pair brackets the `runCompactionIfPending` await; a `try/finally` around it guarantees `compaction_end` fires even if the call throws (status `"failed"`).

The bookkeeping rule: `compaction_start` and `compaction_end` are strictly paired per session. Implementation should use the per-session flag (below) as the source of truth and skip a redundant `compaction_end` if `compacting` is already false.

### Server: per-session `compacting` flag

Add a per-session flag on `OpenSession` (or `private compacting = new Set<string>()` on `AgentManager`). Set on emit of `compaction_start`, clear on emit of `compaction_end`. Expose:

- `isCompacting(id: string): boolean`, mirroring the existing `isRunning`.

Surface it through the same two seams `running` uses:

- `emitMeta(id)` is called on `compaction_start` and `compaction_end` so the `session_meta` WebSocket event carries the latest `compacting` value to all clients.
- `GET /api/sessions` and `GET /api/sessions/:id` include `compacting: manager.isCompacting(s.id)` on the row payload.

Update `SessionRow` types and the relevant maps in `server/src/server.ts` to include the new field.

### Web: types and reducer

- `web/src/lib/types.ts`: add the two `ServerEvent` variants and a `compacting?: boolean` field on the session row type.
- `web/src/useApp.ts` `onEvent`: two new cases that set/clear `compacting` on the matching session (mirrors how `running` is mutated from `agent_start`/`agent_end`). The existing `session_meta` case is already a full row replace, so reconnect rehydration is automatic once the server includes `compacting` in that payload.

### Web: visual rendering

- **Sidebar** (`web/src/components/Sidebar.tsx`): change the dot-rendering ternary to prefer compacting over running:
  ```tsx
  {s.compacting ? <span className="size-2 shrink-0 animate-pulse rounded-full bg-warning" /> :
   s.running    ? <span className="size-2 shrink-0 animate-pulse rounded-full bg-success" /> :
   s.unread     ? <span className="size-2 shrink-0 rounded-full bg-primary" /> : null}
  ```
  Verify `bg-warning` resolves in the project's Tailwind config; if not, use `bg-amber-500`.
- **Chat header** (`web/src/components/Chat.tsx`): the component already receives `running`. Add a `compacting: boolean` prop, wired in `App.tsx` from `app.sessions.find(...)?.compacting`. Render a small pill inline near the session title:
  ```tsx
  {compacting && (
    <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-xs text-warning animate-pulse">
      compacting…
    </span>
  )}
  ```
  Use the same color fallback as the sidebar dot if `bg-warning` is absent.

## Data flow

1. Manager about to call `runCompactionIfPending` → set per-session compacting flag → `bus.emit({ type: "compaction_start", sessionId, trigger })` → `emitMeta(id)` so any newly-connected client sees `compacting: true`.
2. WebSocket fans event to all clients; `useApp.onEvent` flips per-session boolean.
3. Sidebar re-renders amber dot; Chat (if active) re-renders pill.
4. `runCompactionIfPending` resolves → manager emits `compaction_end` with status → clear flag → `emitMeta(id)`.
5. Client clears the boolean; dots/pill disappear.
6. Page reload mid-compaction: `GET /api/sessions/:id` returns `compacting: true` → initial render shows the pill/dot. Subsequent `compaction_end` event clears it.

## Error handling

- Server emit sites use `try { emit start; ... } finally { emit end }` so a throw in `compact()` cannot leave the flag stuck-true.
- Manager catches inside `onHarnessEvent` already swallow compaction-bookkeeping errors (existing pattern around manager.ts:243). The new emit calls live inside that catch envelope; no additional swallow needed.
- Worst-case stuck-true flag: the client `compacting` boolean is only authoritative until a `session_meta` re-broadcast, so a bug-induced stale flag self-heals on the next session metadata update (typically every assistant message).
- WebSocket disconnect during compaction: client `compacting` may freeze on `true`. On reconnect, `session_meta` is not replayed automatically — page refresh resolves it. Acceptable for v1.

## Testing

**Server (vitest under `server/src/`):**

- Unit test (new `manager.compaction-events.test.ts` or extend `manager.test.ts`): mock harness `compact()` to resolve / throw / surrender; assert `bus.emit` call sequence is `compaction_start` → `compaction_end{status}` for each of the three trigger paths and the throw path.
- Assert `isCompacting(id)` flips true between the emits and false after, including the throw path.
- Assert `GET /api/sessions/:id` includes `compacting: true` while the flag is set, `false` otherwise.

**Web (vitest under `web/src/`):**

- Unit test on the `useApp` reducer: dispatch `compaction_start` → assert matching session row's `compacting === true`; dispatch `compaction_end` → assert `false`.
- Component test on `Sidebar.tsx`: with `compacting: true` and `running: true`, the rendered dot has the warning/amber class, not the success class.
- Component test on `Chat.tsx`: pill renders when `compacting === true`, absent when false.

**Manual end-to-end (post-merge, on prod):**

1. Open a session, drive context near the compaction threshold (proactive path), watch pill appear in header + amber dot in sidebar during the compaction window.
2. Trigger an overflow 400 on a session the user is not currently viewing (reactive path), watch amber dot appear on the non-active sidebar row, persist through the compaction, and clear when re-prompt starts.
3. Reload the page mid-compaction (timing is tight; can be exercised locally by inserting a `setTimeout(5000)` in `compact()`) — pill/dot present on reload.

## Open questions

None — all answered during brainstorm.

## Out of scope / explicit YAGNI

- Tooltip with token counts.
- Differentiating trigger or status visually (events carry the fields; UI doesn't read them).
- Reconnect-triggered `session_meta` replay for resync.
- "Last compaction" history in a settings panel.
