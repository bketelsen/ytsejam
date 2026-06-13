# Compaction inner-loop hook (v2) Implementation Plan

> Execute with the `develop` skill, task-by-task.

**Goal:** Wire a `context`-hook in `manager.ts` and `task-manager.ts` that compacts the session
mid-loop (between turns of an autonomous run) by calling pi-agent-core's exported pure
`prepareCompaction` / `compact` functions, bypassing the `harness.compact()` wrapper's
`phase==="idle"` guard that made the v1 implementation inert.

**Spec:** `docs/plans/2026-06-13-compaction-inner-loop-hook-v2-design.md`

**Architecture:** Two compaction paths coexist, distinguished by phase: the existing idle/reactive
path keeps using `harness.compact()` (phase guard is satisfied there); a new inner-loop path uses
the pure functions directly. Both paths share the pill bookkeeping, `recordCompactionEvent`
telemetry, and surrender semantics. The hook returns `{messages: newMessages}` on success
(replaces context for THIS LLM call) and an appended surrender notice on surrender.

**Tech Stack:** TypeScript, Node, Vitest, pi-agent-core 0.79.1 (`@earendil-works/pi-agent-core`).

**Worktree:** `/tmp/compaction-inner-loop-hook-pr2`

**Branch:** `compaction-inner-loop-hook-pr2` (PR 2 of issue #70; PR 1 merged as #88 / `13a6954`)

**Base SHA:** `13a6954` (main as of 2026-06-13)

---

## Lessons from v1 (do not re-stumble)

1. **`harness.compact()` requires `phase==="idle"`** (agent-harness.js:628-629). The `context`
   hook fires at `phase==="turn"`. Never call `harness.compact()` from inside the hook — use the
   pure exports instead.
2. **v1 was green because every test mocked `runPendingCompactionAtIdle`** (the failing call).
   Layer 3 (real-run e2e) is a hard gate against this regression.
3. **Hook errors abort the autonomous run** via `normalizeHookError`. The handler MUST wrap its
   body in `try/catch` and degrade to `return undefined` (preserve original context, fall back
   to the reactive backstop) on any failure.
4. **Pi-agent-core exports `compact`, `prepareCompaction`, `DEFAULT_COMPACTION_SETTINGS`** from
   its public entry (`index.d.ts:5`). `Session.appendCompaction` is also public. These are the
   building blocks we orchestrate — same as what `AgentHarness.compact()` does internally,
   minus the phase guard.

---

## Task 1: Extract `buildSurrenderAgentMessage` helper (refactor, no behavior change)

Addresses the v1 quality-review IMPORTANT-severity duplication finding. The surrender
`AgentMessage` shape lives in two places today (`emitCompactionSurrender` in manager.ts:524-540
plus the original inline construction; v2's hook will need a third). Extracting first means
later tasks just reuse it.

**Files:**
- Modify: `server/src/compaction.ts` (add export `buildSurrenderAgentMessage` near `buildSurrenderMessage`)
- Modify: `server/src/manager.ts:524-540` (replace inline `message` construction in `emitCompactionSurrender` with the helper)
- Modify: `server/test/compaction.test.ts` (add unit test for the helper)

### Step 1: Write the failing test

Add at the end of `server/test/compaction.test.ts`, before the closing of the last `describe` block:

```ts
describe("buildSurrenderAgentMessage", () => {
  it("returns an AgentMessage matching the canonical surrender shape", () => {
    const opened = {
      harness: {
        getModel: () => ({
          id: "fake-model",
          contextWindow: 1_000_000,
          api: "fake-api",
          provider: "fake-provider",
        }),
      },
    } as unknown as Parameters<typeof buildSurrenderAgentMessage>[0];

    const msg = buildSurrenderAgentMessage(opened, 0);

    expect(msg.role).toBe("assistant");
    expect(msg.content).toEqual([
      { type: "text", text: buildSurrenderMessage(0, 1_000_000) },
    ]);
    expect(msg.stopReason).toBe("stop");
    expect(msg.api).toBe("fake-api");
    expect(msg.provider).toBe("fake-provider");
    expect(msg.model).toBe("fake-model");
    expect(typeof msg.timestamp).toBe("number");
    expect(msg.usage).toEqual({
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
  });
});
```

Add to the test file's import list (if not present): `import { buildSurrenderAgentMessage, buildSurrenderMessage } from "../src/compaction.js";`

### Step 2: Run test to verify it fails

```bash
cd /tmp/compaction-inner-loop-hook-pr2/server
env -u NODE_ENV npx vitest run test/compaction.test.ts -t "buildSurrenderAgentMessage"
```

Expected: FAIL with `buildSurrenderAgentMessage is not exported` (or compile error).

### Step 3: Add the helper to `server/src/compaction.ts`

Locate `buildSurrenderMessage` (~ line 250). Immediately after its export, add:

```ts
/**
 * Build the canonical surrender AgentMessage used by both `emitCompactionSurrender`
 * (in-session canonical persistence) and the inner-loop context hook
 * (in-context notice appended to a turn).
 *
 * `tokens` is the estimated context tokens at the surrender point; pass `0` from
 * sites that don't have an accurate count (e.g. the inner-loop hook, where we
 * surrender without computing).
 */
export function buildSurrenderAgentMessage(
  opened: Pick<OpenedForCompaction, "harness">,
  tokens: number,
): AgentMessage {
  const model = opened.harness.getModel();
  const text = buildSurrenderMessage(tokens, model.contextWindow);
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
```

Make sure `AgentMessage` is imported (it already is per existing usage in this file). If
`OpenedForCompaction` is not exported, export it (or use a narrower type).

### Step 4: Replace inline construction in `server/src/manager.ts`

Locate `emitCompactionSurrender` (~ line 469-545 in the current source, the function that ends
with the `appendAgentMessage` call). Inside it, find the inline `message` construction
(approximately lines 524-540 — the `const message: AgentMessage = { role: "assistant", ... }` block).
Replace those lines with:

```ts
const message = buildSurrenderAgentMessage(opened, estimatedTokens);
```

Verify `buildSurrenderAgentMessage` is imported at the top of `manager.ts`:

```ts
import {
  // ... existing imports ...
  buildSurrenderAgentMessage,
} from "./compaction.js";
```

The `estimatedTokens` variable name must match what's in scope in the existing function. If the
existing variable is called something different (e.g. `tokens` or `estimated`), use that name —
don't rename. If the existing function computes tokens via `estimateContextTokens(...)` or
similar, keep that computation; only the message-construction is replaced.

### Step 5: Run tests to verify pass + no regression

```bash
cd /tmp/compaction-inner-loop-hook-pr2/server
env -u NODE_ENV npx vitest run test/compaction.test.ts
env -u NODE_ENV npm run check
```

Expected: all tests pass; typecheck clean.

### Step 6: Commit

```bash
cd /tmp/compaction-inner-loop-hook-pr2
git add server/src/compaction.ts server/src/manager.ts server/test/compaction.test.ts
git commit -m "refactor(compaction): extract buildSurrenderAgentMessage helper

Single source for the surrender AgentMessage shape. emitCompactionSurrender
keeps its existing token estimation; the new helper accepts tokens as a
parameter so the upcoming inner-loop hook can pass 0 (no estimate available
inside the hook).

No behavior change for the idle/reactive path."
```

---

## Task 2: Add `runInlineCompactionInLoop` to `server/src/compaction.ts` (Layer 1 unit tests)

The new orchestrator. Mirrors `runCompactionIfPending` but uses pi-agent-core's pure functions
instead of `harness.compact()`. Returns `{fired, succeeded, surrendered?, newMessages?, ...}`.

**Files:**
- Modify: `server/src/compaction.ts` (add `runInlineCompactionInLoop`, `buildPostCompactionMessages`)
- Modify: `server/test/compaction.test.ts` (add Layer 1 unit tests)

### Step 1: Write the failing tests

Add a new `describe` block at the end of `server/test/compaction.test.ts`:

```ts
describe("runInlineCompactionInLoop", () => {
  // Helper: build an `opened` fixture wired to a real session repo + mocked harness.
  // Mirror existing fixture helpers in this file (search for similar `makeOpened` /
  // `createTestOpened` patterns and reuse).
  // Mock the pi-agent-core pure functions at the import boundary using vi.mock
  // for "@earendil-works/pi-agent-core".

  it("happy path: writes appendCompaction(..., fromHook:true) and returns newMessages", async () => {
    // - Build opened with opened.compaction.pendingCompaction set
    // - Mock prepareCompaction -> { ok: true, value: <preparation with firstKeptEntryId='entry-X'> }
    // - Mock compact -> { ok: true, value: { summary: "SUM", firstKeptEntryId: "entry-X",
    //                       tokensBefore: 100, details: {} } }
    // - Spy on session.appendCompaction
    // - Call runInlineCompactionInLoop(opened, branchEntries, repo)
    // - Assert: result.fired === true, result.succeeded === true,
    //           appendCompaction called with (summary, firstKept, tokensBefore, details, true /* fromHook */),
    //           result.newMessages[0].content[0].text === "SUM"
  });

  it("no-op when prepareCompaction returns undefined", async () => {
    // - Mock prepareCompaction -> { ok: true, value: undefined }
    // - Assert: result.fired === false, appendCompaction NOT called, pendingCompaction restored?
    //          (verify against actual semantics — pending is cleared even on no-op? mirror existing behavior)
  });

  it("error when prepareCompaction returns Result.err", async () => {
    // - Mock prepareCompaction -> { ok: false, error: new CompactionError("prep failed") }
    // - Assert: result.fired === true, result.succeeded === false, result.error defined
  });

  it("error when compact() returns Result.err", async () => {
    // - Mock prepareCompaction -> ok with preparation
    // - Mock compact -> { ok: false, error: new CompactionError("compact failed") }
    // - Assert: result.fired === true, result.succeeded === false, appendCompaction NOT called
  });

  it("surrender when appendCompaction throws (backup restored)", async () => {
    // - Mock prepareCompaction + compact -> ok
    // - Spy session.appendCompaction to throw
    // - Spy/check that session JSONL was restored from backup (file content matches pre-write)
    // - Assert: result.surrendered === true
  });

  it("surrender when verifySessionLoadable fails post-write (backup restored)", async () => {
    // - Mock prepareCompaction + compact -> ok; appendCompaction succeeds
    // - Mock repo.open to throw on the verify call
    // - Assert: session JSONL restored from backup, result.surrendered === true
  });
});
```

Note: the test BODIES above are pseudocode placeholders. The implementer will fill them with
real test code matching the existing patterns in `server/test/compaction.test.ts` (vi.mock at the
import boundary, real tmpdir session fixtures, etc.).

### Step 2: Run tests to verify they fail

```bash
cd /tmp/compaction-inner-loop-hook-pr2/server
env -u NODE_ENV npx vitest run test/compaction.test.ts -t "runInlineCompactionInLoop"
```

Expected: FAIL with `runInlineCompactionInLoop is not exported` (or similar).

### Step 3: Implement `runInlineCompactionInLoop` in `server/src/compaction.ts`

Add to imports at the top:

```ts
import {
  compact,
  prepareCompaction,
  DEFAULT_COMPACTION_SETTINGS,
} from "@earendil-works/pi-agent-core";
import type {
  AgentMessage,
  CompactionPreparation,
  Model,
  SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
```

(Verify against the actual public surface of the package; some types may live under different
paths. The implementer should grep `node_modules/@earendil-works/pi-agent-core/dist/index.d.ts`
to confirm the import names.)

Define and export:

```ts
/** Result type for the inner-loop orchestrator. Mirrors `RunCompactionResult` shape but adds `newMessages`. */
export interface RunInlineCompactionResult {
  fired: boolean;
  succeeded?: boolean;
  surrendered?: boolean;
  newMessages?: AgentMessage[];
  compactionEntryId?: string;
  durationMs?: number;
  backupPath?: string;
  pending?: PendingCompaction;  // use whatever the existing PendingCompaction type is named
  error?: Error;
}

/**
 * Inner-loop compaction orchestrator. Mirrors `runCompactionIfPending` but bypasses
 * `harness.compact()`'s phase guard by calling pi-agent-core's pure compaction functions
 * directly. Safe to call from `phase==="turn"` (where the `context` hook fires).
 *
 * Returns `newMessages` on success — the caller (the context hook) returns this as
 * `{ messages: newMessages }` to replace the LLM call's context.
 */
export async function runInlineCompactionInLoop(
  opened: OpenedForCompaction,
  branchEntries: SessionTreeEntry[],
  repo: JsonlSessionRepo,
): Promise<RunInlineCompactionResult> {
  const pending = opened.compaction.pendingCompaction;
  if (!pending) return { fired: false };
  const pendingSnapshot = { ...pending };
  opened.compaction.pendingCompaction = null;

  const start = Date.now();
  const sessionFilePath = opened.session.metadata.path;
  let backupPath: string;
  try {
    backupPath = await snapshotSessionJsonl(sessionFilePath);
  } catch (err) {
    console.error(
      `[compaction] backup failed (inline) for session ${opened.session.metadata.id}, ABORTING:`,
      err,
    );
    return {
      fired: true,
      succeeded: false,
      pending: pendingSnapshot,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
  void pruneOldBackups(sessionFilePath, 3);

  // 1. prepareCompaction (pure)
  const prepResult = prepareCompaction(branchEntries, DEFAULT_COMPACTION_SETTINGS);
  if (!prepResult.ok) {
    return {
      fired: true,
      succeeded: false,
      durationMs: Date.now() - start,
      backupPath,
      pending: pendingSnapshot,
      error: prepResult.error,
    };
  }
  if (!prepResult.value) {
    // Nothing to compact — restore pending? Mirror runCompactionIfPending's semantics:
    // it returns { fired: false } and the eager-clear stands. We do the same.
    return { fired: false, durationMs: Date.now() - start, backupPath };
  }
  const preparation = prepResult.value;

  // 2. resolve model + auth (mirror what AgentHarness.compact does, agent-harness.js:633-637)
  const model = opened.harness.getModel();
  if (!model) {
    return {
      fired: true, succeeded: false, durationMs: Date.now() - start, backupPath,
      pending: pendingSnapshot, error: new Error("no model set for inline compaction"),
    };
  }
  // The harness exposes getApiKeyAndHeaders? as an optional bound method. If it's not
  // accessible via the public interface, the implementer must check what the existing
  // emitCompactionSurrender / runCompactionIfPending code uses for auth resolution
  // and reuse that pattern.
  const auth = opened.harness.getApiKeyAndHeaders
    ? await opened.harness.getApiKeyAndHeaders(model)
    : undefined;
  if (!auth) {
    return {
      fired: true, succeeded: false, durationMs: Date.now() - start, backupPath,
      pending: pendingSnapshot, error: new Error("no auth available for inline compaction"),
    };
  }

  // 3. compact (pure) — same call shape as agent-harness.js:660
  const thinkingLevel = opened.harness.getThinkingLevel?.();
  const compactResult = await compact(
    preparation,
    model,
    auth.apiKey,
    auth.headers,
    CUSTOM_INSTRUCTIONS,  // existing constant in this file
    undefined,             // signal — not plumbed in v1
    thinkingLevel,
  );
  if (!compactResult.ok) {
    return {
      fired: true, succeeded: false, durationMs: Date.now() - start, backupPath,
      pending: pendingSnapshot, error: compactResult.error,
    };
  }
  const result = compactResult.value;

  // 4. append compaction entry to session
  let entryId: string;
  try {
    entryId = await opened.session.appendCompaction(
      result.summary,
      result.firstKeptEntryId,
      result.tokensBefore,
      result.details,
      true,  // fromHook — matches what AgentHarness.compact() does when session_before_compact provides a result
    );
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    console.error(
      `[compaction] inline appendCompaction failed for session ${opened.session.metadata.id}, restoring from backup:`,
      e,
    );
    await restoreSessionFromBackup(sessionFilePath, backupPath);
    return {
      fired: true, succeeded: false, surrendered: true,
      durationMs: Date.now() - start, backupPath, pending: pendingSnapshot, error: e,
    };
  }

  // 5. verify session is still loadable
  const verify = await verifySessionLoadable(() => repo.open(opened.session.metadata));
  if (!verify.ok) {
    console.error(
      `[compaction] inline post-compact load verification FAILED for session ${opened.session.metadata.id}, restoring from backup:`,
      verify.error,
    );
    await restoreSessionFromBackup(sessionFilePath, backupPath);
    return {
      fired: true, succeeded: false, surrendered: true,
      durationMs: Date.now() - start, backupPath, pending: pendingSnapshot, error: verify.error,
    };
  }

  // 6. build the AgentMessage[] this turn should use
  const newMessages = buildPostCompactionMessages(
    result.summary, branchEntries, result.firstKeptEntryId, model
  );

  return {
    fired: true, succeeded: true,
    durationMs: Date.now() - start, backupPath,
    newMessages, compactionEntryId: entryId,
  };
}

/**
 * Build the AgentMessage[] that should replace context after an inner-loop compaction.
 * = [summary as assistant message, ...messages from firstKeptEntryId forward].
 *
 * The summary message shape MUST match what `Session.appendCompaction` writes internally
 * for the new compaction entry, so that subsequent `session.getBranch()` reads return
 * a list with the same shape as what we returned here. Inspect
 * `node_modules/@earendil-works/pi-agent-core/dist/harness/session/session.js`
 * for the internal conversion (search for "compaction" entry handling) and replicate.
 */
export function buildPostCompactionMessages(
  summary: string,
  branchEntries: SessionTreeEntry[],
  firstKeptEntryId: string,
  model: Model<unknown>,
): AgentMessage[] {
  // Find the slice from firstKeptEntryId forward; project each entry to AgentMessage.
  // Implementer: check existing helpers in this file (`compaction.ts`) and in
  // pi-agent-core's session module for "entry → AgentMessage" projection; reuse if present.
  // If not, write the projection inline matching the canonical shape.
  // ...
}
```

If the implementer finds that `OpenedForCompaction`, `PendingCompaction`,
`snapshotSessionJsonl`, `pruneOldBackups`, `restoreSessionFromBackup`,
`verifySessionLoadable`, or `CUSTOM_INSTRUCTIONS` are not already exported / in scope, they
should be — they're used by the existing `runCompactionIfPending` in the same file. Export them
or move declarations as needed.

### Step 4: Run tests to verify pass

```bash
cd /tmp/compaction-inner-loop-hook-pr2/server
env -u NODE_ENV npx vitest run test/compaction.test.ts -t "runInlineCompactionInLoop"
env -u NODE_ENV npx vitest run test/compaction.test.ts
env -u NODE_ENV npm run check
```

Expected: all tests pass; typecheck clean.

### Step 5: Commit

```bash
cd /tmp/compaction-inner-loop-hook-pr2
git add server/src/compaction.ts server/test/compaction.test.ts
git commit -m "feat(compaction): add runInlineCompactionInLoop using pi-agent-core pure functions

New inner-loop compaction orchestrator that bypasses the harness.compact()
wrapper's phase==='idle' guard by calling pi-agent-core's exported pure
prepareCompaction and compact functions directly, then writing via
Session.appendCompaction(..., fromHook:true).

Returns newMessages on success — caller returns this as { messages: newMessages }
from the context hook to replace the LLM call's context.

Layer 1 (orchestrator unit tests) covered: happy path, prep-undefined no-op,
prep error, compact error, appendCompaction surrender, verifySessionLoadable
surrender. The existing harness.compact()-based runCompactionIfPending stays
unchanged for the idle/reactive sites (phase guard satisfied there)."
```

---

## Task 3: Add `runPendingInlineCompactionInLoop` wrapper (telemetry + pill + surrender)

Symmetric to `runPendingCompactionAtIdle` in the existing wiring. Wraps `runInlineCompactionInLoop`
with `markCompactionStart("proactive")`, `markCompactionEnd(status)`, `recordCompactionEvent({entryPoint, ...})`,
and `emitCompactionSurrender(opened)` on surrender.

**Files:**
- Modify: `server/src/manager.ts` (add `runPendingInlineCompactionInLoop` as a method on `AgentManager`, mirroring `runPendingCompactionAtIdle` at ~line 459-494)
- Modify: `server/test/compaction.test.ts` (add wrapper-level test)

### Step 1: Write the failing test

Add to `server/test/compaction.test.ts`:

```ts
describe("AgentManager.runPendingInlineCompactionInLoop", () => {
  it("happy path: emits markCompactionStart/End + recordCompactionEvent with entryPoint='inner_loop' and returns newMessages", async () => {
    // - Build a manager + opened fixture
    // - Spy on markCompactionStart, markCompactionEnd, recordCompactionEvent
    // - Mock runInlineCompactionInLoop (this test is at the wrapper level) -> { fired: true, succeeded: true, newMessages: [...] }
    // - Call manager.runPendingInlineCompactionInLoop(opened, branchEntries, "inner_loop")
    // - Assert: markCompactionStart called with "proactive"
    //           markCompactionEnd called with "succeeded"
    //           recordCompactionEvent called with entryPoint:"inner_loop", succeeded:true
    //           result.ok === true, result.newMessages defined, result.surrendered === false
  });

  it("surrender path: emits markCompactionEnd('surrendered') + recordCompactionEvent(surrendered:true) + emitCompactionSurrender", async () => {
    // - Mock runInlineCompactionInLoop -> { fired: true, succeeded: false, surrendered: true }
    // - Spy emitCompactionSurrender
    // - Assert: markCompactionEnd("surrendered"), recordCompactionEvent({surrendered:true}),
    //           emitCompactionSurrender called once, result.surrendered === true
  });

  it("no-op when runInlineCompactionInLoop returns {fired:false}", async () => {
    // - Mock runInlineCompactionInLoop -> { fired: false }
    // - Assert: NO markCompactionStart/End, NO recordCompactionEvent (or at least no entryPoint mismatch),
    //           result.ok === true, result.newMessages === undefined
  });
});
```

### Step 2: Run tests to verify they fail

Expected: FAIL with `runPendingInlineCompactionInLoop is not a method on AgentManager`.

### Step 3: Add the wrapper method to `AgentManager` in `server/src/manager.ts`

Locate `runPendingCompactionAtIdle` (~ line 459). Add immediately after it:

```ts
/**
 * Inner-loop pending-compaction wrapper. Symmetric to `runPendingCompactionAtIdle`
 * but uses `runInlineCompactionInLoop` (pure functions, no phase guard) instead of
 * `runCompactionIfPending` (harness.compact() wrapper).
 *
 * Called from the `context` hook handler — the only safe site to invoke inline
 * compaction from `phase==="turn"`.
 *
 * Returns `{ ok, newMessages?, surrendered }`:
 * - `ok:true, newMessages:[...]` → happy path; caller returns `{messages: newMessages}` from hook
 * - `ok:false, surrendered:true` → caller appends surrender notice to event.messages
 * - `ok:true, newMessages:undefined` → no-op (nothing pending); caller returns `undefined`
 */
async runPendingInlineCompactionInLoop(
  opened: OpenedForCompaction,
  branchEntries: SessionTreeEntry[],
  entryPoint: CompactionEntryPoint,
): Promise<{ ok: boolean; newMessages?: AgentMessage[]; surrendered: boolean }> {
  this.markCompactionStart("proactive");
  const result = await runInlineCompactionInLoop(opened, branchEntries, this.repo);
  if (!result.fired) {
    // Nothing happened — undo the pill start
    this.markCompactionEnd("succeeded");  // or whatever the no-op convention is in the existing idle wrapper
    return { ok: true, surrendered: false };
  }
  const endStatus = result.surrendered
    ? "surrendered"
    : result.succeeded
      ? "succeeded"
      : "failed";
  this.markCompactionEnd(endStatus);
  recordCompactionEvent(opened, {
    entryPoint,
    fired: true,
    succeeded: result.succeeded ?? false,
    surrendered: result.surrendered ?? false,
    durationMs: result.durationMs,
    error: result.error,
    pending: result.pending,
    backupPath: result.backupPath,
    compactionEntryId: result.compactionEntryId,
  });
  if (result.surrendered) {
    emitCompactionSurrender(opened);
    return { ok: false, surrendered: true };
  }
  return { ok: !!result.succeeded, newMessages: result.newMessages, surrendered: false };
}
```

**Implementer note:** the exact field set passed to `recordCompactionEvent` and the
`markCompactionEnd` argument shape must match what `runPendingCompactionAtIdle` does in this
file. The pseudocode above shows the structure; the implementer must align the field names and
status string values with the existing idle wrapper's call exactly.

### Step 4: Run tests to verify pass

```bash
cd /tmp/compaction-inner-loop-hook-pr2/server
env -u NODE_ENV npx vitest run test/compaction.test.ts -t "runPendingInlineCompactionInLoop"
env -u NODE_ENV npx vitest run test/compaction.test.ts
env -u NODE_ENV npm run check
```

Expected: all pass.

### Step 5: Commit

```bash
cd /tmp/compaction-inner-loop-hook-pr2
git add server/src/manager.ts server/test/compaction.test.ts
git commit -m "feat(compaction): add runPendingInlineCompactionInLoop wrapper

Symmetric to runPendingCompactionAtIdle but for the inner-loop path. Wraps
runInlineCompactionInLoop with markCompactionStart/End pill bookkeeping,
recordCompactionEvent telemetry (entryPoint preserved from caller), and
emitCompactionSurrender on surrender.

Caller (the context hook in Task 4) returns:
- { messages: newMessages } on { ok:true, newMessages }
- { messages: [...event.messages, surrenderMsg] } on { surrendered:true }
- undefined on { ok:true, newMessages:undefined } (no-op)"
```

---

## Task 4: Wire the `context` hook in `server/src/manager.ts` (Layer 2 handler tests)

The new hook handler. Replaces the v1 inert handler (which has been reset out of the branch).

**Files:**
- Modify: `server/src/manager.ts` (add `harness.on("context", ...)` registration in `wire()`)
- Modify: `server/test/compaction.test.ts` (add Layer 2 handler tests)

### Step 1: Write the failing tests

Add to `server/test/compaction.test.ts`:

```ts
describe("inner-loop context handler", () => {
  it("returns undefined when compaction undefined (kill-switch boot)", async () => {
    // Boot with YTSEJAM_COMPACTION_ENABLED=false; opened.compaction undefined
    // - Invoke harness.emitHook({type:"context", messages: [...]})
    // - Assert: result === undefined, no spy methods called
  });

  it("returns undefined when pendingCompaction null (cheap no-op, getBranch NOT called)", async () => {
    // - Compaction enabled, opened.compaction.pendingCompaction = null
    // - Spy session.getBranch
    // - Invoke emitHook
    // - Assert: result === undefined, session.getBranch NOT called
  });

  it("returns {messages: newMessages} on happy compaction", async () => {
    // - opened.compaction.pendingCompaction = {...}
    // - Spy runPendingInlineCompactionInLoop on the manager -> { ok:true, newMessages:[...mocked...], surrendered:false }
    // - Invoke emitHook
    // - Assert: result.messages === the mocked newMessages array
  });

  it("returns surrender notice when orchestrator surrenders", async () => {
    // - Spy runPendingInlineCompactionInLoop -> { ok:false, surrendered:true }
    // - Invoke emitHook with event.messages = [msg1, msg2]
    // - Assert: result.messages.length === 3
    //           result.messages[0..1] === [msg1, msg2]
    //           result.messages[2] matches buildSurrenderAgentMessage(opened, 0)
  });

  it("returns undefined on any thrown error (defensive catch logs to console.error)", async () => {
    // - Spy console.error
    // - Mock runPendingInlineCompactionInLoop to throw
    // - Invoke emitHook
    // - Assert: result === undefined, console.error called once with [compaction] inner-loop hook failed prefix
  });
});
```

### Step 2: Run tests to verify they fail

Expected: FAIL — the handler isn't registered yet.

### Step 3: Register the handler in `wire()` of `server/src/manager.ts`

Locate `wire()` (~line 198). After the existing `harness.subscribe(...)` call (ends ~line 251)
and BEFORE the `if (compactionEnabled())` block (~line 300), insert:

```ts
// Inner-loop proactive compaction: fires once per turn before the LLM call.
// Uses pi-agent-core's pure compaction functions (via runInlineCompactionInLoop)
// to bypass harness.compact()'s phase==="idle" guard. Issue #70 PR 2.
//
// Blanket try/catch is mandatory: hook errors propagate via normalizeHookError
// and abort the autonomous run. Any failure must degrade to "preserve original
// context, fall back to reactive backstop at agent_end."
harness.on("context", async (event) => {
  try {
    if (!opened.compaction) return undefined;                            // kill-switch
    if (!opened.compaction.pendingCompaction) return undefined;          // cheap no-op
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

Add `buildSurrenderAgentMessage` to the imports from `./compaction.js` (already added in Task 1).

### Step 4: Run tests to verify pass

```bash
cd /tmp/compaction-inner-loop-hook-pr2/server
env -u NODE_ENV npx vitest run test/compaction.test.ts -t "inner-loop context handler"
env -u NODE_ENV npx vitest run test/compaction.test.ts
env -u NODE_ENV npm run check
```

Expected: all pass.

### Step 5: Commit

```bash
cd /tmp/compaction-inner-loop-hook-pr2
git add server/src/manager.ts server/test/compaction.test.ts
git commit -m "feat(compaction): wire inner-loop context-hook handler in Manager

Closes the gap in issue #70 where compaction needed between turns of an
autonomous run was deferred until either the next user prompt (idle path)
or until the provider returned a 400 and the reactive backstop fired
(agent_end recovery).

Handler:
- Short-circuits when compaction disabled or nothing pending (cheap no-op)
- Reads session.getBranch() and calls runPendingInlineCompactionInLoop
- On happy: returns { messages: newMessages } to replace LLM context
- On surrender: returns event.messages + appended surrender notice
- On any error: console.error + return undefined (preserve context, fall back to reactive)

The blanket try/catch is required because hook errors propagate via
normalizeHookError and abort the autonomous run."
```

---

## Task 5: Layer 3 real-run e2e test (regression gate against v1 inertia bug)

The test that v1 was missing. Drives an actual multi-turn run through pi-agent-core with a faux
provider; asserts compaction fires mid-loop and the next LLM call receives the compacted context.

**Files:**
- Create: `server/test/compaction-inner-loop-e2e.test.ts`

### Step 1: Write the failing test

```ts
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { AgentManager } from "../src/manager.js";
import { JsonlSessionRepo } from "../src/...";  // adjust import path to match existing helpers
// ... imports for fixture creation, mock provider, etc. — match patterns from
// existing e2e/integration tests in server/test/

// Mock the pure compact() function at the import boundary
vi.mock("@earendil-works/pi-agent-core", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-agent-core")>(
    "@earendil-works/pi-agent-core"
  );
  return {
    ...actual,
    compact: vi.fn(),  // will be reconfigured per test
  };
});

describe("inner-loop compaction (e2e real-run)", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "compaction-e2e-"));
    process.env.YTSEJAM_COMPACTION_ENABLED = "true";
    process.env.YTSEJAM_DATA_DIR = tmpDir;
  });
  afterEach(async () => {
    delete process.env.YTSEJAM_COMPACTION_ENABLED;
    delete process.env.YTSEJAM_DATA_DIR;
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("compaction fires mid-loop and next LLM call sees compacted context", async () => {
    // 1. Set up real AgentManager + real JsonlSessionRepo in tmpDir
    // 2. Configure faux provider: returns "respond with 2 tool calls then a stop"
    //    - turn 1: assistant message with 2 tool calls
    //    - turn 2: assistant message with stop reason
    //    - tool handlers: trivial (return empty results)
    // 3. After the manager wires the harness, arm pendingCompaction:
    //    Subscribe to turn_end of turn 1, set opened.compaction.pendingCompaction = {...}
    // 4. Configure the mocked compact() to return { ok: true, value: {
    //      summary: "MOCK SUMMARY",
    //      firstKeptEntryId: <id of an early entry>,
    //      tokensBefore: 500, details: {}
    //    } }
    // 5. Spy on the faux provider's stream function to capture llmContext.messages per call
    // 6. Spy on recordCompactionEvent to capture telemetry calls
    // 7. Drive a full prompt() through the harness
    // 8. After completion, assert:
    //    - streamFn called >= 2 times (turn 1 + turn 2)
    //    - call 2's llmContext.messages STARTS WITH a message containing "MOCK SUMMARY"
    //    - call 2's llmContext.messages.length < call 1's llmContext.messages.length
    //    - session JSONL contains a compaction entry with summary "MOCK SUMMARY"
    //    - recordCompactionEvent called with entryPoint:"inner_loop", succeeded:true
  });
});
```

Note: the test setup will involve real `JsonlSessionRepo` + real `Session` creation. The
implementer should look at existing integration tests in `server/test/` for patterns
(particularly any test that drives a full `manager.sendMessage` / `manager.prompt` flow with a
faux provider). If no such existing test exists, the implementer should construct the faux
provider following the pi-agent-core `streamFn` contract (search
`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js` for `streamFn` and
`streamSimple` for the contract).

### Step 2: Run test to verify it fails

```bash
cd /tmp/compaction-inner-loop-hook-pr2/server
env -u NODE_ENV npx vitest run test/compaction-inner-loop-e2e.test.ts
```

Expected: FAIL — either because mocking isn't set up or because the assertions fail without the
real handler doing the work. After Tasks 1-4 are in place, this test should pass once the
faux-provider scaffolding is correct.

### Step 3: Make it pass

If Tasks 1-4 are correct, the test should pass once the test file's faux-provider scaffolding
is wired correctly. If it fails after that, the failure points to either:
- A bug in the test scaffolding (faux provider doesn't match pi-agent-core's contract)
- A real bug in Tasks 1-4 (the integration between pure functions and the session-write path)
- The summary-message shape returned by `buildPostCompactionMessages` doesn't match what
  `session.appendCompaction` writes (so call 2's messages don't include the summary text)

Each of these is a real find — debug and fix. Do NOT loosen the assertions to make the test
pass. If the summary-message shape needs tweaking, fix `buildPostCompactionMessages`.

### Step 4: Commit

```bash
cd /tmp/compaction-inner-loop-hook-pr2
git add server/test/compaction-inner-loop-e2e.test.ts
git commit -m "test(compaction): add real-run e2e regression test for inner-loop hook (#70)

Drives a real multi-turn agent run with a faux provider, mocks pi-agent-core's
pure compact() at the import boundary, asserts:
- compact() called once during the run
- the second LLM call's context starts with the summary message
- the second call's context is shorter than the first
- the session JSONL has a compaction entry
- recordCompactionEvent fired with entryPoint:'inner_loop', succeeded:true

This is the regression gate against the v1 failure mode where the
inner-loop handler was inert because every unit test mocked the failing call."
```

---

## Task 6: Mirror handler in `server/src/task-manager.ts`

Same handler shape, gated by the existing `active.compactionRunning` concurrency lock that
task-manager has and manager doesn't.

**Files:**
- Modify: `server/src/task-manager.ts` (add `harness.on("context", ...)` in the `wire()` site at ~line 487)
- Modify: `server/test/...` (add mirror tests if a task-manager test file exists; otherwise add to compaction.test.ts under a `describe("TaskManager inner-loop handler")` block)

### Step 1: Read the existing task-manager wiring

```bash
cd /tmp/compaction-inner-loop-hook-pr2
sed -n '480,520p' server/src/task-manager.ts
grep -n 'compactionRunning' server/src/task-manager.ts
```

Confirm the location of the `harness.subscribe(...)` call (the analog of manager.ts:198) and
the location/usage of `active.compactionRunning` (the lock).

### Step 2: Write the failing test

Mirror the Layer 2 handler tests, but on TaskManager. Add a `describe("TaskManager inner-loop context handler", ...)` block. Same five tests as Task 4, plus:

```ts
it("respects active.compactionRunning lock: returns undefined when lock held", async () => {
  // - Set active.compactionRunning = true (or whatever the actual lock state is)
  // - opened.compaction.pendingCompaction = {...}
  // - Spy runPendingInlineCompactionInLoop
  // - Invoke emitHook
  // - Assert: result === undefined, runPendingInlineCompactionInLoop NOT called
});
```

### Step 3: Run tests to verify they fail

Expected: FAIL — TaskManager doesn't have the handler yet.

### Step 4: Add the handler to TaskManager in `wire()`

Mirror Task 4's handler, with the lock check added:

```ts
harness.on("context", async (event) => {
  try {
    if (!active.opened.compaction) return undefined;
    if (active.compactionRunning) return undefined;  // lock held, defer to next turn
    if (!active.opened.compaction.pendingCompaction) return undefined;
    active.compactionRunning = true;
    try {
      const branchEntries = await active.opened.session.getBranch();
      const result = await this.manager.runPendingInlineCompactionInLoop(
        active.opened, branchEntries, "inner_loop"
      );
      if (result.ok && result.newMessages) {
        return { messages: result.newMessages };
      }
      if (result.surrendered) {
        return {
          messages: [...event.messages, buildSurrenderAgentMessage(active.opened, 0)],
        };
      }
      return undefined;
    } finally {
      active.compactionRunning = false;
    }
  } catch (err) {
    console.error(
      `[compaction] task-manager inner-loop hook failed for task ${active.taskId}:`,
      err,
    );
    return undefined;
  }
});
```

**Implementer note:** the exact field names (`active.opened`, `active.compactionRunning`,
`active.taskId`) must match what TaskManager uses today. Grep the file to confirm. The
`this.manager.runPendingInlineCompactionInLoop` call assumes TaskManager has a reference to
the `AgentManager` — verify and use the actual reference path.

### Step 5: Run tests to verify pass

```bash
cd /tmp/compaction-inner-loop-hook-pr2/server
env -u NODE_ENV npx vitest run test/...  # (or all tests)
env -u NODE_ENV npm run check
```

Expected: all pass.

### Step 6: Commit

```bash
cd /tmp/compaction-inner-loop-hook-pr2
git add server/src/task-manager.ts server/test/...
git commit -m "feat(compaction): mirror inner-loop context-hook handler in TaskManager

Same handler shape as Manager but gated by the existing
active.compactionRunning concurrency lock. When the lock is held (a
compaction is already in flight for this task), the handler returns
undefined and defers to the next turn's context hook.

Completes issue #70: proactive compaction now fires between turns of
autonomous runs in both the chat path (Manager) and the delegated-task
path (TaskManager)."
```

---

## Task 7: Gate + frontend safety + ship

**Files:** none.

### Step 1: Frontend safety grep (#73 lesson)

```bash
cd /tmp/compaction-inner-loop-hook-pr2
grep -rE "(ContextResult|inner_loop|runInlineCompactionInLoop|runPendingInlineCompactionInLoop)" web/src/ 2>&1 | head
```

Expected: zero hits. If any appear: investigate (the frontend should not need to know about any
of these symbols).

### Step 2: Run the gate

```bash
cd /tmp/compaction-inner-loop-hook-pr2
env -u NODE_ENV bash scripts/gate.sh 2>&1 | tail -50
```

Expected: `=== gate: PASSED ===`. If anything fails: fix in-place, do not paper over.

### Step 3: Rebase check (cog pattern: rebase if base older than origin/main)

```bash
cd /tmp/compaction-inner-loop-hook-pr2
git fetch origin main
LOCAL_BASE=$(git merge-base HEAD origin/main)
REMOTE_HEAD=$(git rev-parse origin/main)
[ "$LOCAL_BASE" = "$REMOTE_HEAD" ] && echo "base is current" || echo "REBASE NEEDED — base $LOCAL_BASE differs from origin/main $REMOTE_HEAD"
```

If rebase is needed: rebase onto origin/main, re-run gate, force-push.

### Step 4: Invoke `/ship`

```
/ship
```

The ship skill handles: PR creation, body composition, merge, worktree cleanup, dev-log /
wiki / hot-memory updates.

---

## Out of scope (do not implement)

- Patching pi-agent-core
- Plumbing pi's loop-level `AbortSignal` to `compact()`
- Unifying idle/reactive sites onto the pure-function path
- Changes to PR 1's `entryPoint` telemetry (already merged in `13a6954`)
- Changes to the compaction-pill UI (PR #86 already covers all entry points)
