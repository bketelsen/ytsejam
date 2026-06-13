# Compaction Inner-Loop Hook Implementation Plan

> Execute with the `develop` skill, task-by-task.

**Goal:** Make proactive compaction fire between turns of an autonomous run (not just at idle boundaries) via pi-agent-core's `context` hook event, so long autonomous runs no longer trip the reactive API-400 backstop. Adds an `entryPoint` telemetry field for observability.

**Spec:** [docs/plans/2026-06-13-compaction-inner-loop-hook-design.md](./2026-06-13-compaction-inner-loop-hook-design.md)

**Architecture:** Add `entryPoint: "idle" | "inner_loop" | "reactive_path"` to `CompactionEvent` (telemetry-only, PR 1). Then subscribe to `pi-agent-core`'s `context` event in both `manager.ts` and `task-manager.ts`'s `onHarnessEvent` switch and call the existing `runPendingCompactionAtIdle` helper with `entryPoint:"inner_loop"` (behavior change, PR 2). The `context` hook is used because `pi-agent-core`'s `AgentHarness` does not expose `shouldStopAfterTurn` to consumers — see spec §3.1. On surrender, return a context with a surrender notice appended so the LLM terminates the run naturally.

**Tech Stack:** Node 20+ / TypeScript 5.8 / `@earendil-works/pi-agent-core` / `node --test` runner. Gate via `scripts/gate.sh` (server typecheck + server tests + web build/typecheck/tests).

**Worktree:** `/tmp/compaction-inner-loop-hook`

**Branch:** `compaction-inner-loop-hook`

**Issue:** [#70](https://github.com/bketelsen/ytsejam/issues/70)

---

## PR Layout

- **PR 1 — Telemetry plumbing.** Add `entryPoint` to `CompactionEvent`, thread it through `runPendingCompactionAtIdle`, the reactive path, and both existing call sites (idle from manager + task-manager). No behavior change. Tasks 1-5.
- **PR 2 — Inner-loop hook.** Spike to verify the `context` subscribe-return contract, then wire the new handler in both `manager.ts` and `task-manager.ts` and add the integration tests. Tasks 6-10.

Each PR ends with the gate green and Brian merging via `/ship` before the next PR starts.

---

## PR 1 — Telemetry plumbing

### Task 1: Add `entryPoint` to `CompactionEvent` (type-level)

**Files:**
- Modify: `server/src/compaction.ts` (interface `CompactionEvent` ~line 246; `serializeJsonRecord` ~line 305; `formatDevLogLine` ~line 275; `buildCompactionEvent` ~line 351)

#### Step 1: Write the failing test

Append to `server/test/compaction.test.ts` (find the existing `describe("formatDevLogLine"` or `describe("buildCompactionEvent"` block — append a new test inside whichever exists; if neither, add `describe("entryPoint telemetry field", () => { ... })` at end of file).

```ts
test("CompactionEvent carries an entryPoint field and serializes to snake_case", () => {
  const e: CompactionEvent = {
    timestamp: new Date("2026-06-13T12:00:00Z"),
    sessionId: "sess-1",
    subagentTaskId: null,
    trigger: "proactive",
    entryPoint: "inner_loop",
    reason: "ctx-window-crossed",
    model: "anthropic/claude-opus-4-8",
    contextWindow: 200000,
    reserveTokens: 4096,
    keepRecentTokens: 16384,
    tokensBeforeEstimated: 195000,
    tokensAfterEstimated: 80000,
    summaryTokens: 4000,
    firstKeptEntryId: "entry-42",
    filesRead: [],
    filesModified: [],
    compactionDurationMs: 1234,
    succeeded: true,
    backupPath: "/tmp/backup",
  };
  const record = serializeJsonRecord(e);
  assert.strictEqual(record.entry_point, "inner_loop");
});

test("formatDevLogLine appends via=<entryPoint>", () => {
  const e: CompactionEvent = {
    timestamp: new Date("2026-06-13T12:00:00Z"),
    sessionId: "sess-1",
    subagentTaskId: null,
    trigger: "proactive",
    entryPoint: "inner_loop",
    reason: "ctx-window-crossed",
    model: "anthropic/claude-opus-4-8",
    contextWindow: 200000,
    reserveTokens: 4096,
    keepRecentTokens: 16384,
    tokensBeforeEstimated: 195000,
    tokensAfterEstimated: 80000,
    summaryTokens: 4000,
    firstKeptEntryId: "entry-42",
    filesRead: [],
    filesModified: [],
    compactionDurationMs: 1234,
    succeeded: true,
    backupPath: "/tmp/backup",
  };
  const line = formatDevLogLine(e);
  assert.ok(line.includes("via=inner_loop"), `expected line to include via=inner_loop, got: ${line}`);
});
```

Imports needed at the top of the test file (verify they exist; add if missing):
```ts
import { formatDevLogLine, serializeJsonRecord, type CompactionEvent } from "../src/compaction.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
```

#### Step 2: Run test to verify it fails

```bash
cd /tmp/compaction-inner-loop-hook && env -u NODE_ENV npm --prefix server test -- --test-name-pattern "entryPoint" 2>&1 | tail -20
```

Expected: FAIL with a TypeScript error on `entryPoint: "inner_loop"` (property does not exist on `CompactionEvent`).

#### Step 3: Modify the type and serializers

In `server/src/compaction.ts`:

**Edit 1 — interface (around line 246):** add the field at the end of `CompactionEvent`, before the closing `}`:
```ts
  succeeded: boolean;
  backupPath: string;
  entryPoint: "idle" | "inner_loop" | "reactive_path";
}
```

**Edit 2 — `serializeJsonRecord` (around line 305):** add the snake_case key alongside the other fields, before the closing `}`:
```ts
    succeeded: e.succeeded,
    backup_path: e.backupPath,
    entry_point: e.entryPoint,
  };
```

**Edit 3 — `formatDevLogLine` (around line 275):** extend the returned template literal so the line ends with ` via=<entryPoint>` after the existing failedMarker. Final return:
```ts
  return (
    `${ts}: compaction in ${sessionPart} — ${e.trigger}, ${e.model}, ` +
    `ctx ~${e.tokensBeforeEstimated}→~${e.tokensAfterEstimated} tokens, ` +
    `summary ${e.summaryTokens} tokens, files-read ${filesReadStr}, ` +
    `files-edited ${filesModStr}. Trigger: ${e.reason}.${failedMarker} via=${e.entryPoint}`
  );
```

**Edit 4 — `buildCompactionEvent` (around line 351):** the function currently does not receive `entryPoint`. Add it as a required parameter and pass it through. New signature:
```ts
export function buildCompactionEvent(
  model: Model<any>,
  sessionFilePath: string,
  result: RunCompactionResult,
  compactionEntry: any = {},
  _devLogPath: string | undefined,
  entryPoint: "idle" | "inner_loop" | "reactive_path",
): CompactionEvent {
```

And in the returned object, add as the final field:
```ts
    succeeded,
    backupPath: result.backupPath ?? "",
    entryPoint,
  };
```

(If the existing returned object uses different field-list shape, just add `entryPoint` alongside the others — exact placement does not matter, type-checker enforces presence.)

#### Step 4: Run tests to verify they pass

```bash
cd /tmp/compaction-inner-loop-hook && env -u NODE_ENV npm --prefix server test -- --test-name-pattern "entryPoint" 2>&1 | tail -20
```

Expected: PASS (both new tests).

Also run the full compaction test file to confirm no existing test broke from the `buildCompactionEvent` signature change (the next task fixes the call sites — many tests will still fail; this is expected):

```bash
cd /tmp/compaction-inner-loop-hook && env -u NODE_ENV npm --prefix server test 2>&1 | tail -10
```

Expected: some failures in tests that call `buildCompactionEvent` without the new required arg. Note them — Task 2 fixes the call sites and these will then pass.

#### Step 5: Commit

```bash
cd /tmp/compaction-inner-loop-hook
git add server/src/compaction.ts server/test/compaction.test.ts
git commit -m "feat(compaction): add entryPoint field to CompactionEvent

Telemetry-only field distinguishing where a compaction was fired from
(idle/inner_loop/reactive_path), orthogonal to trigger (proactive/reactive).
Threaded through serializeJsonRecord (snake_case: entry_point) and
formatDevLogLine (appends via=<entryPoint>).

Part of #70."
```

---

### Task 2: Thread `entryPoint` through `runPendingCompactionAtIdle` and update call sites

**Files:**
- Modify: `server/src/compaction.ts` (`runPendingCompactionAtIdle` signature)
- Modify: `server/src/manager.ts` (callers at the idle path and the reactive path; `recordCompactionEvent` and its `buildCompactionEvent` call)
- Modify: `server/src/task-manager.ts` (same shape — callers at the idle path and the reactive path; `recordCompactionEvent` and its `buildCompactionEvent` call)

#### Step 1: Write the failing test

Append to `server/test/compaction.test.ts` inside the same `entryPoint telemetry field` block as Task 1's tests:

```ts
test("runPendingCompactionAtIdle records entryPoint on the resulting event", async () => {
  // Use the existing idle-path test scaffolding pattern at lines 845-971.
  // Construct an OpenedForCompaction with pendingCompaction set, drive
  // runCompactionIfPending through a stubbed harness.compact, and assert
  // the recorded event's entryPoint is whatever we passed in.
  // Three sub-cases: "idle", "inner_loop", "reactive_path".
  for (const entryPoint of ["idle", "inner_loop", "reactive_path"] as const) {
    const opened = makeFakeOpenedForCompaction({ /* same fixture as line 845+ */ });
    opened.compaction.pendingCompaction = {
      trigger: "proactive",
      reason: "test",
      tokensBefore: 200000,
      budget: 100000,
    };
    const result = await runCompactionIfPending(opened, fakeRepo);
    // The new arg lives at the call site (runPendingCompactionAtIdle in
    // manager.ts), not inside runCompactionIfPending. Verify by calling
    // the manager-level helper instead — OR, equivalently, verify by
    // building an event from result and asserting the field.
    const event = buildCompactionEvent(
      fakeModel,
      "/fake/session.jsonl",
      result,
      {},
      undefined,
      entryPoint,
    );
    assert.strictEqual(event.entryPoint, entryPoint);
  }
});
```

**Note for the implementer:** the existing test file (lines 845-971) already constructs `OpenedForCompaction` fixtures. Reuse that exact pattern; do NOT invent new fixture builders. If the existing pattern uses `OpenedForCompaction` directly without a manager instance, the assertion above (calling `buildCompactionEvent` directly with the new arg) is sufficient; the manager-level wiring is verified in Task 3.

#### Step 2: Run test to verify it fails

```bash
cd /tmp/compaction-inner-loop-hook && env -u NODE_ENV npm --prefix server test -- --test-name-pattern "runPendingCompactionAtIdle records entryPoint" 2>&1 | tail -20
```

Expected: FAIL (test does not yet exist + new fixture or compile errors).

#### Step 3: Update `runPendingCompactionAtIdle` signature in the orchestrator

`runPendingCompactionAtIdle` lives in `server/src/compaction.ts` as the orchestrator-side helper (~line 660 per the design doc reference; verify with `grep -n 'runPendingCompactionAtIdle\|runCompactionIfPending' server/src/compaction.ts` and use whatever the actual orchestrator function name is — the manager calls its own private method `runPendingCompactionAtIdle` which wraps the orchestrator's `runCompactionIfPending`).

Inspect the actual structure:

```bash
cd /tmp/compaction-inner-loop-hook
grep -nE 'runPendingCompactionAtIdle|runCompactionIfPending' server/src/compaction.ts server/src/manager.ts server/src/task-manager.ts
```

The `runPendingCompactionAtIdle` that needs the new parameter is the **private method on `Manager` / `TaskManager`** (not the orchestrator), because that's the layer that calls `buildCompactionEvent` via `recordCompactionEvent`. Trace:

- `Manager.runPendingCompactionAtIdle(opened)` (manager.ts ~line 403) calls `runCompactionIfPending` then `this.recordCompactionEvent(opened, result, details)`.
- `Manager.recordCompactionEvent` (manager.ts ~line 494) calls `buildCompactionEvent(...)`.

Add `entryPoint` to both `Manager.runPendingCompactionAtIdle` and `Manager.recordCompactionEvent` signatures, pass through to `buildCompactionEvent`. Mirror the change in `task-manager.ts`.

**Edits:**

1. **manager.ts ~line 403 — `runPendingCompactionAtIdle` signature:**
```ts
private async runPendingCompactionAtIdle(
  opened: OpenSession,
  entryPoint: "idle" | "inner_loop" | "reactive_path",
): Promise<boolean> {
  // ...existing body unchanged except the recordCompactionEvent call below
```

2. **manager.ts inside `runPendingCompactionAtIdle` — `recordCompactionEvent` call:**
```ts
    if (result.fired) {
      await this.recordCompactionEvent(
        opened,
        result,
        opened.compaction.lastCompactionDetails,
        entryPoint,
      );
```

3. **manager.ts ~line 494 — `recordCompactionEvent` signature:**
```ts
private async recordCompactionEvent(
  opened: OpenSession,
  result: RunCompactionResult,
  details: CompactionEntry | undefined,
  entryPoint: "idle" | "inner_loop" | "reactive_path",
): Promise<void> {
```

4. **manager.ts inside `recordCompactionEvent` — `buildCompactionEvent` call:**
```ts
    const compactionEvent = buildCompactionEvent(
      model,
      sessionFilePath,
      result,
      details,
      devLogPath,
      entryPoint,
    );
```

5. **manager.ts — every caller of `runPendingCompactionAtIdle` (two sites: in `sendMessage` ~line 553, in `injectMessage` ~line 574)** passes `"idle"`:
```ts
    if (!(await this.runPendingCompactionAtIdle(opened, "idle"))) return;
```

6. **manager.ts — every caller of `recordCompactionEvent` that is NOT inside `runPendingCompactionAtIdle` (look for the reactive path ~line 333)** passes `"reactive_path"`:
```ts
          await this.recordCompactionEvent(
            opened,
            result,
            opened.compaction.lastCompactionDetails,
            "reactive_path",
          );
```

7. **task-manager.ts:** mirror all the same changes. Greppable call sites:
```bash
grep -nE 'runPendingCompactionAtIdle|recordCompactionEvent|buildCompactionEvent' server/src/task-manager.ts
```

For task-manager, the idle-path entry point is its analog of `sendMessage`/`injectMessage` (the task-launch path). Pass `"idle"` there and `"reactive_path"` for the reactive caller.

#### Step 4: Run tests to verify all pass

```bash
cd /tmp/compaction-inner-loop-hook && env -u NODE_ENV npm --prefix server test 2>&1 | tail -15
```

Expected: PASS for the new test and all previously-failing tests from Task 1 (the `buildCompactionEvent` signature change is now propagated to all callers). Full server suite green.

#### Step 5: Commit

```bash
cd /tmp/compaction-inner-loop-hook
git add server/src/compaction.ts server/src/manager.ts server/src/task-manager.ts server/test/compaction.test.ts
git commit -m "feat(compaction): thread entryPoint through runPendingCompactionAtIdle

All three existing call sites pass their actual entry point:
- Manager.sendMessage / Manager.injectMessage -> 'idle'
- Manager reactive-recovery path -> 'reactive_path'
- TaskManager idle-path -> 'idle'
- TaskManager reactive-recovery path -> 'reactive_path'

The 'inner_loop' value is wired in PR 2.

Part of #70."
```

---

### Task 3: Extend existing idle-path tests with `entryPoint` regression assertions

**Files:**
- Modify: `server/test/compaction.test.ts` (tests around lines 917-971 that exercise the idle path)

#### Step 1: Update the existing tests

Locate the existing idle-path tests at `compaction.test.ts:917-971` (use `grep -n 'pendingCompaction' server/test/compaction.test.ts` to confirm). For each test that calls `runPendingCompactionAtIdle` (or its lower-level fixture-driven equivalent) and inspects the recorded event, add ONE additional assertion:

```ts
assert.strictEqual(recordedEvent.entryPoint, "idle");
```

If the test does not currently inspect the recorded event (only checks `pendingCompaction` is cleared), do NOT add a new inspection — that would expand scope. The minimum is: any test that *already* inspects the recorded event gains one extra assertion line.

If none of the existing idle-path tests inspect the recorded event, add ONE small new test:

```ts
test("idle-path compaction records entryPoint='idle' on the resulting event", async () => {
  // Use the same fixture pattern as the surrounding tests in this file.
  // Drive runPendingCompactionAtIdle (the manager-level method, requires a
  // real Manager instance — reuse the manager test scaffolding from
  // server/test/manager.test.ts if there is no Manager fixture in this file).
  // Assert: recorded event has entryPoint === "idle".
});
```

If the manager-fixture pattern is too heavy for compaction.test.ts (it might be — that file uses lower-level fixtures), put this test in `server/test/manager.test.ts` instead, near the existing `sendMessage` + compaction tests.

#### Step 2: Run tests to verify they pass

```bash
cd /tmp/compaction-inner-loop-hook && env -u NODE_ENV npm --prefix server test -- --test-name-pattern "idle" 2>&1 | tail -20
```

Expected: PASS.

#### Step 3: Commit

```bash
cd /tmp/compaction-inner-loop-hook
git add server/test/compaction.test.ts server/test/manager.test.ts
git commit -m "test(compaction): assert entryPoint='idle' on idle-path events

Regression guard against future refactors that might move logic out of
runPendingCompactionAtIdle when wiring the second caller (PR 2's
inner-loop hook).

Part of #70."
```

---

### Task 4: Run full gate for PR 1

#### Step 1: Run the gate

```bash
cd /tmp/compaction-inner-loop-hook && env -u NODE_ENV bash scripts/gate.sh 2>&1 | tail -30
```

Expected: `=== gate: PASSED ===`. If any step fails, debug and fix before proceeding — do NOT ship a red gate.

#### Step 2: Verify branch state

```bash
cd /tmp/compaction-inner-loop-hook && git log --oneline main..HEAD
```

Expected: three commits (Tasks 1, 2, 3) on top of `5b6b913 docs: add design doc...`.

---

### Task 5: Ship PR 1

This task is invoked via `/ship` after the gate is green. The ship skill:
- Pushes the branch
- Opens PR titled `feat(compaction): add entryPoint telemetry field (#70 PR 1/2)`
- PR body links the design doc (`docs/plans/2026-06-13-compaction-inner-loop-hook-design.md`) and issue #70
- Brian merges with `gh pr merge <N> --squash --delete-branch`
- Local main fast-forwards
- The worktree is NOT torn down — PR 2 reuses it on a new branch

After merge, **start a fresh branch for PR 2** inside the same worktree:

```bash
cd /tmp/compaction-inner-loop-hook
git fetch /home/bjk/projects/ytsejam main
git checkout -b compaction-inner-loop-hook-pr2 FETCH_HEAD
```

Then proceed to Task 6.

---

## PR 2 — Inner-loop hook

### Task 6: Spike — verify the `context` subscribe-return contract

**Files:** none (read-only investigation; write the answer into the next task's brief).

#### Step 1: Read pi-agent-core's hook-emit code

```bash
cd /tmp/compaction-inner-loop-hook
sed -n '180,230p' node_modules/@earendil-works/pi-agent-core/dist/harness/agent-harness.js
```

Specifically: find `emitHook` and trace what it does with subscribe-listener return values. Look for whether listener returns are merged, last-wins, or ignored.

#### Step 2: Read the harness type for `subscribe`

```bash
cd /tmp/compaction-inner-loop-hook
grep -nE 'subscribe|HookResult|emitHook' node_modules/@earendil-works/pi-agent-core/dist/harness/agent-harness.d.ts
```

Specifically: does `subscribe`'s listener type permit returning a `ContextResult` (`{messages: AgentMessage[]}`), and is the return type wired into `emitHook`'s return?

#### Step 3: Decide and write the result

Three possible outcomes (one MUST be picked before Task 7):

**Outcome A — subscribe handlers CAN return a hook result that pi-agent-core honors.** Then Task 7 wires the handler directly via `harness.subscribe(...)`. Lowest cost. Highest probability per spec §3.2.

**Outcome B — there is a separate `harness.onHook("context", ...)` or `harness.transformContext` registration API.** Then Task 7 uses that surface instead.

**Outcome C — there is no consumer-facing way to return a value from the `context` hook.** Then Task 7 pivots to patching pi-agent-core via `patches/@earendil-works+pi-agent-core+*.patch`:
- Add a `harness.setContextHook(handler)` or `AgentHarnessOptions.contextHook` option
- Wire it inside `createLoopConfig`'s `transformContext` to consult the new handler
- Document the patch motivation in the patch's header comment
- Open an upstream issue/PR linked from the patch (best-effort, not blocking)

#### Step 4: Record the decision

Write a one-paragraph note to the cog observation log:

```
cog_append projects/ytsejam/observations.md
- 2026-06-13 [ytsejam:compaction:#70]: spike on pi-agent-core context-hook contract resolved as outcome <A|B|C>. <one-line reasoning>. Task 7 proceeds via <mechanism>.
```

No commit — this is investigation, not code.

---

### Task 7: Wire the inner-loop `context` handler in `manager.ts`

**Files:**
- Modify: `server/src/manager.ts` (the `onHarnessEvent` switch ~line 265, plus any helper construction needed for the surrender-context message)
- Possibly modify: `patches/@earendil-works+pi-agent-core+*.patch` (only if Task 6's outcome was C)

#### Step 1: Write the failing test

Append to `server/test/compaction.test.ts` or create a new file `server/test/compaction.innerloop.test.ts` (decide based on file size — if `compaction.test.ts` is over 1500 lines after Tasks 1-3, split):

```ts
test("inner-loop context handler invokes runPendingCompactionAtIdle and returns unchanged context in happy path", async () => {
  // Construct a Manager with a session whose pendingCompaction is set.
  // Stub runCompactionIfPending to return {fired: true, surrendered: false, ...}.
  // Emit a synthetic context event into the manager's onHarnessEvent.
  // Assert:
  //   1. runPendingCompactionAtIdle was called with entryPoint="inner_loop"
  //   2. The returned hook value is undefined (or equivalent "leave context unchanged")
});

test("inner-loop context handler returns context with surrender message on surrender", async () => {
  // Same as above but stub runCompactionIfPending to return {surrendered: true}.
  // Assert:
  //   1. emitCompactionSurrender was called (session has the surrender message persisted)
  //   2. The returned hook value is {messages: [...event.messages, <surrender notice>]}
});

test("inner-loop context handler is a no-op when pendingCompaction is null", async () => {
  // Manager with session, no pendingCompaction set.
  // Emit synthetic context event.
  // Assert: runPendingCompactionAtIdle was either not called, or called but
  // returned its no-op fast path (it already does this).
  // The returned hook value is undefined.
});
```

Imports needed (verify and add as necessary):
```ts
import { Manager } from "../src/manager.ts";
// Plus existing fixtures from the test file's existing manager-test scaffolding.
```

If `Manager`-level fixtures don't exist in `compaction.test.ts`, reuse the ones from `server/test/manager.test.ts` (copy the import or extract a shared fixture into `server/test/fixtures/`).

#### Step 2: Run test to verify it fails

```bash
cd /tmp/compaction-inner-loop-hook && env -u NODE_ENV npm --prefix server test -- --test-name-pattern "inner-loop context handler" 2>&1 | tail -20
```

Expected: FAIL — no handler registered, so the context event is unhandled and the assertions fail.

#### Step 3: Add the handler in `manager.ts`

In `manager.ts`'s `onHarnessEvent` (~line 265), add a new branch BEFORE the `agent_end` reset (so the order is: `agent_start`, `agent_end`, `message_end`, FORWARDED_EVENTS, `turn_end`, `session_compact`, then the NEW `context` branch):

```ts
if (event.type === "context" && opened.compaction) {
  const ok = await this.runPendingCompactionAtIdle(opened, "inner_loop");
  if (!ok) {
    // Surrender: append the surrender notice to the context the LLM will
    // see this turn so it sees the final state and stops naturally. The
    // session already has the surrender message appended by
    // emitCompactionSurrender (called inside runPendingCompactionAtIdle).
    const surrenderText = buildSurrenderMessage(
      /* tokens */ 0,
      opened.harness.getModel().contextWindow,
    );
    return {
      messages: [
        ...event.messages,
        {
          role: "assistant",
          content: [{ type: "text", text: surrenderText }],
          stopReason: "stop",
          api: opened.harness.getModel().api,
          provider: opened.harness.getModel().provider,
          model: opened.harness.getModel().id,
          timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    };
  }
  // Happy path: return undefined so transformContext keeps the original.
  return undefined;
}
```

Notes:
- `buildSurrenderMessage` already exists in `compaction.ts` (used by `emitCompactionSurrender`); import it.
- The exact return-shape for subscribe handlers depends on Task 6's outcome. If outcome was C (patched pi-agent-core), the patched handler API may take a different shape — adapt accordingly. The semantic intent is identical: happy path → unchanged context; surrender → context with surrender notice appended.
- The `opened.compaction` guard mirrors all existing compaction sites and is the kill-switch path (compaction disabled → `opened.compaction` is undefined → handler short-circuits).

If `onHarnessEvent`'s current signature is `Promise<void>`, change to `Promise<ContextResult | undefined | void>` (or whatever the equivalent type is) and verify the subscribe-listener signature accepts the return.

#### Step 4: Run tests to verify they pass

```bash
cd /tmp/compaction-inner-loop-hook && env -u NODE_ENV npm --prefix server test -- --test-name-pattern "inner-loop context handler" 2>&1 | tail -20
```

Expected: PASS.

Also run the full server suite:
```bash
cd /tmp/compaction-inner-loop-hook && env -u NODE_ENV npm --prefix server test 2>&1 | tail -10
```

Expected: full PASS.

#### Step 5: Commit

```bash
cd /tmp/compaction-inner-loop-hook
git add server/src/manager.ts server/test/compaction.test.ts # plus patches/ if Task 6 outcome was C
git commit -m "feat(compaction): inner-loop context-hook handler in Manager

Subscribes to pi-agent-core's 'context' event (which fires before each
turn's LLM call) and fires runPendingCompactionAtIdle with
entryPoint='inner_loop' if pendingCompaction is set. On surrender,
appends the surrender notice to the context so the LLM sees final state
and the run terminates naturally.

Mirrors the existing idle-path entry from sendMessage/injectMessage but
runs between turns of an autonomous run, closing the gap where mid-loop
accumulation previously hit the API 400 and tripped the reactive
backstop.

Part of #70."
```

---

### Task 8: Mirror the handler in `task-manager.ts`

**Files:**
- Modify: `server/src/task-manager.ts` (its `onHarnessEvent` analog ~line 240)

#### Step 1: Write the failing test

Mirror the three tests from Task 7 but for `TaskManager`. If a `TaskManager` fixture doesn't exist, see `server/test/task-manager.test.ts` for the pattern. Test names:

```ts
test("TaskManager inner-loop context handler invokes runPendingCompactionAtIdle with entryPoint='inner_loop'", ...);
test("TaskManager inner-loop context handler returns context with surrender message on surrender", ...);
test("TaskManager inner-loop context handler is a no-op when pendingCompaction is null", ...);
```

Put them in `server/test/task-manager.test.ts` next to the existing TaskManager tests.

#### Step 2: Run test to verify it fails

```bash
cd /tmp/compaction-inner-loop-hook && env -u NODE_ENV npm --prefix server test -- --test-name-pattern "TaskManager inner-loop" 2>&1 | tail -20
```

Expected: FAIL.

#### Step 3: Add the handler in `task-manager.ts`

Apply the EXACT same code block as Task 7 step 3, in `task-manager.ts`'s onHarnessEvent equivalent. Variable name will be `active` instead of `opened` (per existing task-manager convention).

```ts
if (event.type === "context" && active.compaction) {
  const ok = await this.runPendingCompactionAtIdle(active, "inner_loop");
  if (!ok) {
    const surrenderText = buildSurrenderMessage(
      0,
      active.harness.getModel().contextWindow,
    );
    return {
      messages: [
        ...event.messages,
        {
          role: "assistant",
          content: [{ type: "text", text: surrenderText }],
          stopReason: "stop",
          api: active.harness.getModel().api,
          provider: active.harness.getModel().provider,
          model: active.harness.getModel().id,
          timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    };
  }
  return undefined;
}
```

#### Step 4: Run tests to verify they pass

```bash
cd /tmp/compaction-inner-loop-hook && env -u NODE_ENV npm --prefix server test -- --test-name-pattern "TaskManager inner-loop" 2>&1 | tail -20
```

Expected: PASS.

Full server suite:
```bash
cd /tmp/compaction-inner-loop-hook && env -u NODE_ENV npm --prefix server test 2>&1 | tail -10
```

Expected: full PASS.

#### Step 5: Commit

```bash
cd /tmp/compaction-inner-loop-hook
git add server/src/task-manager.ts server/test/task-manager.test.ts
git commit -m "feat(compaction): inner-loop context-hook handler in TaskManager

Mirrors the Manager-side handler from the previous commit. Subagent
tasks (delegated work, long reviewer runs, parallel subagent dispatch)
get the same inner-loop proactive compaction trigger.

Part of #70."
```

---

### Task 9: Integration test — inner-loop compaction fires between turns + #73 regression

**Files:**
- Modify: `server/test/compaction.integration.test.ts` (add tests at the end)

#### Step 1: Write the failing test

```ts
test("inner-loop proactive compaction fires between turns of an autonomous run", async () => {
  // Build a real AgentHarness with a fake LLM streamFn that emits N synthetic
  // turns crossing the threshold mid-run. Use the existing scaffolding pattern
  // in compaction.integration.test.ts (it already has fake-LLM helpers).
  //
  // Drive a Manager session through enough turns to set pendingCompaction
  // mid-loop. Spy on Manager.recordCompactionEvent (or assert on the
  // compactions.jsonl side-file) to verify:
  //
  // 1. At least one CompactionEvent was written before the agent_end event
  //    (timing: between turns, not after idle).
  // 2. The event has trigger:"proactive" + entryPoint:"inner_loop".
});

test("inner-loop surrender terminates the autonomous run cleanly", async () => {
  // Same setup but force surrender (e.g. mock the compaction to return
  // surrendered:true after one attempt, or use a context-window so small
  // that even keep-recent overflows it).
  //
  // Assert:
  // 1. The agent_end event fires.
  // 2. The final assistant message in the session JSONL is the surrender
  //    notice (role:"assistant" with the surrender text).
  // 3. No new message-role values appeared in the session JSONL (#73
  //    frontend-safety regression): all roles are in the known set
  //    {"user", "assistant", "toolResult"}.
});
```

The exact fixture builders to reuse are in the top of `compaction.integration.test.ts`. Do NOT invent parallel fixtures — copy or reuse what's there.

#### Step 2: Run test to verify it fails

```bash
cd /tmp/compaction-inner-loop-hook && env -u NODE_ENV npm --prefix server test -- --test-name-pattern "inner-loop proactive|inner-loop surrender" 2>&1 | tail -20
```

Expected: FAIL (test does not yet exist OR fails the assertions because the integration timing differs from the unit test's mocked timing).

#### Step 3: Iterate until passing

The integration test will likely require small adjustments to the fake-LLM stream's threshold-crossing logic. Iterate: read the existing integration tests' fake-LLM setup, adapt, run, fix, run. Do NOT change `manager.ts` / `task-manager.ts` source from Tasks 7-8 — if those need changes to pass integration, that's a bug from the unit tests and should be flagged for review, not patched silently.

#### Step 4: Run full gate

```bash
cd /tmp/compaction-inner-loop-hook && env -u NODE_ENV bash scripts/gate.sh 2>&1 | tail -30
```

Expected: `=== gate: PASSED ===`. Web build must pass — this is the #73 protection.

#### Step 5: Commit

```bash
cd /tmp/compaction-inner-loop-hook
git add server/test/compaction.integration.test.ts
git commit -m "test(compaction): integration tests for inner-loop proactive trigger

Two new tests in compaction.integration.test.ts:

1. inner-loop proactive compaction fires between turns of an autonomous
   run — drives a real AgentHarness through N synthetic turns crossing
   the threshold, asserts a CompactionEvent with trigger:'proactive' +
   entryPoint:'inner_loop' is recorded BEFORE agent_end.

2. inner-loop surrender terminates the autonomous run cleanly — forces
   surrender, asserts agent_end fires with the surrender notice as the
   final assistant message AND no new message-role values appear in the
   session JSONL (#73 frontend-safety regression guard).

Part of #70."
```

---

### Task 10: Run full gate for PR 2 and ship

#### Step 1: Run the gate

```bash
cd /tmp/compaction-inner-loop-hook && env -u NODE_ENV bash scripts/gate.sh 2>&1 | tail -30
```

Expected: `=== gate: PASSED ===`.

#### Step 2: Verify branch state

```bash
cd /tmp/compaction-inner-loop-hook && git log --oneline main..HEAD
```

Expected: 4 commits (Tasks 7, 8, 9 + any spike-driven patches/ commit from Task 6 outcome C) on top of the PR-1-merged main.

#### Step 3: Ship via `/ship` skill

Invoke `/ship`. PR title: `feat(compaction): inner-loop context-hook handler (#70 PR 2/2)`. PR body links the design doc and references PR 1.

Post-merge:
- Brian deploys + restarts ytsejam
- Brian watches a long autonomous run (e.g. `/find-weeds`, `/housekeeping`) and checks `<session>.compactions.jsonl` for `entry_point: "inner_loop"` records as proof the new trigger is firing in prod
- If `entry_point: "inner_loop"` appears with `succeeded: true`, the fix is verified end-to-end

---

## Implementation discipline (mandatory)

- **Absolute paths in subagent briefs.** Every implementer subagent gets `/tmp/compaction-inner-loop-hook` and absolute test/source paths. Relative paths resolve against the harness data dir, not the worktree (per cog patterns).
- **`env -u NODE_ENV` on every npm/node command.** The harness shell has `NODE_ENV=production` which skips devDeps; gate and tests need devDeps. Pre-build the env at task brief generation time.
- **One PR per step.** Per Brian's standing workflow: push + PR + merge BEFORE starting the next PR. PR 1 must merge before PR 2 starts. No stacking.
- **Gate green before every PR.** No exceptions. The gate IS the bar — there is no separate CI.
- **Spike-driven scope adjustment.** If Task 6 outcome is C (patch pi-agent-core), the patch-package commit is part of PR 2 (not its own PR) — the patch is a means to wire the handler, not an independent change.
- **Subagent commit discipline.** Per cog patterns: commit-before-report on every implementer task. Isolated worktree teardown will kill uncommitted work. The mandate is in every brief.

## Lessons to capture (if any fix cycles occur)

Per /lessons skill — if any task hits a fix cycle (implementer's first attempt fails review), synthesize the lesson into `docs/agents/<theme>.md` and commit. Likely themes for this work:
- pi-agent-core hook surface (if Task 6's outcome required investigation)
- Test fixture sharing between unit and integration compaction tests
- Surrender-message context-mutation semantics
