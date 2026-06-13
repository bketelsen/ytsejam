# Inner-loop context compaction — v2 (redesign after v1 inertia bug)

**Status:** approved 2026-06-13. Supersedes the inner-loop portion of `2026-06-13-compaction-inner-loop-hook-design.md`.

**Issue:** #70 — compaction: proactive should fire between turns of an autonomous run.
**Branch:** `compaction-inner-loop-hook-pr2` (PR 2 of two; PR 1 was telemetry, merged as `13a6954` / #88).
**Predecessor:** v1 (commits `954d464`, `238de38`, tagged `pre-redesign-task7-inert`) shipped an inert handler that called `harness.compact()` mid-turn; the wrapper's `phase==="idle"` guard threw `"busy"` 100% of the time, was silently swallowed, and the feature never closed the gap it was named for. Empirically proven by Task 7 quality reviewer. Reset to base.

---

## 1. Background

Pi-agent-core's `AgentHarness.compact()` wrapper requires `this.phase === "idle"` and throws `AgentHarnessError("busy", ...)` otherwise (agent-harness.js:628-629). The inner-loop hook position (`harness.on("context", handler)` → emitted from `transformContext` at agent-loop.js:175-176) runs at `phase === "turn"`. Therefore v1's call into `runPendingCompactionAtIdle` → `runCompactionIfPending` → `harness.compact()` always failed at the wrapper's guard.

The thrown `"busy"` was caught and downgraded inside `runCompactionIfPending` (compaction.ts:691-705), then `runPendingCompactionAtIdle` labeled the result as `"succeeded"` because `surrendered` was falsy (manager.ts:487), and the hook took the happy path returning `undefined`. Net effect: the autonomous run kept growing context until it hit a real provider 400 and fell into the existing reactive backstop at `agent_end`. The named gap stayed open. Telemetry was contradictory: persisted `succeeded:false reason:"busy"` while the live pill emitted `succeeded`.

## 2. Key discovery

Pi-agent-core publicly exports `compact` and `prepareCompaction` as pure functions from `@earendil-works/pi-agent-core` (index.d.ts:5). These are the same functions `AgentHarness.compact()` calls internally (agent-harness.js:639, 660). The pure functions have NO phase guard — the guard is on the wrapper only. `Session.appendCompaction(...)` is also on the public Session interface (session.d.ts:22).

This means inner-loop compaction is achievable WITHOUT patching pi-agent-core: orchestrate `prepareCompaction → compact → session.appendCompaction` directly from inside the `context` hook, bypassing the wrapper's phase guard entirely.

## 3. Architecture

Two compaction paths coexist, distinguished by the phase they run in:

| Path | Trigger | Phase when fired | Mechanism |
|---|---|---|---|
| **Idle / reactive** (existing, unchanged) | `sendMessage`/`injectMessage`; `agent_end` recovery | `idle` | `runPendingCompactionAtIdle` → `runCompactionIfPending` → `harness.compact()` (wrapper, has phase guard — guard is satisfied here) |
| **Inner-loop** (NEW) | `context` hook between turns | `turn` | `runPendingInlineCompactionInLoop` → `runInlineCompactionInLoop` → pure `prepareCompaction` + `compact` + `session.appendCompaction` (no wrapper, no guard) |

Both paths share:
- `markCompactionStart("proactive")` / `markCompactionEnd(endStatus)` pill bookkeeping
- `recordCompactionEvent({ entryPoint, ... })` JSONL + dev-log telemetry (the `entryPoint` field from PR 1 distinguishes them: `"idle"` / `"reactive_path"` for the existing sites, `"inner_loop"` for the new site)
- Surrender semantics: on surrender, `emitCompactionSurrender(opened)` writes the canonical surrender AgentMessage to the session JSONL (persistence trail), AND the inner-loop hook additionally appends an in-context surrender notice so THIS LLM call terminates cleanly with the notice in its view.

The split is at the layer that talks to pi-agent-core. Everything above (telemetry, pill, surrender, kill-switch) is shared.

**Why not unify all three sites on the pure-function path?** The idle and reactive sites run at `phase==="idle"` where `harness.compact()` works correctly and goes through pi's internal session-write code. Replacing them would double the diff size and break a working code path for no benefit. YAGNI.

## 4. Components

### 4.1 New exports in `server/src/compaction.ts`

**`runInlineCompactionInLoop(opened, branchEntries, repo) → Promise<RunInlineCompactionResult>`**

Mirrors `runCompactionIfPending` but uses the pure functions instead of `harness.compact()`. Returns `{fired, succeeded, surrendered?, newMessages?, error?, durationMs?, backupPath?, pending?}`.

Body (pseudocode):

```ts
// 1. snapshot & clear pending flag (same race-safety as idle path)
const pending = opened.compaction.pendingCompaction;
if (!pending) return { fired: false };
const pendingSnapshot = { ...pending };
opened.compaction.pendingCompaction = null;

// 2. backup session JSONL (same as idle path)
const backupPath = await snapshotSessionJsonl(opened.session.metadata.path);
void pruneOldBackups(opened.session.metadata.path, 3);

// 3. prepareCompaction (pure) — returns Result<CompactionPreparation | undefined>
const prepResult = prepareCompaction(branchEntries, DEFAULT_COMPACTION_SETTINGS);
if (!prepResult.ok) return { fired: true, succeeded: false, error: prepResult.error };
if (!prepResult.value) return { fired: false };  // nothing to compact
const preparation = prepResult.value;

// 4. resolve model+auth from harness (mirror AgentHarness.compact())
const model = opened.harness.getModel();
if (!model) return { fired: true, succeeded: false, error: new Error("no model") };
const auth = await opened.harness.getApiKeyAndHeaders(model);
if (!auth) return { fired: true, succeeded: false, error: new Error("no auth") };

// 5. compact (pure) — returns Result<CompactionResult>
const compactResult = await compact(
  preparation, model, auth.apiKey, auth.headers,
  CUSTOM_INSTRUCTIONS, undefined, opened.harness.getThinkingLevel?.()
);
if (!compactResult.ok) return { fired: true, succeeded: false, error: compactResult.error };
const result = compactResult.value;

// 6. append compaction entry to session (fromHook:true mirrors what AgentHarness.compact()
//    does when session_before_compact provides a result)
let entryId: string;
try {
  entryId = await opened.session.appendCompaction(
    result.summary, result.firstKeptEntryId, result.tokensBefore, result.details, true
  );
} catch (err) {
  await restoreSessionFromBackup(opened.session.metadata.path, backupPath);
  return { fired: true, succeeded: false, surrendered: true, error: err };
}

// 7. verify session is still loadable
const verify = await verifySessionLoadable(() => repo.open(opened.session.metadata));
if (!verify.ok) {
  await restoreSessionFromBackup(opened.session.metadata.path, backupPath);
  return { fired: true, succeeded: false, surrendered: true, error: verify.error };
}

// 8. build the AgentMessage[] this turn should use
const newMessages = buildPostCompactionMessages(
  result.summary, branchEntries, result.firstKeptEntryId, model
);
return { fired: true, succeeded: true, durationMs, backupPath, newMessages, compactionEntryId: entryId };
```

**`runPendingInlineCompactionInLoop(opened, branchEntries, entryPoint) → Promise<{ ok: boolean, newMessages?: AgentMessage[], surrendered: boolean }>`**

Shape mirrors `runPendingCompactionAtIdle`. Wraps `runInlineCompactionInLoop` with:
- `markCompactionStart("proactive")` before
- `markCompactionEnd(endStatus)` after (status based on result)
- `recordCompactionEvent({ entryPoint, ... })` after
- `emitCompactionSurrender(opened)` on surrender path (canonical in-session persistence)

This is what the `context` hook actually calls. Symmetric in name and contract with `runPendingCompactionAtIdle`.

**`buildPostCompactionMessages(summary, branchEntries, firstKeptEntryId, model) → AgentMessage[]`**

Converts the pure-function output into the `AgentMessage[]` the hook returns in `ContextResult`. Builds `[summaryAsAssistantMessage, ...slice from firstKeptEntryId forward]`. The summary message uses the canonical compaction-summary shape that `Session.appendCompaction` would write internally (role:"assistant", content:[{type:"text", text:summary}], `isCompactionSummary: true` marker, model/api/provider, zeroed usage). Inspect `session.ts`'s internal compaction-entry conversion for the exact shape; replicate.

**`buildSurrenderAgentMessage(opened, tokens) → AgentMessage`**

Helper extracted to address the v1 quality-review IMPORTANT-severity duplication finding (~26 lines duplicated across `emitCompactionSurrender` and the v1 inert handler). Single source for the surrender AgentMessage construction. Used by:
- `emitCompactionSurrender` (replaces inline construction at manager.ts:524-540)
- The new inner-loop hook handler's surrender path

### 4.2 Hook wiring in `server/src/manager.ts`

In `wire()`, after the existing `harness.subscribe(...)` and before the `compactionEnabled()` block, register:

```ts
harness.on("context", async (event) => {
  try {
    if (!opened.compaction) return undefined;
    if (!opened.compaction.pendingCompaction) return undefined;  // cheap no-op
    const branchEntries = await opened.session.getBranch();
    const result = await this.runPendingInlineCompactionInLoop(
      opened, branchEntries, "inner_loop"
    );
    if (result.ok && result.newMessages) {
      return { messages: result.newMessages };
    }
    if (result.surrendered) {
      return {
        messages: [...event.messages, buildSurrenderAgentMessage(opened, 0)],
      };
    }
    return undefined;
  } catch (err) {
    console.error(
      `[compaction] inner-loop hook failed for session ${opened.session.metadata.id}:`,
      err,
    );
    return undefined;
  }
});
```

The blanket try/catch is mandatory: the hook is awaited by `transformContext`, and an uncaught throw aborts the autonomous run. Any failure must degrade to "preserve original context, fall back to reactive backstop at agent_end."

### 4.3 Mirror in `server/src/task-manager.ts`

Same handler shape inside `task-manager.ts`'s `wire()` site. Must respect the existing `active.compactionRunning` concurrency lock — manager.ts doesn't have this; task-manager does. If `active.compactionRunning === true`, the handler returns `undefined` (deferred; next turn's `context` hook re-evaluates). Same pattern as the existing `runPendingCompactionAtIdle` call site in task-manager.

## 5. Data flow

### Happy path

```
pi-agent-core agent loop, mid-run:
  turn_end (turn N) → prepareNextTurn → shouldStopAfterTurn:false
  streamAssistantResponse (turn N+1) starts
    → transformContext(messages, signal)
       → emitHook({type:"context", messages})
         → OUR HANDLER:
            opened.compaction.pendingCompaction = {...}  // set by earlier turn_end watcher
            session.getBranch() → branchEntries
            runPendingInlineCompactionInLoop(opened, branchEntries, "inner_loop"):
              markCompactionStart("proactive")            → PILL: "Compacting..."
              runInlineCompactionInLoop():
                snapshot+clear pending
                snapshotSessionJsonl()
                prepareCompaction(branchEntries, settings) → preparation
                resolve model + auth
                compact(preparation, model, ...) → {summary, firstKept, ...}
                session.appendCompaction(..., fromHook:true)
                verifySessionLoadable() → ok
                buildPostCompactionMessages() → newMessages
              markCompactionEnd("succeeded")              → PILL: dismissed
              recordCompactionEvent({entryPoint:"inner_loop", succeeded:true})
              return {ok:true, newMessages}
            return { messages: newMessages }
       transformContext returns shrunken messages
    convertToLlm(newMessages) → LLM call uses compacted context
```

### Surrender path

```
... handler fires ...
  runPendingInlineCompactionInLoop:
    markCompactionStart("proactive")
    runInlineCompactionInLoop():
      ... compact() succeeds or fails ...
      session.appendCompaction()         ← if reached
      verifySessionLoadable() FAILS      ← (or compact() returned err)
        → restore from backup
      return {fired:true, succeeded:false, surrendered:true}
    markCompactionEnd("surrendered")     → PILL: dismissed
    recordCompactionEvent({entryPoint:"inner_loop", succeeded:false, surrendered:true})
    emitCompactionSurrender(opened)       → canonical in-SESSION surrender
  return {surrendered:true}
handler returns { messages: [...event.messages, buildSurrenderAgentMessage(opened, 0)] }
  → THIS LLM call sees surrender notice in context; agent's next response terminates
```

The in-context-vs-in-session duplication is intentional: the in-context copy tells THIS LLM call to terminate cleanly with the surrender message in its view; the in-session copy is the durable persistence trail.

### No-op paths (return `undefined`, original context preserved)

- `opened.compaction === undefined` (kill-switch off) — instant
- `opened.compaction.pendingCompaction === null` (nothing pending) — instant, BEFORE calling `getBranch()`
- `prepareCompaction` returns `undefined` (preparation says no work) — return `undefined`

### Concurrency

- `manager.ts`: serial. Hook is per-`opened`; pi's `emitHook` awaits handlers serially.
- `task-manager.ts`: respect `active.compactionRunning` lock. If true on hook entry → `return undefined` (defer).

## 6. Error handling

| Stage | Failure | Internal handling |
|---|---|---|
| Hook handler (outer) | ANY thrown error | `console.error` + return `undefined`. Preserve original context. Fall back to reactive backstop. |
| `snapshotSessionJsonl` | I/O error | Return `{fired:true, succeeded:false, error}`. Mirrors idle path. |
| `prepareCompaction` | `Result.err` | Return `{fired:true, succeeded:false, error}`. |
| `prepareCompaction` | returns `undefined` | Return `{fired:false}`. Not an error. |
| Model/auth resolution | Missing | Return `{fired:true, succeeded:false, error}`. |
| `compact(...)` pure fn | `Result.err` | Return `{fired:true, succeeded:false, error}`. No `appendCompaction`. |
| `session.appendCompaction` | Throws | Restore from backup. Return `{fired:true, succeeded:false, surrendered:true, error}`. |
| `verifySessionLoadable` | Post-write corrupt | Restore from backup. Return `{fired:true, succeeded:false, surrendered:true}`. |

**Observability:** every failure path calls `recordCompactionEvent` with `entryPoint:"inner_loop"`, accurate `succeeded`/`surrendered` flags, and the truncated error message. Pill `markCompactionEnd` status matches. No contradictory observability — v1's pill-says-succeeded-while-jsonl-says-failed bug cannot recur because the wrapper that produces both signals is the SAME function.

**AbortSignal:** v1-scope passes `undefined` to `compact()`. Plumbing through pi-agent-core's loop-level abort signal is a future enhancement.

**Kill switch:** `opened.compaction` is set once at wire time; flipping `YTSEJAM_COMPACTION_ENABLED` doesn't tear it down. Effective kill switch is at boot. Same as existing paths.

## 7. Testing

**Three layers. At least one layer MUST drive a real harness lifecycle.** This is the explicit lesson from v1 — every v1 test mocked `runPendingCompactionAtIdle`, so the test suite was green while the feature was inert.

### Layer 1 — unit tests for the new orchestrator (`server/test/compaction.test.ts`)

Direct tests of `runInlineCompactionInLoop` with pi-agent-core's pure compaction functions mocked at the import boundary:

- `runInlineCompactionInLoop: happy path writes appendCompaction(..., fromHook:true) and returns newMessages`
- `runInlineCompactionInLoop: no-op when prepareCompaction returns undefined`
- `runInlineCompactionInLoop: surrender when appendCompaction throws (backup restored)`
- `runInlineCompactionInLoop: surrender when verifySessionLoadable fails post-write (backup restored)`
- `runInlineCompactionInLoop: error result when compact() returns Result.err`

### Layer 2 — handler integration tests (`server/test/compaction.test.ts`)

Drive the handler through pi-agent-core's `emitHook("context")` (test-only `as any` cast acceptable). NO mocks of `runPendingInlineCompactionInLoop`. This is the v1-anti-pattern fix.

- `inner-loop handler: returns undefined when compaction undefined (kill-switch boot)`
- `inner-loop handler: returns undefined when pendingCompaction null (cheap no-op, getBranch NOT called)`
- `inner-loop handler: returns {messages: newMessages} on happy compaction`
- `inner-loop handler: returns surrender notice when orchestrator surrenders`
- `inner-loop handler: returns undefined on any thrown error (defensive catch logs to console.error)`

### Layer 3 — real-run e2e test (`server/test/compaction-inner-loop-e2e.test.ts`, NEW FILE)

The regression test specifically for the v1 failure mode. Drives an actual multi-turn run with a faux provider; asserts compaction fires mid-loop and the next LLM call sees the compacted context.

- Setup: real `AgentManager` + real `JsonlSessionRepo` + faux provider returning a 2-tool-call response then stop.
- Mid-run: after `turn_end` of turn 1, set `opened.compaction.pendingCompaction = {...}`.
- Mock the **pure `compact()` function** at the import boundary to return a small fixed summary.
- Drive a full `prompt()` through the harness.
- Assert:
  - Faux provider's `streamFunction` called 3 times
  - Call 2's `llmContext.messages` is the COMPACTED array (starts with summary, length < pre-compact length)
  - Session JSONL has a `compaction` entry with the expected summary
  - `recordCompactionEvent` called once with `entryPoint:"inner_loop"` and `succeeded:true`
  - Dev-log line for the inner-loop compaction emitted

If `compact()` mid-loop ever stops working (e.g., pi-agent-core upgrade changes phase semantics), this fails immediately.

### Layer 4 — frontend safety grep (#73 lesson)

`grep -rE "(ContextResult|inner_loop|runInlineCompactionInLoop|runPendingInlineCompactionInLoop)" web/src/` must return zero hits.

### NOT tested

The pure functions themselves (`prepareCompaction`, `compact`). Pi-agent-core's responsibility.

## 8. Task breakdown (deferred to write-plan)

Rough shape — the plan skill expands these into bite-sized tasks:

1. Extract `buildSurrenderAgentMessage` helper (refactor; no behavior change).
2. Add `runInlineCompactionInLoop` + `runPendingInlineCompactionInLoop` + `buildPostCompactionMessages` to `compaction.ts` with Layer 1 unit tests.
3. Wire `context` hook in `manager.ts` with Layer 2 handler tests.
4. Add Layer 3 real-run e2e test.
5. Mirror in `task-manager.ts` with `compactionRunning` lock, same handler shape.
6. Gate + ship (Layer 4 grep verified in gate).

## 9. Out of scope

- Patching pi-agent-core (not needed; pure functions are publicly exported).
- Plumbing pi's loop-level `AbortSignal` to `compact()`.
- Unifying idle/reactive sites onto the pure-function path (YAGNI).
- Changes to the compaction-pill UI (PR #86 already covers all entry points via the shared `markCompactionStart/End` calls).
- Changes to PR 1's `entryPoint` telemetry (already merged in `13a6954`).

## 10. Lessons captured for cog

- **Spike scope:** Verifying an integration's TYPE contract is necessary-not-sufficient. Must also verify the LIFECYCLE/PHASE invariants of every function the integration transitively calls. v1's spike confirmed `harness.on("context", handler)` shape but missed that `harness.compact()` requires `phase==="idle"`. Cog observation appended 2026-06-13.
- **Test that covers the failing call:** v1 was green because all tests mocked `runPendingCompactionAtIdle`. The mandate "at least one e2e test that drives a real lifecycle end-to-end" is the structural fix; Layer 3 is its concrete form.
- **Earendil pure-function escape hatch:** when a pi-agent-core wrapper has a lifecycle guard you can't satisfy, check whether the underlying logic is exposed as pure functions from the same package's public API. Second time this pattern has been useful (`generateBranchSummary`, `prepareBranchEntries` follow the same shape). Cog observation appended 2026-06-13.
