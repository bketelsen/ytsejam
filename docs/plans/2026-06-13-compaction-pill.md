# Compaction Pill Implementation Plan

> Execute with the `develop` skill, task-by-task.

**Goal:** Show a `compacting…` pill in the chat header and an amber pulse dot in the sidebar row while context compaction is in progress for a session, driven by server-emitted WebSocket events and a session-metadata flag for reload rehydration.

**Spec:** `docs/plans/2026-06-13-compaction-pill-design.md`

**Architecture:** Add two new `ServerEvent` variants (`compaction_start`, `compaction_end`) emitted by `AgentManager` around each `runCompactionIfPending` call site. Track a per-session `compacting` boolean on `OpenSession`, expose `manager.isCompacting(id)`, surface the flag through `session_meta` events and the `GET /api/sessions(/:id)` JSON. React reducer mirrors per-session state; Sidebar prefers amber dot over green; Chat header renders a small pill.

**Tech Stack:** TypeScript (server: Node 22, vitest), React + Vite (web: Tailwind, hand-rolled `node:test` structural tests).

**Worktree:** /tmp/compaction-pill

**Branch:** compaction-pill

---

## Conventions for every task

- All commands run from the worktree root (`/tmp/compaction-pill`) unless explicitly stated.
- Prefix every npm/vitest/tsc invocation with `env -u NODE_ENV` to defeat the inherited `NODE_ENV=production` that makes npm skip devDependencies.
- The gate is `bash scripts/gate.sh` — single authoritative pass/fail check.
- Each task ends with a commit; commit messages use Conventional Commits (`feat`, `fix`, `refactor`, `test`, `docs`, `chore`).
- The full gate runs only at Tasks 6 and 10; intermediate tasks use targeted `npm test --workspace server -- <pattern>` / structural-source greps to stay fast.

---

## Task 1: Extend `ServerEvent` with `compaction_start` / `compaction_end`

**Files:**
- Modify: `server/src/events.ts`

### Step 1: Add the two new variants to `ServerEvent`

Edit `server/src/events.ts`. Append the two new variants to the existing union type. The full updated type:

```ts
export type ServerEvent =
  | { type: "agent"; sessionId: string; event: AgentEvent }
  | { type: "session_meta"; session: SessionRow & { running: boolean; compacting: boolean } }
  | { type: "session_archived"; sessionId: string }
  | { type: "session_unarchived"; sessionId: string }
  | { type: "task"; task: TaskRow }
  | { type: "schedule"; schedule: ScheduleRow }
  | { type: "compaction_start"; sessionId: string; trigger: "proactive" | "reactive" }
  | { type: "compaction_end"; sessionId: string; status: "succeeded" | "surrendered" | "failed" };
```

Note the `session_meta` change: `compacting: boolean` is added alongside `running: boolean`. This is required for reload/reconnect rehydration per the design.

### Step 2: Run server typecheck to find call sites that need updating

Run: `env -u NODE_ENV npm run check --workspace server`

Expected: FAIL with errors in `manager.ts` (around `emitMeta`, line ~750) and `server.ts` (around the `GET /api/sessions` and `GET /api/sessions/:id` handlers, ~lines 89–107), all referencing a `running`-only `session_meta` payload or a `SessionRow & { running }` shape. These are the seams we'll fix in Task 4.

### Step 3: Commit (the type change alone, even though it breaks `tsc` — fix lands in Task 4)

We will NOT commit a broken-typecheck tree. Stage this change but defer the commit until Task 4 lands the `isCompacting` + payload-include fixes. Hold:

```bash
git status   # confirm events.ts is modified, not committed
```

(Task 4 commits Tasks 1+2+3+4 together as one atomic "events surface + manager flag" commit. This task is a logical step, not a separate commit.)

---

## Task 2: Add per-session `compacting` flag and `isCompacting` to `AgentManager`

**Files:**
- Modify: `server/src/manager.ts`

### Step 1: Add `compacting: boolean` to the `OpenSession` interface

Edit `server/src/manager.ts` around line 112 (the `OpenSession` interface). Add the field next to `running`:

```ts
interface OpenSession {
  // ... existing fields ...
  running: boolean;
  compacting: boolean;  // NEW — true while runCompactionIfPending is in flight
  // ... existing fields ...
}
```

Initialize `compacting: false` in the `OpenSession` constructor literal around line 239 (where `running: false` is set).

### Step 2: Add `isCompacting(id)` method, mirroring `isRunning`

Insert immediately after the existing `isRunning` method (around line 601):

```ts
isCompacting(id: string): boolean {
  return this.open.get(id)?.compacting ?? false;
}
```

### Step 3: Verify typecheck (will still fail — Task 4 finishes the wiring)

Run: `env -u NODE_ENV npm run check --workspace server 2>&1 | head -30`

Expected: typecheck errors remain on `emitMeta` and `server.ts` handlers (Task 4 fixes). The new `OpenSession.compacting` field should NOT show any error (you initialized it).

### Step 4: No commit yet (rolls into Task 4)

---

## Task 3: Add emit + flag bookkeeping helpers in `AgentManager`

**Files:**
- Modify: `server/src/manager.ts`

### Step 1: Add two private helpers, `markCompactionStart` and `markCompactionEnd`

Insert just before `emitMeta` (around line 745):

```ts
private markCompactionStart(opened: OpenSession, trigger: "proactive" | "reactive"): void {
  if (opened.compacting) return;  // idempotent: never double-emit start
  opened.compacting = true;
  this.opts.bus.emit({ type: "compaction_start", sessionId: opened.id, trigger });
  this.emitMeta(opened.id);
}

private markCompactionEnd(opened: OpenSession, status: "succeeded" | "surrendered" | "failed"): void {
  if (!opened.compacting) return;  // idempotent: never emit end without a matching start
  opened.compacting = false;
  this.opts.bus.emit({ type: "compaction_end", sessionId: opened.id, status });
  this.emitMeta(opened.id);
}
```

The idempotence guards matter: the design has overlapping code paths (reactive turn_end queues a pending compaction that fires at the NEXT agent_end; surrender paths may fire after end was already emitted by a runCompactionIfPending finally block). The guards make accidental double-emit a silent no-op rather than a wire-state corruption.

### Step 2: No commit yet (rolls into Task 4)

---

## Task 4: Wire emit calls at the three compaction sites; finish session_meta + HTTP plumbing

**Files:**
- Modify: `server/src/manager.ts`
- Modify: `server/src/server.ts`

### Step 1: Wrap the reactive retry path (manager.ts ~L313–L356)

Locate the block in `onHarnessEvent` starting at `if (opened.compaction?.pendingCompaction?.trigger === "reactive")` (around line 313). The `await runCompactionIfPending(...)` call is inside it. Wrap with a try/finally:

```ts
if (opened.compaction?.pendingCompaction?.trigger === "reactive") {
  // existing comment block stays
  opened.compaction.lastCompactionDetails = undefined;

  this.markCompactionStart(opened, "reactive");
  let endStatus: "succeeded" | "surrendered" | "failed" = "failed";
  try {
    const result = await runCompactionIfPending(
      toOpenedForCompaction({
        session: opened.session,
        metadata: opened.metadata,
        harness: opened.harness,
        compaction: opened.compaction,
      }),
      this.repo,
    );
    if (result.fired) {
      await this.recordCompactionEvent(
        opened,
        result,
        opened.compaction.lastCompactionDetails,
      );
      opened.compaction.lastCompactionDetails = undefined;
    }
    endStatus = result.succeeded ? "succeeded" : "surrendered";
    if (!result.succeeded) {
      await this.emitCompactionSurrender(opened);
    } else {
      setTimeout(() => {
        if (this.open.get(opened.id) !== opened) return;
        opened.running = true;
        opened.harness.prompt(REACTIVE_RETRY_PROMPT).catch((err) => {
          console.error(
            `reactive retry prompt failed for session ${opened.id}`,
            err,
          );
          opened.running = false;
        });
      }, 0);
    }
  } finally {
    this.markCompactionEnd(opened, endStatus);
  }
}
```

Note: the existing block does NOT have its own try/catch — errors propagate up to the outer `.catch` in `harness.subscribe`. Adding a try/finally that only handles the `markCompactionEnd` ensures the flag never gets stuck-true even on throw; the error still propagates after the finally.

### Step 2: Wrap the proactive idle-drain path (manager.ts ~L405–L430)

Locate `runPendingCompactionAtIdle` (around line 405). Wrap the existing body with start/finally similarly:

```ts
private async runPendingCompactionAtIdle(
  opened: OpenSession,
): Promise<boolean> {
  if (!opened.compaction?.pendingCompaction) return true;
  opened.compaction.lastCompactionDetails = undefined;

  this.markCompactionStart(opened, "proactive");
  let endStatus: "succeeded" | "surrendered" | "failed" = "failed";
  try {
    const result = await runCompactionIfPending(
      toOpenedForCompaction({
        session: opened.session,
        metadata: opened.metadata,
        harness: opened.harness,
        compaction: opened.compaction,
      }),
      this.repo,
    );
    if (result.fired) {
      await this.recordCompactionEvent(
        opened,
        result,
        opened.compaction.lastCompactionDetails,
      );
      opened.compaction.lastCompactionDetails = undefined;
    }
    endStatus = result.surrendered ? "surrendered" : "succeeded";
    if (result.surrendered) {
      await this.emitCompactionSurrender(opened);
      return false;
    }
    return true;
  } finally {
    this.markCompactionEnd(opened, endStatus);
  }
}
```

### Step 3: Handle the standalone surrender path in `handleCompactionTurnEnd` (manager.ts ~L369–L372)

Locate the `if (opened.compaction.reactiveRetryAttempted)` branch in `handleCompactionTurnEnd` (around line 369). This surrender path runs WITHOUT a wrapping `runCompactionIfPending`, so there is no `compaction_start` to pair with. The guard in `markCompactionEnd` (skips if `!opened.compacting`) makes this a no-op when there was no prior start — exactly the safety net we want. No code change needed here unless tests prove otherwise.

(If a future test reveals a missed surrender path with an unpaired emit, add an explicit `markCompactionEnd(opened, "surrendered")` at that site. We track that as Open Question #1 below.)

### Step 4: Update `emitMeta` to include `compacting`

Edit `emitMeta` (manager.ts ~L745):

```ts
private emitMeta(id: string): void {
  const row = this.opts.indexer.getSession(id);
  if (row) {
    this.opts.bus.emit({
      type: "session_meta",
      session: { ...row, running: this.isRunning(id), compacting: this.isCompacting(id) },
    });
  }
}
```

### Step 5: Update HTTP handlers to include `compacting`

Edit `server/src/server.ts`:

- `GET /api/sessions` (~line 87): change the map to include `compacting`:
  ```ts
  .map((s) => ({ ...s, running: manager.isRunning(s.id), compacting: manager.isCompacting(s.id) }));
  ```
- `POST /api/sessions` (~line 98): include `compacting: false` in the response payload:
  ```ts
  return c.json({ session: { ...session, running: false, compacting: false } });
  ```
- `GET /api/sessions/:id` (~line 107): include `compacting`:
  ```ts
  session: { ...row, running: manager.isRunning(id), compacting: manager.isCompacting(id), cwd: manager.resolveWorkdir(id) },
  ```

### Step 6: Run server typecheck

Run: `env -u NODE_ENV npm run check --workspace server`

Expected: PASS (zero errors).

### Step 7: Commit Tasks 1–4 as one atomic change

```bash
git add server/src/events.ts server/src/manager.ts server/src/server.ts
git commit -m "feat(compaction): emit compaction_start/end events + per-session compacting flag"
```

---

## Task 5: Server unit tests for compaction event emission

**Files:**
- Create: `server/test/compaction-events.test.ts`

### Step 1: Write the test file

This test exercises the proactive path because it's the simplest to drive deterministically with the faux provider. The reactive path is already exercised by the existing `manager.test.ts` tests; we'll piggyback an assertion on those in Step 3.

Create `server/test/compaction-events.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import type { ServerEvent } from "../src/events.ts";
import { fauxAssistantMessage, makeManager, setupFaux } from "./helpers.ts";

async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

let faux: ReturnType<typeof setupFaux>;
beforeEach(() => {
  faux = setupFaux();
});
afterEach(() => {
  faux.unregister();
});

describe("compaction events", () => {
  test("reactive compaction emits compaction_start then compaction_end{succeeded}", async () => {
    faux.unregister();
    faux = registerFauxProvider({
      provider: "openai",
      models: [{ id: "faux", contextWindow: 40_000, maxTokens: 256 }],
    }) as any;
    const { manager, bus, dataDir } = makeManager(faux);
    const events: ServerEvent[] = [];
    bus.subscribe((e) => events.push(e));

    const prevDataDir = process.env.YTSEJAM_DATA_DIR;
    const prevOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.YTSEJAM_DATA_DIR = dataDir;
    process.env.OPENAI_API_KEY = "test-key";

    try {
      faux.setResponses([
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "prompt is too long: 50000 tokens > 40000 maximum",
        }),
        fauxAssistantMessage("Summary of compacted overflow."),
        fauxAssistantMessage("Recovered after reactive compaction"),
      ]);

      const row = await manager.createSession();
      await manager.sendMessage(row.id, "trigger overflow");
      await waitFor(() =>
        events.some(
          (e) =>
            e.type === "agent" &&
            (e as any).event.type === "message_end" &&
            JSON.stringify((e as any).event.message ?? "").includes("Recovered"),
        ),
      );
      await manager.waitForIdle(row.id);

      const starts = events.filter((e) => e.type === "compaction_start");
      const ends = events.filter((e) => e.type === "compaction_end");
      expect(starts).toHaveLength(1);
      expect(starts[0]).toEqual({ type: "compaction_start", sessionId: row.id, trigger: "reactive" });
      expect(ends).toHaveLength(1);
      expect(ends[0]).toEqual({ type: "compaction_end", sessionId: row.id, status: "succeeded" });

      // Ordering: start strictly before end
      const startIdx = events.findIndex((e) => e.type === "compaction_start");
      const endIdx = events.findIndex((e) => e.type === "compaction_end");
      expect(startIdx).toBeLessThan(endIdx);

      // isCompacting is false after the dust settles
      expect(manager.isCompacting(row.id)).toBe(false);
    } finally {
      if (prevDataDir === undefined) delete process.env.YTSEJAM_DATA_DIR;
      else process.env.YTSEJAM_DATA_DIR = prevDataDir;
      if (prevOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevOpenAiKey;
    }
  });

  test("reactive compaction with retry-exhausted surrender emits status=surrendered", async () => {
    faux.unregister();
    faux = registerFauxProvider({
      provider: "openai",
      models: [{ id: "faux", contextWindow: 40_000, maxTokens: 256 }],
    }) as any;
    const { manager, bus, dataDir } = makeManager(faux);
    const events: ServerEvent[] = [];
    bus.subscribe((e) => events.push(e));

    const prevDataDir = process.env.YTSEJAM_DATA_DIR;
    const prevOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.YTSEJAM_DATA_DIR = dataDir;
    process.env.OPENAI_API_KEY = "test-key";

    try {
      faux.setResponses([
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "prompt is too long: 50000 tokens > 40000 maximum",
        }),
        fauxAssistantMessage("Summary."),
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "prompt is too long: 50001 tokens > 40000 maximum",
        }),
      ]);

      const row = await manager.createSession();
      await manager.sendMessage(row.id, "overflow twice");
      await waitFor(() =>
        events.some(
          (e) =>
            e.type === "agent" &&
            (e as any).event.type === "turn_end" &&
            JSON.stringify((e as any).event.message ?? "").includes("Diagnostic: prompt was ~"),
        ),
      );
      await manager.waitForIdle(row.id);

      const ends = events.filter((e) => e.type === "compaction_end");
      // At least one end event with status=surrendered must be present.
      expect(ends.some((e) => (e as any).status === "surrendered")).toBe(true);
      // The flag is cleared.
      expect(manager.isCompacting(row.id)).toBe(false);
    } finally {
      if (prevDataDir === undefined) delete process.env.YTSEJAM_DATA_DIR;
      else process.env.YTSEJAM_DATA_DIR = prevDataDir;
      if (prevOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevOpenAiKey;
    }
  });

  test("session_meta payload includes compacting field", async () => {
    const { manager, bus } = makeManager(faux);
    const seen: ServerEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const row = await manager.createSession();
    // createSession does not emit session_meta directly (it goes through indexer
    // upsert + a separate emit path); poke the surface by triggering a meta emit
    // via the rename path which the existing manager.test.ts tests use.
    await manager.renameSession(row.id, "renamed");
    const meta = seen.find((e) => e.type === "session_meta") as any;
    expect(meta).toBeTruthy();
    expect(typeof meta.session.compacting).toBe("boolean");
    expect(meta.session.compacting).toBe(false);
  });
});
```

### Step 2: Run only the new test file

Run: `env -u NODE_ENV npm test --workspace server -- compaction-events`

Expected: PASS (all 3 tests). If `renameSession` is not the right surface to trigger an `emitMeta` for the third test, replace it with `manager.archiveSession(row.id)` then `manager.unarchiveSession(row.id)`, or whatever public method invokes `emitMeta` in current `manager.ts`. Reading the file confirms `emitMeta` is called by archive/unarchive/title-flush/rename paths.

### Step 3: Run the broader manager tests to confirm no regression

Run: `env -u NODE_ENV npm test --workspace server -- manager`

Expected: PASS (existing tests still green; the new compaction emit calls layer on top, not in the way).

### Step 4: Commit

```bash
git add server/test/compaction-events.test.ts
git commit -m "test(compaction): assert compaction_start/end emission + status mapping"
```

---

## Task 6: Run the full server gate (intermediate checkpoint)

### Step 1: Run the gate

Run: `bash scripts/gate.sh 2>&1 | tail -20`

Expected: PASS. If FAIL, stop and investigate before continuing — the web tasks build on a green server.

### Step 2: No commit (gate check only)

---

## Task 7: Update web types and reducer

**Files:**
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/useApp.ts`

### Step 1: Extend `ServerEvent` and `SessionRow` in web types

Edit `web/src/lib/types.ts`:

- Add `compacting?: boolean;` to the `SessionRow` interface (alongside `running: boolean`). Optional with `?` for forward-compat with any cached payloads that might predate this change; the reducer treats `undefined` as `false`.
- Append two new variants to the `ServerEvent` union:
  ```ts
  | { type: "compaction_start"; sessionId: string; trigger: "proactive" | "reactive" }
  | { type: "compaction_end"; sessionId: string; status: "succeeded" | "surrendered" | "failed" };
  ```

### Step 2: Add reducer cases in `useApp.ts`

Edit `web/src/useApp.ts` `onEvent` callback. Add two new cases alongside the existing `agent` case (which sets `running` from `agent_start`/`agent_end`):

```ts
if (event.type === "compaction_start") {
  setSessions((prev) =>
    prev.map((s) => (s.id === event.sessionId ? { ...s, compacting: true } : s)),
  );
  return;
}
if (event.type === "compaction_end") {
  setSessions((prev) =>
    prev.map((s) => (s.id === event.sessionId ? { ...s, compacting: false } : s)),
  );
  return;
}
```

Place these cases before the `agent` case (or anywhere in the cascade — the early returns make order irrelevant). The `session_meta` case is already a full row replace, so it picks up the server-provided `compacting` automatically.

### Step 3: Web build typechecks

Run: `env -u NODE_ENV npm run build --workspace web 2>&1 | tail -20`

Expected: PASS (vite build + tsc -b both clean).

### Step 4: Commit

```bash
git add web/src/lib/types.ts web/src/useApp.ts
git commit -m "feat(web): extend ServerEvent + reducer with compaction_start/end"
```

---

## Task 8: Render the sidebar amber dot and the chat-header pill

**Files:**
- Modify: `web/src/components/Sidebar.tsx`
- Modify: `web/src/components/Chat.tsx`
- Modify: `web/src/App.tsx`

### Step 1: Sidebar dot priority change

Edit `web/src/components/Sidebar.tsx` around line 92. Replace the existing two-dot ternary:

```tsx
{s.running && <span className="size-2 shrink-0 animate-pulse rounded-full bg-success" />}
{s.unread && !s.running && <span className="size-2 shrink-0 rounded-full bg-primary" />}
```

with a three-way priority (compacting beats running beats unread):

```tsx
{s.compacting ? (
  <span className="size-2 shrink-0 animate-pulse rounded-full bg-warning" />
) : s.running ? (
  <span className="size-2 shrink-0 animate-pulse rounded-full bg-success" />
) : s.unread ? (
  <span className="size-2 shrink-0 rounded-full bg-primary" />
) : null}
```

`bg-warning` is already defined in `web/src/index.css` (verified: `--color-warning` and theme variables exist for both light and dark modes).

### Step 2: Add `compacting` prop to Chat and render the pill

Edit `web/src/components/Chat.tsx`:

- Add `compacting: boolean;` to the props interface (around line 33, next to `running: boolean;`).
- Destructure it from props (around line 23, next to `running`).
- The chat already has a `<header>` at the start of the `<main>` block (around line 80). Add the pill inside the header, after the `<Button>` for the menu icon:
  ```tsx
  <header className="flex items-center gap-2 border-b border-border px-2 py-1.5 md:hidden">
    <Button variant="ghost" size="icon" onClick={onMenuClick} aria-label="Open sessions">
      <Menu />
    </Button>
    {compacting && (
      <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-xs text-warning animate-pulse">
        compacting…
      </span>
    )}
  </header>
  ```

  The existing `<header>` is mobile-only (`md:hidden`). For desktop, we need a parallel render path — but verifying the codebase: there's no equivalent desktop header in `Chat.tsx`; the session title lives in `Sidebar.tsx`. For v1, place the pill in an always-visible location so desktop users see it too. Insert immediately AFTER the existing mobile `<header>` block, as a separate always-visible row:

  ```tsx
  </header>
  {compacting && (
    <div className="flex items-center justify-center border-b border-border px-2 py-1">
      <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-xs text-warning animate-pulse">
        compacting…
      </span>
    </div>
  )}
  ```

  This renders only when `compacting` is true, so it adds zero layout shift in the common case. Centered, no border-bottom flicker (the border only renders when the pill is shown — which is the visible row anyway).

### Step 3: Wire the prop in `App.tsx`

Edit `web/src/App.tsx` around line 62 where `<Chat>` is instantiated. Add the prop:

```tsx
<Chat
  sessionId={app.currentId}
  messages={app.messages}
  streaming={app.streaming}
  running={app.sessions.find((s) => s.id === app.currentId)?.running ?? false}
  compacting={app.sessions.find((s) => s.id === app.currentId)?.compacting ?? false}
  tasks={app.tasks}
  cwd={app.currentCwd}
  onCwdChange={app.setCurrentCwd}
  onSend={app.send}
  onMenuClick={() => setSidebarOpen(true)}
/>
```

### Step 4: Web build typechecks

Run: `env -u NODE_ENV npm run build --workspace web 2>&1 | tail -20`

Expected: PASS.

### Step 5: Commit

```bash
git add web/src/components/Sidebar.tsx web/src/components/Chat.tsx web/src/App.tsx
git commit -m "feat(web): render compacting pill in Chat header + amber dot in Sidebar"
```

---

## Task 9: Web structural tests for the new rendering

**Files:**
- Create: `web/test/compaction-pill.test.mjs`
- Modify: `web/test/run.mjs`

### Step 1: Write the structural test (matches the existing `node:test` source-grep idiom)

Create `web/test/compaction-pill.test.mjs`:

```js
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const sidebar = readFileSync(join(root, "src/components/Sidebar.tsx"), "utf8");
const chat = readFileSync(join(root, "src/components/Chat.tsx"), "utf8");
const app = readFileSync(join(root, "src/App.tsx"), "utf8");
const useApp = readFileSync(join(root, "src/useApp.ts"), "utf8");
const types = readFileSync(join(root, "src/lib/types.ts"), "utf8");

test("ServerEvent union includes compaction_start and compaction_end variants", () => {
  assert.match(types, /type:\s*["']compaction_start["']/);
  assert.match(types, /type:\s*["']compaction_end["']/);
  assert.match(types, /trigger:\s*["']proactive["']\s*\|\s*["']reactive["']/);
  assert.match(
    types,
    /status:\s*["']succeeded["']\s*\|\s*["']surrendered["']\s*\|\s*["']failed["']/,
  );
});

test("SessionRow exposes a compacting field", () => {
  // optional or required — both acceptable for the reducer (?? false defaults)
  assert.match(types, /compacting\??:\s*boolean/);
});

test("useApp reducer handles compaction_start / compaction_end", () => {
  assert.match(useApp, /event\.type\s*===\s*["']compaction_start["']/);
  assert.match(useApp, /event\.type\s*===\s*["']compaction_end["']/);
  // Both cases set compacting on the matching session row.
  assert.match(useApp, /compacting:\s*true/);
  assert.match(useApp, /compacting:\s*false/);
});

test("Sidebar renders amber bg-warning dot when compacting, prefers it over running", () => {
  // The compacting dot class is present.
  assert.match(sidebar, /s\.compacting/);
  assert.match(sidebar, /bg-warning/);
  // Ordering proof: the compacting branch appears BEFORE the running branch
  // in the rendered ternary so the priority is correct.
  const compactingIdx = sidebar.indexOf("s.compacting");
  const runningIdx = sidebar.indexOf("s.running");
  assert.ok(
    compactingIdx !== -1 && runningIdx !== -1,
    "expected both s.compacting and s.running references",
  );
  assert.ok(
    compactingIdx < runningIdx,
    "compacting branch must appear before running branch (priority)",
  );
});

test("Chat declares a compacting prop and renders the compacting… pill", () => {
  assert.match(chat, /compacting:\s*boolean/);
  assert.match(chat, /\{compacting\s*&&/);
  assert.match(chat, /compacting…/);
  // Pill uses the warning color family.
  assert.match(chat, /text-warning/);
});

test("App.tsx passes compacting to <Chat>", () => {
  assert.match(app, /compacting=\{app\.sessions\.find/);
});
```

### Step 2: Register the file in the web test runner

Edit `web/test/run.mjs` and append the import:

```js
import "./compaction-pill.test.mjs";
```

### Step 3: Run web tests

Run: `env -u NODE_ENV npm test --workspace web 2>&1 | tail -30`

Expected: PASS (existing 26 tests + 6 new = 32). If any structural assertion fails, the test message points at the exact pattern that's missing — fix the source until the test passes.

### Step 4: Commit

```bash
git add web/test/compaction-pill.test.mjs web/test/run.mjs
git commit -m "test(web): structural assertions for compaction pill + reducer wiring"
```

---

## Task 10: Final gate run

### Step 1: Run the full gate

Run: `bash scripts/gate.sh 2>&1 | tail -30`

Expected: PASS — all four legs (server typecheck, server tests, web build/typecheck, web tests).

### Step 2: Verify branch state for handoff

```bash
git log --oneline main..HEAD
git status
```

Expected: 4 commits on `compaction-pill`, clean working tree.

### Step 3: Hand off to /ship

The plan is complete. Use the `/ship` skill to PR + merge, following the standing one-PR-per-step workflow (this whole change is ONE step — one PR).

---

## Open questions / risks

1. **Standalone surrender emit pairing (Task 4 Step 3).** The current design relies on `markCompactionEnd`'s idempotence guard to silently no-op when a surrender path fires without a matching prior start. If a code path is ever introduced where a surrender happens WITHOUT a `runCompactionIfPending` having been called immediately before, the start event will never fire and the surrender will pair with nothing — both wires stay quiet, which is correct behavior. The risk is that we one day wire the start emit at a different layer (e.g. inside `runCompactionIfPending` itself), missing one of the three sites. **Mitigation:** Task 5's tests assert that surrender DOES emit `compaction_end{surrendered}` at least once, which keeps the proactive-surrender contract honest.

2. **Desktop pill placement (Task 8 Step 2).** The chosen always-visible row is functional but visually distinct from the mobile-only header. If Brian wants the desktop pill anchored to a session-title area instead, that's a follow-up — the Sidebar already shows the title, but session title in the Chat panel doesn't currently exist as a UI element. **Mitigation:** v1 is correct and discoverable; iterate on placement in a follow-up if needed.

3. **`bg-warning/15` alpha class.** This relies on Tailwind 3.4+ arbitrary opacity syntax. The repo uses Tailwind (verified `bg-warning` works in `index.css`). If `bg-warning/15` fails at build time, fall back to `bg-warning/20` or a custom class.

---

## Roll-back plan

If anything misbehaves post-merge: `git revert <merge-commit>`. The feature is additive (new events, new fields, new components/branches), so revert is clean — no schema migrations, no JSONL format changes, no API breaking changes (the new HTTP `compacting` field is purely additive and clients tolerate it absent).
