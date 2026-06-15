# Design — Graceful shutdown for ytsejam

**Issue:** [#210](https://github.com/bketelsen/ytsejam/issues/210)
**Date:** 2026-06-15
**Status:** Approved, ready for `/write-plan`

## Summary

Extend the existing `process.once("SIGTERM"/"SIGINT", ...)` handler in
`server/src/index.ts` from "drain LTM only" to "drain the whole process, in
order, abort-fast, no `process.exit`." Add the minimum public surface on
`AgentManager` and `TaskManager` to make abort-all possible. Track the
WebSocket client set explicitly (because `@hono/node-ws` doesn't expose it).

**Goal:** `systemctl --user restart ytsejam` exits cleanly in <2 seconds
typical, <10 seconds with active subagent + open session, with zero
`State 'stop-sigterm' timed out. Killing.` lines in journalctl.

## Symptom (from #210)

```
Jun 15 10:26:09 framework systemd[1958]: Stopping ytsejam.service ...
Jun 15 10:26:55 framework systemd[1958]: ytsejam.service: State 'stop-sigterm' timed out. Killing.
Jun 15 10:26:55 framework systemd[1958]: ytsejam.service: Killing process 2122 (node-MainThread) with signal SIGKILL.
```

46s between Stopping and Killing = `TimeoutStopSec=45` + 1s margin.

## Cause (confirmed at `server/src/index.ts:215-260`)

Today's handler only calls `shutdownLtm`. Everything else keeps the event
loop alive until systemd loses patience:

- Hono HTTP server (`@hono/node-server` `serve(...)` at line 251) — never closed
- WebSocket server (`injectWebSocket(server)` at line 260) — clients stay attached
- `SchedulerService` — cron timers + pending `at` jobs
- `AgentManager` — in-flight pi-ai turns on open sessions
- `TaskManager` — active subagent harnesses (up to `YTSEJAM_TASK_CONCURRENCY=4`)
- `Indexer` — sqlite handle + WAL

## Design decisions (the four forks resolved during brainstorm)

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| Q1 | Abort in-flight subagent tasks **immediately** on signal | Budgeted drain (e.g. 20s wait) | ytsejam restarts are deliberate Brian acts; cost of losing a subagent run is "re-run delegate"; budget is dead weight 99% of the time |
| Q2 | Abort in-flight user-facing turns **immediately** too | Short drain budget; rely on `pi-ai` stream's reaction to socket close | JSONL partial-turn reconciliation already exists for crashes; symmetric with Q1 reduces code shape |
| Q3 | Send WebSocket **1001 ("going away") close frame** to every client | Let TCP drop abruptly | Trivial cost; gives the UI's reconnect logic a clean signal so it can show "server restarting…" instead of "connection lost" |
| Q4 | Each drain step in its own **try/catch — log and continue**; no `process.exit` | Bail on first throw + `process.exit(1)` | Matches existing `shutdownLtm` idiom; diagnostic value of the journal line; `process.exit` masks which step failed and looks like a crash to systemd |

## Architecture

One new function in `server/src/index.ts`, replacing the existing two-line LTM
handler:

```ts
// SIGTERM/SIGINT drain — extends the LTM-only handler to drain the whole
// process. Each step is try/caught and logged; the process exits naturally
// once all handles release. We do NOT process.exit — a stuck handle should
// fall through to systemd's SIGKILL at TimeoutStopSec=45 so the offending
// step is visible in journalctl, not masked by a forced exit.
const drainAndExit = async (signal: string): Promise<void> => {
  console.log(`[shutdown] ${signal} received, draining`);

  // 1. Stop accepting new HTTP requests (existing in-flight requests finish)
  await new Promise<void>((resolve) =>
    server.close((err) => {
      if (err) console.warn(`[shutdown] server.close: ${err.message}`);
      resolve();
    })
  );

  // 2. Close every attached WebSocket with code 1001 (going away)
  for (const ws of wsClients) {
    try { ws.close(1001, "server shutting down"); }
    catch (err) { console.warn(`[shutdown] ws.close: ${(err as Error).message}`); }
  }

  // 3. Abort every in-flight user-facing turn (cancel-wins on JSONL;
  //    partial-turn reconciliation already exists for crashes)
  try { await manager.abortAll(); }
  catch (err) { console.warn(`[shutdown] manager.abortAll: ${(err as Error).message}`); }

  // 4. Cancel every active subagent task (records "cancelled" in JSONL,
  //    fires harness.abort fire-and-forget)
  try { await taskManager.cancelAll(); }
  catch (err) { console.warn(`[shutdown] taskManager.cancelAll: ${(err as Error).message}`); }

  // 5. Stop the scheduler (cron timers + at-jobs)
  try { scheduler.stop(); }
  catch (err) { console.warn(`[shutdown] scheduler.stop: ${(err as Error).message}`); }

  // 6. Drain the LTM bridge (existing shutdownLtm logic, inlined or called)
  try { await shutdownLtm(signal); }
  catch (err) { console.warn(`[shutdown] shutdownLtm: ${(err as Error).message}`); }

  // 7. Close the sqlite indexer (finalizes WAL, removes -wal file)
  try { indexer.close(); }
  catch (err) { console.warn(`[shutdown] indexer.close: ${(err as Error).message}`); }

  console.log(`[shutdown] drain complete`);
  // No process.exit. Loop empties → Node exits naturally.
};

process.once("SIGTERM", () => void drainAndExit("SIGTERM"));
process.once("SIGINT", () => void drainAndExit("SIGINT"));
```

The existing `shutdownLtm` stays as-is and is called from step 6. Its
`once`-guard becomes "called once from drainAndExit, also no-op-safe on
double signal."

## New surface (the load-bearing additions)

Three small additions, each ~10 lines:

### 1. `AgentManager.abortAll(): Promise<void>`

Iterate the private opened-sessions map, call `opened.harness.abort()` on
each, await `Promise.all`. Mirror of existing `abort(id)` at
`server/src/manager.ts:739-741`.

### 2. `TaskManager.cancelAll(): Promise<void>`

Iterate the private `active` map (`server/src/task-manager.ts:133`), call
existing `cancel(id)` (line 171) on each id, await `Promise.all`. `cancel()`
already records the cancellation in JSONL and fires `harness.abort()`
fire-and-forget; `cancelAll` just batches.

### 3. WebSocket client tracking — explicit set in `server.ts`

`@hono/node-ws` (`createNodeWebSocket` at `server/src/server.ts:53`) does
not expose the attached client set. Plan:

- Add module-level `const wsClients = new Set<WSContext>()` in `server.ts`
- In each `upgradeWebSocket` handler's `onOpen` callback, `wsClients.add(ws)`
- In `onClose`, `wsClients.delete(ws)`
- Export `wsClients` alongside `app` and `injectWebSocket` from `createApp(...)`
- `index.ts` iterates `wsClients` at shutdown step 2

The alternative — fishing for the underlying `ws.WebSocketServer.clients`
via the Node server — is fragile and tied to library internals. Explicit
tracking is one line per lifecycle hook and survives library upgrades.

## Testing + acceptance

### Unit

- `AgentManager.abortAll()` with N open sessions → all
  `opened.harness.abort()` called, returns once all settle, idempotent on
  re-call.
- `TaskManager.cancelAll()` with N active tasks → all recorded as
  `cancelled` in JSONL, returns once `cancel()` returns for each.

### Manual recipe (documented in `deploy/README.md`)

- **Recipe A (typical):** `systemctl --user restart ytsejam` from a
  quiescent state — assert exit <2s, no SIGKILL line in journal.
- **Recipe B (active subagent):** start a long `delegate` (sleep 60s in a
  bash tool), then `systemctl --user restart` — assert exit <10s, the task
  lands in JSONL with `status: cancelled`, no SIGKILL.
- **Recipe C (active user turn):** start a long-running tool call in a real
  session, then `systemctl --user restart` — assert exit <10s, the
  session's JSONL has the partial turn followed by no `turn_end`, and
  reopening the session in the UI shows the partial turn without crashing.

### Acceptance from #210 (re-verified)

- `systemctl --user stop` exits cleanly in <10s under typical load. ✓ (Recipe A)
- With active subagent + open WS client, no `State 'stop-sigterm' timed
  out. Killing.` line. ✓ (Recipe B)
- Manual recipe documented in `deploy/README.md`. ✓

## Risks

- **`@hono/node-ws` API for `WSContext.close()` is the one piece of
  "verify in the actual code" work.** If the lifecycle hook's `ws` doesn't
  expose `.close(code, reason)`, the WS step degrades to "let TCP drop"
  (Q3-option-2 fallback). Cost: marginally worse reconnect UX, not a
  blocker.
- **`server.close()` waits for in-flight HTTP requests.** A streaming SSE
  endpoint (if any) could hold the close. Plan: audit the route table
  during implementation; if any route holds the response open, the
  abort-all step (which fires *before* server.close awaits in-flight)
  handles it because closing the underlying session also closes the SSE
  stream.
- **`process.once` ignores a second SIGTERM during drain.** If drain
  itself hangs and Brian hits Ctrl-C again, no recovery. YAGNI in v1 —
  systemd's 45s SIGKILL is the existing safety net.

## Explicit non-goals

- No restart-resume of in-flight subagent tasks across restarts. Separate
  brainstorm.
- No change to `TimeoutStopSec=45`. The fix is to actually exit, not to
  wait longer.
- No new "graceful shutdown" library/dependency — this is ~80 lines of
  stdlib Node.

## Open items for `/write-plan`

- **One PR or split** (server-surface PR for `abortAll` / `cancelAll` /
  `wsClients`, then orchestrator PR for `drainAndExit`)? Recommend one PR
  — the orchestrator is the only consumer of the new surface and splitting
  it makes the first PR an unused-export.
