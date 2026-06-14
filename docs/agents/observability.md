# Observability

> Sub-doc of [`OVERVIEW.md`](OVERVIEW.md). Code: `server/src/events.ts`
> (the `ServerEvent` bus), `server/src/compaction.ts` (compaction event
> shapes), `server/src/manager.ts` + `server/src/task-manager.ts`
> (compaction lifecycle emissions), `server/src/memory/bridge/ltm-reconciler.ts`
> (LTM bridge health), `web/src/components/HealthIcon.tsx` and
> `web/src/useApp.ts` (UI surfaces).

There is **no metrics endpoint, no Prometheus, no OpenTelemetry**. ytsejam's
observability is a small set of structured signals you can read live (web
UI) or after the fact (per-session JSONL + cog dev-log + stdout/stderr to
the systemd journal). This doc describes what's there and where to look.

## The event bus — `server/src/events.ts`

`EventBus` is a synchronous in-memory pub/sub. The `ServerEvent` union is
what the WebSocket relays to the browser:

| Event | Carrier of |
| --- | --- |
| `agent` | a raw `AgentEvent` from pi-agent-core (token stream, tool calls, etc.) for one session |
| `session_meta` | the indexer's `SessionRow` plus live `running` + `compacting` flags |
| `session_archived` / `session_unarchived` | soft-delete state change |
| `task` | a `TaskRow` snapshot after a delegated-task state change |
| `schedule` | a `ScheduleRow` snapshot after a schedule state change |
| `compaction_start` | a session began compacting (`trigger: "proactive" \| "reactive"`) |
| `compaction_end` | a session finished compacting (`status: "succeeded" \| "surrendered" \| "failed"`) |

The bus is the single fan-out point for "the server changed state, tell
everyone." UI subscribers route events into React state; tests subscribe
to drive assertions; the manager emits `session_meta` whenever the live
running/compacting flags flip so the sidebar pill stays in sync.

## Compaction telemetry

Compaction is the busiest source of structured observability because it's
async, can fire from three entry points, and can quietly surrender. Every
compaction produces (in order):

1. **Live UI signal — `compaction_start` / `compaction_end` bus events.**
   `markCompactionStart` / `markCompactionEnd` in `manager.ts` (and the
   subagent equivalent in `task-manager.ts`) flip the per-session
   `compacting` flag and emit the bus event. The chat header renders a
   "compacting…" pill while `compacting === true`; the sidebar item shows
   the same indicator for any session not currently focused. See
   `docs/plans/2026-06-13-compaction-pill.md` for the design and Open
   Questions (notably: a reactive retry-exhaust surrender emits
   `compaction_end{status:"surrendered"}` only on the surrender path,
   not paired with a synthetic `compaction_end{succeeded}` — the prior
   successful compaction already emitted that).
2. **One-line dev-log entry.** `formatDevLogLine(event)` formats:

   ```
   YYYY-MM-DD HH:MM:SS: compaction in session <id>[ subagent task <tid> (parent session <id>)] —
     <trigger>, <model>, ctx ~<before>→~<after> tokens, summary <S> tokens,
     files-read [<list>], files-edited [<list>]. Trigger: <reason>.[ FAILED] via=<entryPoint>
   ```

   appended to the cog dev-log (so it's grep-able alongside other system
   activity).
3. **Structured JSONL record.** `serializeJsonRecord(event)` writes the
   full `CompactionEvent` (snake_case keys) to a `.compactions.jsonl`
   sidecar next to the pi session file. Read this offline to reconstruct
   exactly what happened — model, contextWindow, reserveTokens,
   keepRecentTokens, tokens_before_estimated, tokens_after_estimated,
   summary_tokens, first_kept_entry_id, files_read/files_modified,
   compaction_duration_ms, succeeded, backup_path, **entry_point**.

The `entry_point` field is one of `"idle" | "inner_loop" | "reactive_path"`
and distinguishes the three call sites that can drive a compaction:

- **`idle`** — proactive between-turn compaction (autonomous-run hook in
  `task-manager.ts`, the original #71 path).
- **`inner_loop`** — proactive *inside* the next turn, fired from the
  `context` event handler before the LLM call (#70 PR 2). Uses pi's pure
  `prepareCompaction()` helpers to bypass `harness.compact()`'s
  `phase==="idle"` guard, so an autonomous run can compact without
  yielding to the outer turn boundary.
- **`reactive_path`** — the backstop after a context-overflow stop reason
  (`stopReason === "error"` + `isContextOverflow`). Triggers a one-shot
  compact-and-retry; if the retry hits the same overflow, the manager
  surrenders with a synthetic assistant diagnostic message rather than
  re-trying indefinitely.

`buildCompactionEvent()` is the **pure** assembler — fed `(model, sessionFilePath,
result, compactionEntry, entryPoint)` and returning the full record. The
labeling reads `trigger / reason / tokensBefore` from `result.pending`
(snapshotted by the orchestrator **before** the race-safety clear), not from
live state — see the "Snapshot race-cleared state" lesson below.

### `succeeded` gate

A trim that runs to completion does NOT automatically count as success.
`buildCompactionEvent()` post-checks `tokensAfterEstimated < budget` — if
one giant tool result still dominates `keepRecentTokens` after the trim,
`succeeded = false` and `reason = "KEPT_SET_OVERSIZED:..."` so the caller
has a signal to surrender (issue #72 / #76). Without this gate the next
turn would re-enter the same overflow loop with no way out.

### Reserve-tokens cap (issue #75)

`computeReserveTokens(model)` is `min(max(model.maxTokens + 16384, 32768),
floor(model.contextWindow * 0.5))`. The 0.5×contextWindow cap protects
small-context models — without it a model with `contextWindow < target`
produced a negative budget, making `shouldCompact()` fire on every turn.
For production-sized models (cw ≥ 200k) the cap is dormant.

## Health icons (`web/src/components/HealthIcon.tsx`)

The chat header carries two `lucide-react` icons in the top-right:

- **`Plug`** — WebSocket connection state.
- **`Brain`** — LTM bridge health.

Each is a 1px outline whose color encodes a `HealthState`:

| State | Color (semantic token) | Meaning |
| --- | --- | --- |
| `unknown` | `text-muted-foreground` | initial mount, before first signal |
| `ok` | `text-success` | last signal was healthy |
| `bad` | `text-destructive` | last signal was unhealthy / disconnected |

Hover surfaces a tooltip with a one-liner. Implementation rules baked in
for accessibility (see the file's own comment + issue #116):

- `role="img"` (not `"status"`) — `status` implies `aria-live="polite"`,
  which would re-announce the tooltip on every poll. `aria-label` carries
  the accessible name.
- `border-current` is **load-bearing**: the ring inherits `text-*` from
  the same color slot as the icon stroke, so the single class drives both.
  Don't "simplify" it.

`HealthState` is the canonical type (SSOT in `web/src/lib/types.ts`,
hoisted from `useApp.ts` by #117). Both substrates use it.

### Where the state comes from

- **WebSocket (`wsState`)** — `useApp.ts` flips it to `ok` on connect,
  `bad` on close, `unknown` while the connect-watchdog still considers
  the socket "connecting" (#116 quieted spurious `bad` flashes during
  reconnect by adding the watchdog).
- **LTM bridge (`ltmState`, `ltmLastError`)** — `useApp.ts` polls
  `GET /api/memory/health` and routes the `{ltm}` payload into state.
  Decision rule:
  - response omits `ltm` (no reconciler attached) → `unknown`
  - `ltm.reachable === true` && `ltm.consecutiveFailures === 0` → `ok`
  - else → `bad` with `ltmLastError = ltm.lastError?.message`

The "omitted vs explicit `null`/`undefined`" distinction matters: the
server returns `{ltm: h.ltm ?? null}` and the response shape uses
**presence** to mean "the bridge is wired and reporting." See
[`memory-bridge.md`](memory-bridge.md) § Public surface for why the
backend honors that distinction.

## Memory health (`/api/memory/health`)

Bearer-gated REST endpoint returning the LTM tick snapshot:

```json
{
  "ltm": {
    "reachable": true,
    "consecutiveFailures": 0,
    "lastTickAt": "2026-06-13T18:00:00.123Z",
    "lastTickStats": {
      "scannedFiles": 7,
      "scannedLines": 412,
      "replayed": 0,
      "skipped": 412,
      "errors": 0
    }
  }
}
```

`lastError.message` is scrubbed: the absolute `dataDir` prefix is replaced
with `<data>` server-side before it ever leaves the reconciler. Operator
paths shouldn't be on the wire even on a bearer-gated endpoint.

Plain stats are also reachable via `cog_rpc({method:"health"})` (full cog
health envelope including the `ltm` block).

## Per-tick INFO line

The reconciler logs `tick complete` at INFO with the same stats fields
the health endpoint surfaces (`scannedFiles / scannedLines / replayed /
skipped / errors`). Tail the systemd journal (`journalctl --user -fu
ytsejam`) to watch the bridge work; absence of these lines after the
default 5-minute interval is itself a signal.

## Snapshot Race-Cleared State Before A Downstream Await

When code eagerly clears state for race-safety before an `await`, treat that state as gone for any downstream or third-party listener — third-party libraries may emit synchronously inside the awaited call and read the cleared state. Capture an explicit snapshot before clearing, thread it through the return value, and write observer-visible records caller-side after the orchestrator returns. Add a wiring test that asserts the snapshot drives the labels — pure-helper tests don't catch this. Generally: never derive observer-visible facts from mutable state a race-safety clear has destroyed.

(seen in: `runCompactionIfPending` nulled `pendingCompaction` before `harness.compact()`; pi's `session_compact` handler ran synchronously inside, read null, mislabeled every reactive compaction as proactive)

_Added: 2026-06-12 | Task: Task 5: orchestrator + main-session wiring_
