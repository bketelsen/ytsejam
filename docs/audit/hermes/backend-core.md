# ytsejam Backend Core — Correctness Audit

**Scope:** agent-hosting runtime, concurrency, crash-safety, lifecycle.
**Files audited:** `manager.ts`, `task-manager.ts`, `tasks.ts`, `scheduler.ts`, `schedules.ts`, `indexer.ts`, `index.ts`, `approval/*.ts`, `events.ts` (+ callers/callees: `server.ts`, `config.ts`, `persona.ts`, `ltm-reconciler.ts`, `dream/scheduler.ts`, and the vendored `@earendil-works/pi-agent-core` harness to confirm abort/prompt semantics).
**Method:** read + trace; verified against the existing test suite under `server/test/`; confirmed harness behavior in `node_modules/@earendil-works/pi-agent-core/dist/harness/agent-harness.js`.

> Note: this is a READ-ONLY audit. No files were modified.

## Ranked summary

| # | Sev | Title | Location |
|---|-----|-------|----------|
| 1 | HIGH | Abort/shutdown never cancels pending approvals → `harness.abort()` hangs up to 5 min, defeating graceful drain & `POST /abort` | `manager.ts:920-942`, `approval/coordinator.ts:79` (uncalled), `approval/wrap-tool.ts:47`, `index.ts:504-540` |
| 2 | HIGH | Concurrent sendMessage/injectMessage races the `running` gate → dropped task report / scheduled prompt / user message + corrupted `running` flag | `manager.ts:830-848`, `manager.ts:859-874` |
| 3 | MEDIUM | Harness cache `this.open` is never evicted → unbounded `AgentHarness` + subscription leak for process lifetime | `manager.ts:195`, `:240`, `:266` (no `.delete` anywhere) |
| 4 | MEDIUM | Boot sequence & scheduler have no per-item error isolation → one malformed schedule/task JSONL bricks boot or permanently stalls the scheduler | `index.ts:203-208`, `scheduler.ts:83-96`, `:102-118`, `:149-168` |
| 5 | MEDIUM | Floating promise in the task pump can crash the whole process (Node ≥22 unhandled-rejection = exit) | `task-manager.ts:262-265`, terminal record `:668-674` |
| 6 | LOW | Indexer writes after `close()` throw — only `setTitle` guards `isOpen`, siblings don't | `indexer.ts:208-229` vs `:215` |
| 7 | LOW | Rename/title issued mid-run is lost if the process dies before the `agent_end` JSONL flush | `manager.ts:973-983`, `:477-494` |
| 8 | LOW | `postAssistantNote` appends an assistant message with no `running` guard → can interleave with a live turn | `manager.ts:880-918` |
| 9 | LOW | Approval `request()` leaks a pending entry + non-`unref`'d timer (≤5 min) if `onRequest` throws; timer also keeps loop alive at shutdown | `approval/coordinator.ts:52-65` |

Positive guards confirmed (NOT bugs) are listed at the end.

---

## 1. HIGH — Abort & graceful shutdown never cancel pending approvals; `harness.abort()` blocks up to the 5-minute approval timeout

**Files:** `server/src/manager.ts:920-942`, `server/src/approval/coordinator.ts:79-92`, `server/src/approval/wrap-tool.ts:37-66`, `server/src/index.ts:492-540`; confirmed against `agent-harness.js:910-943`.

**The bug.** In ASK mode a gated tool blocks inside its `execute`:

```ts
// approval/wrap-tool.ts:47
const decision = await ctx.coordinator.request({ ... });   // resolves on approve/deny OR the 5-min timeout
if (decision === "approve") return originalExecute(toolCallId, params, signal, onUpdate);
```

The abort `signal` is only handed to `originalExecute` *after* approval resolves — the approval wait itself does **not** observe the abort signal. Meanwhile `AgentHarness.abort()` (vendored) does:

```js
// agent-harness.js:910
async abort() {
  ...
  this.runAbortController?.abort();   // fires the signal the approval wait ignores
  ...
  await this.waitForIdle();           // awaits runPromise — which can't settle until the tool's execute returns
  ...
}
```

`runPromise` cannot settle while the tool sits in `await coordinator.request(...)`. Nothing in the codebase calls `ApprovalCoordinator.cancelSession()` — it is defined (`coordinator.ts:79`) and unit-tested (`approval-coordinator.test.ts`) but wired **nowhere** in `src/` (verified by repo-wide grep). So the only way the request resolves is a human clicking approve/deny over WS, or the internal 5-minute timeout (`index.ts:74` sets `timeoutMs: 5*60*1000`).

**Two concrete failures, both reachable at runtime:**

1. **`POST /api/sessions/:id/abort` hangs for up to 5 minutes.** `server.ts:347-350` → `manager.abort(id)` → `await opened.harness.abort()` → blocks on `waitForIdle()`. The user clicks "stop", the HTTP request never returns, and the agent keeps a tool pending.

2. **Graceful shutdown is defeated.** The documented drain order (`index.ts`) closes every WebSocket with 1001 in **step 2** (`:504-510`) *before* `manager.abortAll()` in **step 4** (`:529`). Once the WS clients are closed, no human can resolve the approval, so `abortAll()` → `harness.abort()` → `waitForIdle()` blocks until the 5-min timeout. `server.close()` (step 3) also waits on the still-in-flight `/abort` request if one is outstanding. This blows straight past systemd's `TimeoutStopSec=45` → SIGKILL — exactly the "bug signal, not the expected restart path" the graceful-shutdown design (OVERVIEW.md, observability.md §Process lifecycle) says must never happen.

**Trigger:** session in ASK mode (or a `/careful` turn), agent calls a gated tool (`bash`/`write`/`edit`/`delegate`/`schedule`/`cancel_schedule`), approval card is pending, then the user aborts or the service restarts.

**Why it's real, not theoretical:** `cancelSession` exists and is tested precisely for this, but the abort paths never invoke it. The harness `abort()` genuinely awaits `waitForIdle()` (vendored source confirmed), and the approval `request()` promise genuinely ignores the abort signal (`wrap-tool.ts`).

**Fix direction:** in `manager.abort(id)` and `manager.abortAll()`, call `approvalCoordinator.cancelSession(id, "deny")` (or a new `"aborted"` decision) **before/alongside** `harness.abort()`, so the pending `request()` resolves immediately and `runPromise` can settle. Consider also threading the run's abort signal into `coordinator.request()` so an abort short-circuits the wait even outside the manager. Make the approval timer `unref()` (see #9).

---

## 2. HIGH — Concurrent `sendMessage`/`injectMessage` race the `running` gate: a turn-start is silently dropped and the `running` flag is corrupted

**File:** `server/src/manager.ts:825-848` (`sendMessage`), `:855-874` (`injectMessage`).

**The bug.** Turn-start is guarded only by the `opened.running` boolean, but there is an `await` **between** the read of `running` and its write:

```ts
async sendMessage(id, text) {
  const opened = await this.getOrOpen(id);           // await #1
  ...
  if (opened.running) { await opened.harness.steer(effectiveText); return; }   // CHECK running
  const sessionMode = ...;
  opened.currentEffectiveMode.value = override ?? sessionMode;
  if (!(await this.runPendingCompactionAtIdle(opened, "idle"))) return;        // await #2  ← window
  opened.running = true;                              // SET running (too late)
  opened.currentTurnText = effectiveText;
  opened.harness.prompt(effectiveText).catch((err) => { ...; opened.running = false; });
}
```

`runPendingCompactionAtIdle` is `async` and yields a microtask even on its fast path (`return true` when nothing is pending, `manager.ts:619-623`). So two turn-starts that arrive while the session is idle can **both** pass `if (opened.running)` (neither has set it yet), both `await`, then both call `harness.prompt()`. The second `prompt()` throws `"busy"` (`agent-harness.js:541-543`, `phase !== "idle"`), is caught at `:842`/`:870`, logged, and its message text is **discarded**. Worse, that `.catch` sets `opened.running = false` while the winning turn is still live — so `isRunning()` now lies, the UI shows idle, and the *next* message tries `prompt()` again → another `"busy"` until the live turn's `agent_end` resets the flag.

**Why it's reachable in normal single-user use:** `injectMessage` is the delivery path for **both** background task completions (`task-manager.ts:681` → `notifyParent` → `manager.injectMessage`) **and** scheduled prompts (`scheduler.ts:164` → `inject` → `manager.injectMessage`), and `sendMessage` is the user path. These are not user-coordinated: a task finishing or a schedule firing at the same moment the (idle) user sends a message interleaves through the await window above. The loser is dropped with only a `console.error`. For a task this means the **`[Task ...] completed` report is silently lost**; for a schedule, the **scheduled prompt never runs**; for the user, their message vanishes.

**Fix direction:** make turn-start atomic. Set a synchronous `starting`/`running` flag *before* the first `await` (and clear it on the failure paths), or serialize per-session turn-starts through an async lock/queue so a racing inject is forced down the `steer`/`followUp` path instead of a second `prompt()`. The `runPendingCompactionAtIdle` await must not sit between the gate read and the gate set.

---

## 3. MEDIUM — `AgentManager.open` harness cache is never evicted (unbounded harness/subscription leak)

**File:** `server/src/manager.ts:195` (`private readonly open = new Map<...>()`), inserted at `:240` (`createSession`) and `:266` (`openSession`).

**The bug.** Repo-wide there is **no** `this.open.delete(...)` (grep confirmed: only `.set`, `.get`, `.values`). Every session a user ever opens or creates installs a live `AgentHarness` — which holds the full pi session context, an event-bus subscription (`:393`), and a `context`-hook handler (`:409`) — and that entry lives for the entire process lifetime. There is no LRU, no TTL, and `archiveSession` deliberately leaves the entry alone (`:1057-1065`). The process is a long-running systemd service ("runs for weeks"), so this grows without bound.

Secondary effects: `abortAll()` (`:931`) sweeps **every session ever opened**, not just active ones; and the per-harness bus subscription is never released, so the `EventBus.listeners` set grows in lockstep.

**Why it's real:** confirmed by absence of any eviction call site; corroborated by storage.md ("keeps a cache of open sessions") with no documented release path.

**Fix direction:** add an eviction policy — close + `open.delete()` on an idle TTL (only when `!running && !compacting && pendingTitle === undefined`), an LRU cap, and/or eviction on archive. Each harness's `subscribe`/`on` returns an unsubscribe fn (currently discarded at `:393`/`:409`); capture and call them on eviction.

---

## 4. MEDIUM — Boot sequence and scheduler have no per-item error isolation; one bad JSONL record bricks boot or stalls the scheduler permanently

**Files:** `server/src/index.ts:203-208`, `server/src/scheduler.ts:83-96` (`tick`), `:102-118` (`catchUp`), `:149-168` (`fire`).

**The bug.** The boot rebuild/recovery chain is unguarded:

```ts
// index.ts:203-208 — no try/catch around any of these
await manager.rebuildIndex();
await taskManager.rebuildIndex();
await taskManager.recoverInterrupted();
await scheduler.rebuildIndex();
await scheduler.catchUp();
scheduler.start();
```

`scheduler.catchUp()` and `scheduler.tick()` iterate folded schedules and call `computeNextFire(row.spec, now)` (`schedules.ts:42-45`), which **throws** on a cron expression `cron-parser` rejects. In `fire()` the throwing call is evaluated as an *argument* to `record()`:

```ts
// scheduler.ts:152-158
this.record({ type: "fired", scheduleId: row.id, firedAt: now.toISOString(),
  nextFireAt: row.spec.type === "cron" ? computeNextFire(row.spec, now) : null,  // throws here
  timestamp: now.toISOString() });
```

There is no per-row `try/catch` in `tick()`'s loop (`:88-92`) or `catchUp()`'s loop (`:104-117`). Consequences:

- **Boot crash:** a single un-parseable cron (or a `once` row that throws while folding) in `schedules/schedules.jsonl` makes `catchUp()` throw → propagates out of `index.ts:207` → the server **never reaches** `createApp`/`serve` (`index.ts:567-577`). No HTTP listener, no recovery, no shutdown handlers.
- **Permanent scheduler stall:** at runtime, one bad row makes every `tick()` throw mid-loop, so *all other due schedules stop firing* and the failure repeats every 30 s forever.

Because schedules/tasks JSONL is the **hand-editable SSOT** (and specs may also drift across versions), a malformed record is a reachable input, not a hypothetical. `manager.rebuildIndex()` already isolates per-session (`manager.ts:1102`) — proving the pattern is expected — but the scheduler and the boot chain do not.

**Fix direction:** wrap each `await this.fire(row)` / `record(rescheduled)` in a per-row `try/catch` (log + skip the bad schedule, keep firing the rest); pre-validate `computeNextFire` before building the event. Wrap the `index.ts:203-208` boot steps so a derived-state rebuild failure degrades gracefully (server still boots) rather than aborting the whole process.

---

## 5. MEDIUM — Floating promise in the task pump can crash the entire process

**File:** `server/src/task-manager.ts:258-267` (`pump`), terminal record at `:668-674`.

**The bug.**

```ts
// task-manager.ts:262
void this.run(taskId).finally(() => {
  this.runningCount--;
  this.pump();
});
```

`.finally()` does **not** absorb a rejection — it re-raises whatever `run()` rejected with. `run()`'s terminal bookkeeping runs **outside** any `try/catch`:

```ts
// task-manager.ts:668-674
if (this.opts.store.fold(taskId)?.status === "cancelled") return;
if (outcome.type === "completed") {
  this.record({ type: "completed", ... });   // store.append (fs) + indexer.upsertTask (sqlite)
} else {
  this.record({ type: "failed", ... });
}
```

If `record()` throws — `fs.appendFileSync` on a full/`EACCES` disk, or `indexer.upsertTask` against a sqlite handle closed during shutdown — `run()` rejects, `.finally()` propagates it, and the `void`-discarded promise becomes an **unhandled rejection**. Under Node ≥22 (the project's required runtime) the default `--unhandled-rejections=throw` **terminates the process**. So a single task settling during an I/O fault escalates from "one failed task" to "server down."

**Why it's real:** the pattern is a textbook floating-promise-with-`finally` crash vector; the only thing standing between it and a crash is `record()` never throwing, which is not guaranteed (disk faults, shutdown-window sqlite close). The slot accounting itself is fine (`.finally` still decrements), but the rejection escapes.

**Fix direction:** change to `void this.run(taskId).catch((err) => console.error(...)).finally(...)`, or wrap `run()`'s terminal `record()`/notify block in `try/catch`. Consider a process-level `unhandledRejection` handler as a backstop (none exists today — grep confirms only SIGTERM/SIGINT are registered).

---

## 6. LOW — Indexer writes after `close()` throw; only `setTitle` is guarded

**File:** `server/src/indexer.ts:215` (guarded) vs `:208-212`, `:219-229`, `:185-206`, `:263-285`, `:298-321` (unguarded).

**The bug.** `setTitle` defends against a closed handle:

```ts
// indexer.ts:214-217
setTitle(id, title) {
  if (!this.db.isOpen) return;
  this.db.prepare("UPDATE sessions SET title=? WHERE id=?").run(title, id);
}
```

but `touchSession`, `setUnread`, `setArchived`, `setApprovalMode`, `upsertSession`, `upsertTask`, `upsertSchedule`, `getSession`, etc. do not. `indexer.close()` is the **last** drain step (`index.ts:549-554`), but several deferred callbacks are scheduled with `setTimeout(0)` during the final turn — LTM ingest (`manager.ts:500`), title generation (`:498`), pending-title flush (`:483`), reactive-retry prompt (`:556`) — and can fire *after* `close()`, hitting unguarded reads/writes on a closed DB. Most are wrapped in caller-side `try/catch` (the `harness.subscribe` catch at `:393`, `maybeGenerateTitle`'s blanket catch at `:1195`), so today this surfaces as logged noise rather than a crash. It's an asymmetric, fragile contract: a single test exists (`indexer-setTitle-after-close.test.ts`) for `setTitle` only.

**Fix direction:** either guard all mutating/reading methods with `if (!this.db.isOpen) return;` uniformly, or guarantee no indexer call can be scheduled after `close()` (drain the deferred `setTimeout(0)` callbacks before step 7).

---

## 7. LOW — Rename/title issued mid-run is lost on a crash before the `agent_end` flush

**File:** `server/src/manager.ts:973-983` (`rename`), `:477-494` (`agent_end` `pendingTitle` flush).

**The bug.** When a rename lands during a live turn, the index/UI update immediately but the JSONL (SSOT) write is deferred to `agent_end` via `opened.pendingTitle`:

```ts
// manager.ts:975-982
if (opened.running) { opened.pendingTitle = title; }   // JSONL deferred
else { await opened.session.appendSessionName(title); }
this.opts.indexer.setTitle(id, title);                 // index leads
```

If the process dies between the `indexer.setTitle` and the deferred `agent_end` `appendSessionName` (`:485`), boot's `rebuildIndex` reads the title back from `session.getSessionName()` (JSONL, `:1081`) — which never received it — and the rename is silently lost. This is acknowledged as a deliberate "index leads JSONL by one turn" tradeoff in storage.md, so it's low severity, but it is a genuine crash-window gap where the derived index briefly holds state the SSOT doesn't, and a crash resolves it by losing the user's edit rather than replaying it.

**Fix direction:** acceptable as-is given the design note; if tightened, write the session-name to JSONL immediately even mid-run (pi supports `pendingSessionWrites` queuing for model/tool/thinking changes — a name change could ride the same mechanism) so SSOT never lags the index.

---

## 8. LOW — `postAssistantNote` appends an assistant message with no `running` guard

**File:** `server/src/manager.ts:880-918`.

**The bug.** `postAssistantNote` (used by the nightly dream report, `index.ts:411`) calls `opened.harness.appendMessage(message)` and emits synthetic `message_*`/`turn_end` events without checking `opened.running`. If the target session happens to be mid-turn, this interleaves a manual `appendMessage` with the live agent loop's own session writes, and fabricates a `turn_end` while a real turn is in flight. The dream job targets a dedicated "Memory maintenance" session that is normally idle, so collision is unlikely — hence LOW — but there is no guard enforcing it.

**Fix direction:** guard on `!opened.running` (or `await waitForIdle(id)`) before appending, or route the note through the same idle-serialized turn-start path as `injectMessage`.

---

## 9. LOW — Approval `request()` leaks a pending entry + non-`unref`'d timer if `onRequest` throws; timer keeps the loop alive at shutdown

**File:** `server/src/approval/coordinator.ts:52-65`.

**The bug.** Two minor issues:

```ts
request(input) {
  const approvalId = randomUUID();
  const fullRequest = { approvalId, createdAt: Date.now(), ...input };
  return new Promise((resolve) => {
    const timer = setTimeout(() => { ... }, this.timeoutMs);   // not unref()'d
    this.pending.set(approvalId, { resolve, timer, request });  // entry set...
    this.onRequest(fullRequest);                                // ...before this may throw
  });
}
```

1. If `onRequest` throws synchronously, the Promise executor throws → the promise rejects, but the `pending` entry and its 5-minute timer were already registered and survive until the timeout (a 5-min leak, self-healing). The code comment at `:48-50` acknowledges this. In production `onRequest` is `bus.emit(...)`, and `EventBus.emit` swallows listener errors (`events.ts:43-51`), so it won't throw today — hence LOW/latent.
2. The timeout `setTimeout` is **not** `unref()`'d, so a single pending approval keeps the Node event loop alive for up to 5 minutes. Combined with finding #1 (nothing cancels pending approvals at shutdown), this is a second reason a restart can hang until the timeout.

**Fix direction:** `timer.unref()`; register the pending entry only after `onRequest` succeeds (or wrap `onRequest` in try/catch and clean up on throw). Cancelling sessions on abort (#1) also closes this.

---

## Guards confirmed present (NOT bugs) — verified to avoid false positives

- **Task concurrency pump is balanced** (`task-manager.ts:258-267`): `run()` is `async`, so even synchronous throws settle the promise; `.finally()` always decrements `runningCount` and re-pumps. No leaked slots / off-by-one. (The *rejection escaping* `.finally` is finding #5, separate from slot accounting.)
- **Cancel-wins is atomic** (`task-manager.ts:174-189`, `:668-674`): `cancel()` records `cancelled` before the fire-and-forget `abort()`; `run()`'s final `if (...status === "cancelled") return` is *synchronous* with the subsequent `record()`, so no async task can interleave a late completion past the check.
- **Scheduler `tick()` is serialized** (`scheduler.ts:83-96`) via the `ticking` flag; `fire()` records the `fired` event *before* injecting (`:152-164`), and `injectMessage` is fire-and-forget so a slow turn can't stall the tick. `catchUp()` runs before `start()`, and one-shots become `enabled:false` / crons get a future `nextFireAt`, so there is **no double-fire** on boot. (Robustness gap is finding #4, not a double-fire.)
- **`getOrOpen` de-dups concurrent opens** (`manager.ts:245-255`) via the `opening` in-flight map, so two simultaneous opens share one harness.
- **`abortAll`/`cancelAll` use `Promise.allSettled`** (`manager.ts:931-942`, `task-manager.ts:197-209`) so one failure doesn't strand siblings; both idempotent (covered by `manager-abort-all.test.ts`).
- **Config clamps** task concurrency/timeout to ≥1 with NaN-safe `Math.max(1, Number(x) || default)` (`config.ts:54-55`) — `0`/`NaN` fall back, negatives clamp to 1.
- **Schema-version drop+rebuild is safe** (`indexer.ts:83-103`): tables are derived; boot always rebuilds from JSONL regardless of `wasReset`. WAL checkpoint timer is `unref()`'d and cleared on `close()` (`:99-102`, `:248-256`).
- **Drain order matches the documented contract** (`index.ts:469-558`): scheduler.stop → WS 1001 → server.close → manager.abortAll → taskManager.cancelAll → shutdownLtm → indexer.close; each step in its own try/catch; no `process.exit`. (The *blocking* of step 4 on pending approvals is finding #1.)
- **LTM reconnect timer and dream-scheduler timer are cleared/`unref`'d** (`index.ts:352-355`, `:487`; `dream/scheduler.ts:58,62`; `ltm-reconciler.ts:118,124-130`).
- **Crash-safe LTM partial-init** (`index.ts:300-324`): a failed `MemorySystem.open()` is closed to release the file lock before retry.
- **`EventBus.emit` isolates listener throws** (`events.ts:43-51`).
- **Index writes are JSONL-first** on the durable paths (new session, rename-when-idle, approval-mode, archive sidecar); the index-only fields (`preview`/`unread`/`updatedAt`) are explicitly recomputed by `rebuildIndex`, per storage.md.

---

## Severity rationale

- **HIGH (#1, #2):** directly defeat two load-bearing subsystems — graceful shutdown and reliable message/turn delivery — and cause user-visible loss (hung abort/restart; dropped task reports & scheduled prompts). Both are reachable through ordinary runtime interleavings (ASK-mode approval at restart; a background task/schedule firing while the user types). Not CRITICAL only because neither corrupts the JSONL SSOT and #2 needs a timing window.
- **MEDIUM (#3, #4, #5):** real and reachable (slow memory leak over weeks; boot-brick / scheduler-stall on malformed SSOT; process crash on an I/O fault during task settle) but each requires either long uptime, hand-edited/corrupt JSONL, or a disk/db fault to bite.
- **LOW (#6–#9):** latent or well-contained by existing caller-side `try/catch` and idle-session assumptions; worth tightening but not currently producing failures on the common path.
