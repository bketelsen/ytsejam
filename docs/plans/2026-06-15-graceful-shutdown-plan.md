# Graceful Shutdown Implementation Plan

> Execute with the `develop` skill, task-by-task.

**Goal:** Make `systemctl --user restart ytsejam` exit cleanly in <2s typical and <10s with active work, eliminating the `State 'stop-sigterm' timed out. Killing.` line in journalctl.

**Spec:** `docs/plans/2026-06-15-graceful-shutdown-design.md`

**Issue:** [#210](https://github.com/bketelsen/ytsejam/issues/210)

**Architecture:** Replace the existing two-line SIGTERM/SIGINT handler in `server/src/index.ts` (which only drains LTM) with a `drainAndExit` orchestrator that closes the HTTP server, signals WebSocket clients with 1001, aborts in-flight user turns + subagent tasks, stops the scheduler, drains LTM, and closes the sqlite indexer — each step in its own try/catch, no `process.exit`. Add the minimum public surface (`AgentManager.abortAll`, `TaskManager.cancelAll`, exported `wsClients` set) needed to make this possible.

**Tech Stack:** Node.js, TypeScript, Hono, `@hono/node-server`, `@hono/node-ws`, vitest

**Worktree:** `~/projects/.worktrees/graceful-shutdown`

**Branch:** `fix/graceful-shutdown`

**Baseline (recorded 2026-06-15):** server vitest 162 passed / 1 skipped; web node:test 158 passed; web build clean. `bash scripts/gate.sh` → PASSED.

---

## Task 1: Add `AgentManager.abortAll()`

**Files:**
- Modify: `server/src/manager.ts` (add public method, mirror of existing `abort(id)` at ~line 739)
- Test: `server/test/manager-abort-all.test.ts` (new)

### Step 1: Write the failing test

Create `server/test/manager-abort-all.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { AgentManager } from "../src/manager.js";

describe("AgentManager.abortAll", () => {
  it("calls harness.abort() on every opened session and awaits all", async () => {
    // Construct an AgentManager with a stub openedSessions map containing
    // 3 fake sessions; assert all three harness.abort() calls fire and the
    // returned promise resolves only after all settle.
    //
    // Use the same construction pattern as existing manager tests
    // (server/test/manager.test.ts uses real AgentManager with stubbed
    // dependencies; mirror that). Inject three fake `opened` entries with
    // `harness: { abort: vi.fn(async () => { await delay(5); }) }`.

    // Pseudocode (real test code follows the existing manager.test.ts shape):
    // const mgr = new AgentManager({ ...stubs });
    // (mgr as any).opened.set("a", { harness: { abort: vi.fn(...) } });
    // (mgr as any).opened.set("b", { harness: { abort: vi.fn(...) } });
    // (mgr as any).opened.set("c", { harness: { abort: vi.fn(...) } });
    // await mgr.abortAll();
    // expect each abort to have been called once.
  });

  it("is idempotent — abortAll() then abortAll() does not throw", async () => {
    // Same construction; call twice; second call resolves with no error
    // even if some sessions are already aborted (mock abort() to throw on
    // 2nd call and confirm the orchestrator swallows or returns settled).
  });

  it("resolves even when one harness.abort() rejects", async () => {
    // Three sessions; middle one's abort() rejects with new Error("boom");
    // assert abortAll() still resolves (uses Promise.allSettled internally
    // or per-call try/catch) and the other two completed.
  });
});
```

(Adapt the construction to whatever pattern `server/test/manager.test.ts` uses — DO NOT invent a new stubbing convention. Read that file first.)

### Step 2: Run test to verify it fails

Run: `cd server && npx vitest run test/manager-abort-all.test.ts`
Expected: FAIL with `TypeError: mgr.abortAll is not a function` (or similar — the method doesn't exist yet).

### Step 3: Implement `abortAll()`

In `server/src/manager.ts`, add immediately after the existing `abort(id)` method (~line 741):

```ts
/**
 * Abort every open session's in-flight pi-ai turn. Used by the SIGTERM
 * drain in index.ts. Uses Promise.allSettled so one harness's failure
 * does not block the others; per-call errors are logged but not thrown.
 * Idempotent — calling on an empty/already-drained set is a no-op.
 */
async abortAll(): Promise<void> {
  const aborts = Array.from(this.opened.values()).map(async (opened) => {
    try {
      await opened.harness.abort();
    } catch (err) {
      console.warn(
        `[manager.abortAll] abort failed for session ${opened.id}: ${(err as Error).message}`,
      );
    }
  });
  await Promise.allSettled(aborts);
}
```

### Step 4: Run test to verify it passes

Run: `cd server && npx vitest run test/manager-abort-all.test.ts`
Expected: PASS, all 3 tests green.

### Step 5: Run full gate

Run: `bash scripts/gate.sh`
Expected: PASS, baseline +3 tests (165 passed / 1 skipped on server).

### Step 6: Commit

```bash
git add server/src/manager.ts server/test/manager-abort-all.test.ts
git commit -m "feat(manager): add abortAll() for shutdown drain

Iterates the opened-sessions map and calls harness.abort() on each,
swallowing per-session errors so one bad abort doesn't block the rest.
Mirrors existing abort(id) shape. Used by the new SIGTERM drain in
index.ts (Task 4).

Refs #210"
```

---

## Task 2: Add `TaskManager.cancelAll()`

**Files:**
- Modify: `server/src/task-manager.ts` (add public method, after existing `cancel(id)` at line 171)
- Test: `server/test/task-manager-cancel-all.test.ts` (new)

### Step 1: Write the failing test

Create `server/test/task-manager-cancel-all.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { TaskManager } from "../src/task-manager.js";

describe("TaskManager.cancelAll", () => {
  it("calls cancel(id) on every active task and resolves once all return", async () => {
    // Construct a TaskManager with the test fixtures used by existing
    // task-manager tests (server/test/task-manager.test.ts); seed three
    // entries in the private `active` map; spy on cancel(); call
    // cancelAll(); assert cancel() was called for each id exactly once.
  });

  it("is a no-op when the active set is empty", async () => {
    // Empty active map; cancelAll() resolves immediately, no errors.
  });

  it("resolves even when one cancel() throws", async () => {
    // Three active tasks; middle one's cancel() rejects; cancelAll()
    // still resolves; other two completed.
  });
});
```

(Read `server/test/task-manager.test.ts` first to match its construction pattern.)

### Step 2: Run test to verify it fails

Run: `cd server && npx vitest run test/task-manager-cancel-all.test.ts`
Expected: FAIL with `TypeError: tm.cancelAll is not a function`.

### Step 3: Implement `cancelAll()`

In `server/src/task-manager.ts`, add immediately after `cancel(taskId)` (~line 187, after the existing method):

```ts
/**
 * Cancel every active task. Used by the SIGTERM drain in index.ts.
 * Wraps the existing cancel(id) which already records "cancelled" in
 * JSONL and fires harness.abort() fire-and-forget. Uses allSettled so
 * one task's failure does not block the others. Idempotent.
 */
async cancelAll(): Promise<void> {
  const ids = Array.from(this.active.keys());
  const cancels = ids.map(async (id) => {
    try {
      await this.cancel(id);
    } catch (err) {
      console.warn(
        `[task-manager.cancelAll] cancel failed for task ${id}: ${(err as Error).message}`,
      );
    }
  });
  await Promise.allSettled(cancels);
}
```

### Step 4: Run test to verify it passes

Run: `cd server && npx vitest run test/task-manager-cancel-all.test.ts`
Expected: PASS, all 3 tests green.

### Step 5: Run full gate

Run: `bash scripts/gate.sh`
Expected: PASS, server +3 more tests.

### Step 6: Commit

```bash
git add server/src/task-manager.ts server/test/task-manager-cancel-all.test.ts
git commit -m "feat(task-manager): add cancelAll() for shutdown drain

Batches the existing per-id cancel() over the active map, with
per-task try/catch and Promise.allSettled so one failure doesn't
block the others. Used by the new SIGTERM drain in index.ts (Task 4).

Refs #210"
```

---

## Task 3: Export `wss` from `createApp` for shutdown drain

**Files:**
- Modify: `server/src/server.ts` (destructure `wss` from `createNodeWebSocket`, export from `createApp`)
- Test: `server/test/server-wss-export.test.ts` (new — one small assertion)

### Design reversal (recorded 2026-06-15)

The original design (`docs/plans/2026-06-15-graceful-shutdown-design.md` §"New surface" #3) rejected using `wss.clients` as "fragile and tied to library internals" and proposed maintaining our own `Set<WSContext>` + wiring `onOpen`/`onClose` add/delete on every `upgradeWebSocket` handler.

**Reading the actual `node_modules/@hono/node-ws/dist/index.d.ts` shows otherwise:**

```ts
interface NodeWebSocket {
  upgradeWebSocket: UpgradeWebSocket<WebSocket, { onError: ... }>;
  injectWebSocket(server: Server | Http2Server | Http2SecureServer): void;
  wss: WebSocketServer;   // <-- first-class public export
}
```

`wss` is a documented field of the public type, not internals-fishing. `ws.WebSocketServer.clients` is the standard `ws` library API (`Set<WebSocket>`), and `ws.WebSocket.close(code?, data?)` is a stable supported method on each client.

This simpler shape:
- Skips the `wsClients: Set<WSContext>` field
- Skips the N `onOpen`/`onClose` wiring per `upgradeWebSocket` handler
- Skips a lifecycle-hooks unit test category

Task 4's drain loop simply iterates `for (const ws of wss.clients) ws.close(1001, "...")`.

**One-line undo if this turns out wrong:** revert to the original design — re-introduce the `Set<WSContext>` field, wire `onOpen`/`onClose` per-handler, restore the lifecycle unit test.

### Step 1: Write the failing test

Create `server/test/server-wss-export.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import { WebSocketServer } from "ws";
import { createApp } from "../src/server.ts";

describe("createApp wss export", () => {
  test("exports the underlying ws.WebSocketServer alongside app and injectWebSocket", () => {
    // Use the minimum-viable opts pattern from server/test/server.test.ts
    // (or task-manager.test.ts) — every dep can be a small stub.
    const { app, injectWebSocket, wss } = createApp({ /* stubs */ } as any);
    expect(app).toBeDefined();
    expect(typeof injectWebSocket).toBe("function");
    expect(wss).toBeInstanceOf(WebSocketServer);
  });
});
```

(Read `server/test/server.test.ts` first to match its construction pattern if it exists. If it does not, copy the stubbing convention from `server/test/task-manager.test.ts` — it's the file with the closest dependency surface.)

### Step 2: Run test to verify it fails

Run: `cd server && npx vitest run test/server-wss-export.test.ts`
Expected: FAIL with `wss is undefined` (the destructure misses).

### Step 3: Implement the export

In `server/src/server.ts`:

1. Find the existing `createNodeWebSocket` call (~line 53):
   ```ts
   const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
   ```

2. Add `wss` to the destructure:
   ```ts
   const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({ app });
   ```

3. At the return statement (~line 354), add `wss` to the returned object:
   ```ts
   return { app, injectWebSocket, wss };
   ```

That's the entire implementation — no new module-level state, no per-handler edits, no new imports.

### Step 4: Run test to verify it passes

Run: `cd server && npx vitest run test/server-wss-export.test.ts`
Expected: PASS, 1 test green.

### Step 5: Run full gate

Run: `bash scripts/gate.sh`
Expected: PASS, no regressions.

### Step 6: Commit

```bash
git add server/src/server.ts server/test/server-wss-export.test.ts
git commit -m "feat(server): export ws.WebSocketServer for shutdown drain

createNodeWebSocket's public return type includes wss: WebSocketServer
(verified in node_modules/@hono/node-ws/dist/index.d.ts). Surfacing it
from createApp lets the SIGTERM drain in index.ts (Task 4) iterate
wss.clients and send 1001 close frames using the stable ws library API.

Reverses the design's original 'maintain our own Set<WSContext>' shape
after reading the actual .d.ts showed wss is first-class public surface,
not internals-fishing.

Refs #210"
```

---

## Task 4: Replace the SIGTERM/SIGINT handler with `drainAndExit`

**Files:**
- Modify: `server/src/index.ts` (replace lines 215-241 + 250-260 area — the existing `shutdownLtm` + signal handlers + `serve()` wiring)

### Step 1: Write the failing test — manual verification only

This is the orchestrator; full integration testing requires a running process + systemd. The unit work was covered by Tasks 1–3. Acceptance for Task 4 is the manual recipes in Task 5.

**Skip the unit test for this task** — call out in the commit message that the orchestrator's correctness rides on Tasks 1–3 unit tests plus the manual recipes.

### Step 2: Implement `drainAndExit`

In `server/src/index.ts`:

1. **Destructure `wsClients` from `createApp`** at line 250:
   ```ts
   const { app, injectWebSocket, wsClients } = createApp({ ... });
   ```

2. **Replace** the existing signal handlers (lines 240-241):
   ```ts
   process.once("SIGTERM", () => void shutdownLtm("SIGTERM"));
   process.once("SIGINT", () => void shutdownLtm("SIGINT"));
   ```
   with the new orchestrator. Add it AFTER `injectWebSocket(server)` (line 260) so `server`, `wsClients`, `manager`, `taskManager`, `scheduler`, `indexer` are all in scope:

   ```ts
   // SIGTERM/SIGINT drain — extends the LTM-only handler to drain the whole
   // process. Each step is try/caught and logged; the process exits naturally
   // once all handles release. We do NOT process.exit — a stuck handle should
   // fall through to systemd's SIGKILL at TimeoutStopSec=45 so the offending
   // step is visible in journalctl, not masked by a forced exit. See
   // docs/plans/2026-06-15-graceful-shutdown-design.md.
   let draining = false;
   const drainAndExit = async (signal: string): Promise<void> => {
     if (draining) return; // process.once already guards, but belt-and-suspenders
     draining = true;
     console.log(`[shutdown] ${signal} received, draining`);

     // 1. Stop accepting new HTTP requests (existing in-flight requests finish)
     await new Promise<void>((resolve) => {
       server.close((err) => {
         if (err) console.warn(`[shutdown] server.close: ${err.message}`);
         resolve();
       });
     });

     // 2. Close every attached WebSocket with code 1001 (going away)
     for (const ws of wsClients) {
       try {
         ws.close(1001, "server shutting down");
       } catch (err) {
         console.warn(`[shutdown] ws.close: ${(err as Error).message}`);
       }
     }

     // 3. Abort every in-flight user-facing turn (partial-turn JSONL
     //    reconciliation already exists for crashes)
     try {
       await manager.abortAll();
     } catch (err) {
       console.warn(`[shutdown] manager.abortAll: ${(err as Error).message}`);
     }

     // 4. Cancel every active subagent task (records "cancelled" in JSONL,
     //    fires harness.abort fire-and-forget)
     try {
       await taskManager.cancelAll();
     } catch (err) {
       console.warn(`[shutdown] taskManager.cancelAll: ${(err as Error).message}`);
     }

     // 5. Stop the scheduler (cron timers + at-jobs)
     try {
       scheduler.stop();
     } catch (err) {
       console.warn(`[shutdown] scheduler.stop: ${(err as Error).message}`);
     }

     // 6. Drain the LTM bridge (existing shutdownLtm logic)
     try {
       await shutdownLtm(signal);
     } catch (err) {
       console.warn(`[shutdown] shutdownLtm: ${(err as Error).message}`);
     }

     // 7. Close the sqlite indexer (finalizes WAL, removes -wal file)
     try {
       indexer.close();
     } catch (err) {
       console.warn(`[shutdown] indexer.close: ${(err as Error).message}`);
     }

     console.log(`[shutdown] drain complete`);
     // No process.exit. Loop empties → Node exits naturally.
   };

   process.once("SIGTERM", () => void drainAndExit("SIGTERM"));
   process.once("SIGINT", () => void drainAndExit("SIGINT"));
   ```

3. **Remove the old standalone signal handlers** (the two `process.once` lines at 240-241). The existing `shutdownLtm` function stays — it is called by step 6.

Note carried forward from Task 2 quality review (Q6): `await taskManager.cancelAll()` returns once cancellations are **durably recorded + aborts initiated**, not after harnesses fully drain. Do NOT treat its resolution as "all subagents quiesced." The cancel-wins JSONL guard + `recoverInterrupted` on next boot handle any harness that's still wrapping up; the drain just needs to release sockets/timers so Node's loop empties.

### Step 3: Manual smoke test (dev mode)

Run the dev server, then SIGTERM it and observe:

```bash
# Terminal 1
cd ~/projects/.worktrees/graceful-shutdown && bash deploy/dev.sh

# Wait for "ytsejam listening on http://...:3000"
# Terminal 2
pkill -TERM -f 'node.*src/index.ts'

# Terminal 1 should show, in order:
# [shutdown] SIGTERM received, draining
# [memory] SIGTERM received, draining LTM bridge   (from shutdownLtm at step 6)
# [shutdown] drain complete
# (process exits cleanly, no SIGKILL needed)
```

Expected: dev process exits in <2s with the `[shutdown] drain complete` line.

### Step 4: Run full gate

Run: `bash scripts/gate.sh`
Expected: PASS, all baseline + Task 1/2/3 tests still green.

### Step 5: Commit

```bash
git add server/src/index.ts
git commit -m "feat(server): drain HTTP/WS/manager/tasks/scheduler/indexer on SIGTERM

Replaces the LTM-only signal handler with a 7-step drain orchestrator
that closes the HTTP server, signals WS clients with 1001, aborts
in-flight user turns and subagent tasks, stops the scheduler, drains
LTM (existing shutdownLtm logic), and closes the sqlite indexer.

Each step in its own try/catch; no process.exit (a stuck handle falls
through to systemd's TimeoutStopSec=45 SIGKILL so the failing step is
visible in journalctl rather than masked by a forced exit).

Orchestrator correctness rides on:
- AgentManager.abortAll() unit tests (Task 1)
- TaskManager.cancelAll() unit tests (Task 2)
- wsClients tracking unit test (Task 3)
- Manual dev-mode smoke test (this commit's step 3)
- Production verification recipes documented in deploy/README.md (Task 5)

Closes #210"
```

---

## Task 5: Document the verification recipes in `deploy/README.md`

**Files:**
- Modify: `deploy/README.md` (add a "Graceful shutdown verification" section)

### Step 1: Read existing structure

```bash
cat deploy/README.md | head -50
```

Identify the best insertion point (likely after the deploy/rollback sections, before any troubleshooting section if present).

### Step 2: Add the recipes section

Append the following section (adapt heading level to match existing structure):

````markdown
## Graceful shutdown verification

The SIGTERM drain (`server/src/index.ts` `drainAndExit`) closes the HTTP server, signals WebSocket clients, aborts in-flight user turns and subagent tasks, stops the scheduler, drains LTM, and closes the sqlite indexer — all within `TimeoutStopSec=45` from `deploy/ytsejam.service`. Verify with these recipes after any change to the shutdown path:

### Recipe A — quiescent restart (typical)

```bash
systemctl --user restart ytsejam
journalctl --user -u ytsejam -n 20 --no-pager
```

Expect: `[shutdown] SIGTERM received, draining` followed within ~2s by `[shutdown] drain complete` and the service back up. Zero occurrences of `State 'stop-sigterm' timed out. Killing.`.

### Recipe B — restart with an active subagent

In a ytsejam chat, dispatch a long delegate (e.g. a bash tool that runs `sleep 60`). While it's running:

```bash
systemctl --user restart ytsejam
journalctl --user -u ytsejam -n 30 --no-pager
```

Expect: `[shutdown] drain complete` within ~10s. The cancelled task is recorded in JSONL with `status: cancelled`. No SIGKILL line in journal.

### Recipe C — restart mid-turn (user session)

In a ytsejam chat, start a turn with a long-running tool call. While the turn is streaming:

```bash
systemctl --user restart ytsejam
```

Expect: clean exit within ~10s; the session's JSONL has the partial `turn_start` with no matching `turn_end`; reopening the session in the UI shows the partial turn without crashing the page.

### What "broken" looks like

```
ytsejam.service: State 'stop-sigterm' timed out. Killing.
ytsejam.service: Killing process N (node-MainThread) with signal SIGKILL.
```

If you see this, one of the seven drain steps hung. The previous `[shutdown] <step>: <error>` warn line (or the absence of `[shutdown] drain complete`) tells you which step. See [#210](https://github.com/bketelsen/ytsejam/issues/210) for the original cause analysis.
````

### Step 3: Verify markdown lints clean

If the repo has a pre-commit hook for markdownlint, run it. Otherwise:

```bash
git add deploy/README.md
git diff --cached deploy/README.md   # sanity-check the diff
```

### Step 4: Commit

```bash
git commit -m "docs(deploy): add graceful-shutdown verification recipes

Three recipes (quiescent, active subagent, active user turn) for
verifying the SIGTERM drain after any change to the shutdown path,
plus a 'what broken looks like' section pointing at the journal
markers and #210.

Refs #210"
```

---

## Task 6: Open the PR

### Step 1: Push the branch and open the PR

```bash
git push -u origin fix/graceful-shutdown
gh pr create \
  --title "Graceful shutdown: drain HTTP/WS/manager/tasks/scheduler/indexer on SIGTERM (closes #210)" \
  --body "$(cat <<'EOF'
## Summary

Closes #210. Replaces the existing LTM-only SIGTERM/SIGINT handler with a 7-step drain orchestrator. Adds the minimum public surface (`AgentManager.abortAll`, `TaskManager.cancelAll`, exported `wsClients` set) to make whole-process drain possible.

**Spec:** `docs/plans/2026-06-15-graceful-shutdown-design.md`
**Plan:** `docs/plans/2026-06-15-graceful-shutdown-plan.md`

## Behavior change

Before: `systemctl --user restart ytsejam` waits the full `TimeoutStopSec=45` and systemd SIGKILLs. Even on a quiescent restart.

After: clean exit in <2s typical, <10s with active subagent or open user turn. No `State 'stop-sigterm' timed out. Killing.` lines in journalctl.

## Verification

- Server unit tests: `AgentManager.abortAll` + `TaskManager.cancelAll` + `wsClients` export — all green
- Gate: `bash scripts/gate.sh` PASS
- Manual dev-mode smoke: SIGTERM to `bash deploy/dev.sh` exits cleanly with `[shutdown] drain complete`
- Production recipes documented in `deploy/README.md`

## Per the design's Q-table

| Q | Decision |
|---|---|
| In-flight subagents | abort immediately |
| In-flight user turns | abort immediately |
| WS clients | send 1001 close frame |
| Step failure | try/catch + log, no process.exit |

## Non-goals (explicit)

- No restart-resume of in-flight subagent tasks across restarts (separate brainstorm)
- No change to `TimeoutStopSec=45`
- No new shutdown library/dep

EOF
)"
```

### Step 2: Hand off to `/ship`

After PR opens, invoke the `ship` skill to:
- Confirm the gate passed in CI
- Auto-merge per Brian's standing workflow (`gh pr merge <N> --squash --delete-branch`)
- Fast-forward local `main`
- Deploy to prod (`bash deploy/deploy.sh`) and restart the live service
- Verify the new drain behavior on prod with Recipe A
- Update cog dev-log for the project

---

## Out of plan

- **Cog memory updates** — handled by `/ship` skill, not here.
- **`/find-weeds` follow-ups** — none expected from this PR; if any structural smells surface during implementation, the implementer should flag them in the per-task report tail, not fold them in.
