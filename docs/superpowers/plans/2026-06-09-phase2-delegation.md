# Phase 2: Async Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The assistant can spawn background subagents (`delegate` tool), keep chatting while they work, and is notified — taking a turn — when they complete; the UI shows live task cards, a tasks view, and read-only subagent transcripts.

**Architecture:** A `TaskStore` appends task lifecycle events to `data/tasks/<task-id>.jsonl` (SSOT); the sqlite `Indexer` gains a derived `tasks` table (schema v2). A `TaskManager` runs subagents as in-process `AgentHarness` instances with their own JSONL sessions (repo cwd `subagent`, so they never appear in the chat sidebar), enforces a concurrency cap and timeout, and on completion/failure injects `[Task "label" …]` into the parent session via a new `AgentManager.injectTaskResult` (pi follow-up queue when running, fresh turn when idle). Per-session `delegate`/`check_task`/`cancel_task` tools are added through a new `sessionTools` factory option. Spec: `docs/superpowers/specs/2026-06-09-personal-assistant-design.md` (Delegation + phase 2 sections).

**Tech Stack:** Existing stack. No new dependencies.

**Verified API facts (pi v0.79.1, all already used in this codebase):** `AgentHarness.prompt(text) → Promise<AssistantMessage>` (run failures resolve as an assistant message with `stopReason: "error"|"aborted"` and `errorMessage`; pre-run errors reject); `harness.followUp(text)` queues a message processed after the current run's last turn (continues the run); `harness.abort()`; `uuidv7()` is exported by `@earendil-works/pi-agent-core`; `repo.create({cwd})` namespaces session files per cwd (`sessions/--subagent--/...`), and `repo.list({cwd:"chat"})` (used by the sidebar/rebuild) never sees other cwds; the faux provider's `setResponses` accepts factory functions `(context, options, state, model) => AssistantMessage` that can inspect `context.messages`/`context.systemPrompt` to route replies deterministically, and `fauxToolCall(name, args)` builds a toolCall content block.

**Conventions:** Branch `feat/phase2-delegation` (create in Task 1). Node 26 native TS, `.ts` import extensions, `erasableSyntaxOnly` (NO constructor parameter properties). Tests `cd server && npm test` (currently 51 green). Types `npm run check`. Web verification: `cd web && npm run build`. Never push. Commit per task.

**File map:** Create `server/src/tasks.ts` (store + fold + types), `server/src/task-manager.ts`, `server/src/tools/delegation.ts`, `web/src/components/TaskCard.tsx`, `web/src/components/TasksDialog.tsx`. Modify `server/src/{indexer,events,manager,persona,config,server,index}.ts`, `server/test/helpers.ts`, `web/src/{lib/types.ts,lib/api.ts,useApp.ts,App.tsx,components/{Message,Chat,Sidebar}.tsx}`.

---

### Task 1: TaskStore (JSONL SSOT) + Indexer schema v2

**Files:**
- Create: `server/src/tasks.ts`
- Modify: `server/src/indexer.ts`
- Test: `server/test/tasks.test.ts`, `server/test/indexer.test.ts` (extend)

- [ ] **Step 1: Branch**

```bash
cd ~/projects/ytsejam && git switch -c feat/phase2-delegation
```

- [ ] **Step 2: Failing tests for the store**

`server/test/tasks.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { foldTaskEvents, TaskStore, type TaskEvent } from "../src/tasks.ts";

const dir = () => join(mkdtempSync(join(tmpdir(), "tasks-")), "tasks");

const created: TaskEvent = {
  type: "created",
  taskId: "t1",
  parentSessionId: "p1",
  label: "research",
  task: "find things",
  model: "faux/faux",
  timestamp: "2026-06-09T10:00:00Z",
};

describe("foldTaskEvents", () => {
  test("folds the full lifecycle", () => {
    const pending = foldTaskEvents([created])!;
    expect(pending).toMatchObject({
      id: "t1",
      parentSessionId: "p1",
      label: "research",
      status: "pending",
      subagentSessionId: null,
      startedAt: null,
      finishedAt: null,
    });

    const done = foldTaskEvents([
      created,
      { type: "started", taskId: "t1", subagentSessionId: "s1", timestamp: "2026-06-09T10:00:01Z" },
      { type: "completed", taskId: "t1", report: "the answer", timestamp: "2026-06-09T10:00:05Z" },
    ])!;
    expect(done).toMatchObject({
      status: "completed",
      subagentSessionId: "s1",
      startedAt: "2026-06-09T10:00:01Z",
      finishedAt: "2026-06-09T10:00:05Z",
      resultSummary: "the answer",
    });
  });

  test("failed, cancelled, interrupted statuses", () => {
    const failed = foldTaskEvents([
      created,
      { type: "started", taskId: "t1", subagentSessionId: "s1", timestamp: "x" },
      { type: "failed", taskId: "t1", error: "boom", timestamp: "y" },
    ])!;
    expect(failed.status).toBe("failed");
    expect(failed.resultSummary).toBe("boom");

    expect(foldTaskEvents([created, { type: "cancelled", taskId: "t1", timestamp: "y" }])!.status).toBe("cancelled");
    expect(foldTaskEvents([created, { type: "interrupted", taskId: "t1", timestamp: "y" }])!.status).toBe("interrupted");
    expect(foldTaskEvents([])).toBeUndefined();
  });
});

describe("TaskStore", () => {
  test("append/read round-trip and listIds", () => {
    const store = new TaskStore(dir());
    expect(store.read("t1")).toEqual([]);
    expect(store.listIds()).toEqual([]);
    store.append(created);
    store.append({ type: "started", taskId: "t1", subagentSessionId: "s1", timestamp: "x" });
    store.append({ ...created, taskId: "t2" });
    expect(store.read("t1").length).toBe(2);
    expect(store.fold("t1")!.status).toBe("running");
    expect(new Set(store.listIds())).toEqual(new Set(["t1", "t2"]));
  });
});
```

- [ ] **Step 3: Run, verify FAIL** — `cd server && npx vitest --run test/tasks.test.ts`

- [ ] **Step 4: Implement `server/src/tasks.ts`**

```ts
import fs from "node:fs";
import path from "node:path";

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

/** Derived row (sqlite + API + UI). The JSONL events are the SSOT. */
export interface TaskRow {
  id: string;
  parentSessionId: string;
  subagentSessionId: string | null;
  label: string;
  status: TaskStatus;
  model: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  resultSummary: string;
}

export type TaskEvent =
  | {
      type: "created";
      taskId: string;
      parentSessionId: string;
      label: string;
      task: string;
      context?: string;
      model: string;
      timestamp: string;
    }
  | { type: "started"; taskId: string; subagentSessionId: string; timestamp: string }
  | { type: "completed"; taskId: string; report: string; timestamp: string }
  | { type: "failed"; taskId: string; error: string; timestamp: string }
  | { type: "cancelled"; taskId: string; timestamp: string }
  | { type: "interrupted"; taskId: string; timestamp: string };

const SUMMARY_MAX = 500;

export function foldTaskEvents(events: TaskEvent[]): TaskRow | undefined {
  const created = events.find((e) => e.type === "created");
  if (!created || created.type !== "created") return undefined;
  const row: TaskRow = {
    id: created.taskId,
    parentSessionId: created.parentSessionId,
    subagentSessionId: null,
    label: created.label,
    status: "pending",
    model: created.model,
    createdAt: created.timestamp,
    startedAt: null,
    finishedAt: null,
    resultSummary: "",
  };
  for (const e of events) {
    switch (e.type) {
      case "started":
        row.status = "running";
        row.subagentSessionId = e.subagentSessionId;
        row.startedAt = e.timestamp;
        break;
      case "completed":
        row.status = "completed";
        row.finishedAt = e.timestamp;
        row.resultSummary = e.report.slice(0, SUMMARY_MAX);
        break;
      case "failed":
        row.status = "failed";
        row.finishedAt = e.timestamp;
        row.resultSummary = e.error.slice(0, SUMMARY_MAX);
        break;
      case "cancelled":
        row.status = "cancelled";
        row.finishedAt = e.timestamp;
        break;
      case "interrupted":
        row.status = "interrupted";
        row.finishedAt = e.timestamp;
        break;
    }
  }
  return row;
}

/** Append-only task lifecycle events, one JSONL file per task. */
export class TaskStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  append(event: TaskEvent): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(path.join(this.dir, `${event.taskId}.jsonl`), `${JSON.stringify(event)}\n`);
  }

  read(taskId: string): TaskEvent[] {
    try {
      return fs
        .readFileSync(path.join(this.dir, `${taskId}.jsonl`), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TaskEvent);
    } catch {
      return [];
    }
  }

  fold(taskId: string): TaskRow | undefined {
    return foldTaskEvents(this.read(taskId));
  }

  listIds(): string[] {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => f.slice(0, -".jsonl".length));
    } catch {
      return [];
    }
  }
}
```

- [ ] **Step 5: Run store tests → PASS.**

- [ ] **Step 6: Failing Indexer tests**

Append to `server/test/indexer.test.ts` (add `import type { TaskRow } from "../src/tasks.ts";` at the top):

```ts
describe("tasks table", () => {
  const taskRow: TaskRow = {
    id: "t1",
    parentSessionId: "p1",
    subagentSessionId: null,
    label: "research",
    status: "pending",
    model: "faux/faux",
    createdAt: "2026-06-09T10:00:00Z",
    startedAt: null,
    finishedAt: null,
    resultSummary: "",
  };

  test("upsert, get, list ordering", () => {
    const idx = new Indexer(tempDb());
    idx.upsertTask(taskRow);
    idx.upsertTask({ ...taskRow, id: "t2", createdAt: "2026-06-09T11:00:00Z" });
    idx.upsertTask({ ...taskRow, status: "running", subagentSessionId: "s1", startedAt: "x" });
    expect(idx.getTask("t1")).toMatchObject({ status: "running", subagentSessionId: "s1" });
    expect(idx.listTasks().map((t) => t.id)).toEqual(["t2", "t1"]); // newest created first
    expect(idx.getTask("missing")).toBeUndefined();
  });
});
```

- [ ] **Step 7: Run, verify FAIL, then implement in `server/src/indexer.ts`**

Changes:
1. `const SCHEMA_VERSION = 2;`
2. Add `import type { TaskRow, TaskStatus } from "./tasks.ts";` at the top.
3. In `recreateSchema()`, extend the exec SQL — add `DROP TABLE IF EXISTS tasks;` next to the other drops and append after the sessions index:

```sql
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL,
        subagent_session_id TEXT,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        result_summary TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX tasks_parent ON tasks(parent_session_id);
      CREATE INDEX tasks_created ON tasks(created_at DESC);
```

4. Add methods to the `Indexer` class:

```ts
  upsertTask(row: TaskRow): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, parent_session_id, subagent_session_id, label, status, model,
           created_at, started_at, finished_at, result_summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET subagent_session_id=excluded.subagent_session_id,
           status=excluded.status, started_at=excluded.started_at,
           finished_at=excluded.finished_at, result_summary=excluded.result_summary`,
      )
      .run(
        row.id,
        row.parentSessionId,
        row.subagentSessionId,
        row.label,
        row.status,
        row.model,
        row.createdAt,
        row.startedAt,
        row.finishedAt,
        row.resultSummary,
      );
  }

  getTask(id: string): TaskRow | undefined {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as any;
    return r ? this.toTaskRow(r) : undefined;
  }

  listTasks(): TaskRow[] {
    return (this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all() as any[]).map((r) =>
      this.toTaskRow(r),
    );
  }

  private toTaskRow(r: any): TaskRow {
    return {
      id: r.id,
      parentSessionId: r.parent_session_id,
      subagentSessionId: r.subagent_session_id,
      label: r.label,
      status: r.status as TaskStatus,
      model: r.model,
      createdAt: r.created_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      resultSummary: r.result_summary,
    };
  }
```

(The schema bump means existing `index.db` files self-reset on next boot — `wasReset` — and get rebuilt from JSONL; that's the designed migration path.)

- [ ] **Step 8: Full suite + check**

Run: `npm test && npm run check` — all pass (51 existing + 3 tasks + 1 indexer = 55).

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat: task event store and tasks index table (schema v2)"
```

---

### Task 2: AgentManager — `injectTaskResult` and per-session tools

**Files:**
- Modify: `server/src/manager.ts`
- Test: `server/test/manager.test.ts` (extend)

- [ ] **Step 1: Failing tests**

Append to `server/test/manager.test.ts`. Two of these construct managers with extra options, so add a small local helper that mirrors `makeManager` but accepts option overrides (import `AgentManager` and the deps directly — the file already imports them for the reopen test; also import `fauxToolCall` from `@earendil-works/pi-ai` via helpers re-export added below):

First, in `server/test/helpers.ts`, widen `makeManager` to accept overrides and re-export `fauxToolCall`:

```ts
// change the signature:
export function makeManager(
  faux: ReturnType<typeof registerFauxProvider>,
  overrides: Partial<import("../src/manager.ts").AgentManagerOptions> = {},
) {
  // ...existing body unchanged, except the constructor call ends with:
  //   authStore: new PiAuthStore(join(dataDir, "no-auth.json")),
  //   ...overrides,
  // });
}

// add to the bottom re-exports:
export { fauxToolCall } from "@earendil-works/pi-ai";
```

Then the new tests:

```ts
describe("injectTaskResult", () => {
  test("starts a turn when the session is idle", async () => {
    const { manager } = makeManager(faux);
    faux.setResponses([fauxAssistantMessage("noted the result")]);
    const row = await manager.createSession();
    await manager.injectTaskResult(row.id, '[Task "x" completed] all done');
    await manager.waitForIdle(row.id);
    const messages = await manager.getMessages(row.id);
    const userTexts = messages.filter((m: any) => m.role === "user").map((m: any) => m.content[0].text);
    expect(userTexts).toEqual(['[Task "x" completed] all done']);
    expect(messages.some((m: any) => m.role === "assistant")).toBe(true);
  });

  test("queues as follow-up when the session is running", async () => {
    const { manager } = makeManager(faux);
    faux.setResponses([
      async () => {
        await new Promise((r) => setTimeout(r, 300));
        return fauxAssistantMessage("first reply");
      },
      fauxAssistantMessage("handled the task result"),
    ]);
    const row = await manager.createSession();
    await manager.sendMessage(row.id, "hello");
    await manager.injectTaskResult(row.id, '[Task "y" completed] result'); // mid-run
    await manager.waitForIdle(row.id);
    const messages = await manager.getMessages(row.id);
    const texts = messages.map((m: any) =>
      Array.isArray(m.content) ? m.content.map((c: any) => c.text ?? "").join("") : m.content,
    );
    // follow-up processed after the first turn: hello, first reply, [Task...], handled...
    expect(texts.filter((t) => t.includes("[Task"))).toHaveLength(1);
    expect(messages.filter((m: any) => m.role === "assistant")).toHaveLength(2);
  });
});

describe("sessionTools", () => {
  test("per-session tools are available to the harness and receive the session id", async () => {
    const seen: string[] = [];
    const probeTool = (sessionId: string) => ({
      name: "probe",
      label: "Probe",
      description: "test tool",
      parameters: { type: "object", properties: {} } as any,
      execute: async () => {
        seen.push(sessionId);
        return { content: [{ type: "text" as const, text: "probed" }], details: {} };
      },
    });
    const { manager } = makeManager(faux, { sessionTools: (id) => [probeTool(id) as any] });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("probe", {})]),
      fauxAssistantMessage("done"),
    ]);
    const row = await manager.createSession();
    await manager.sendMessage(row.id, "use the probe");
    await manager.waitForIdle(row.id);
    expect(seen).toEqual([row.id]);
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest --run test/manager.test.ts` (injectTaskResult/sessionTools missing).

- [ ] **Step 3: Implement in `server/src/manager.ts`**

1. `AgentManagerOptions` gains:

```ts
  /** extra tools built per session (e.g. delegation tools that need the session id) */
  sessionTools?: (sessionId: string) => AgentTool<any>[];
```

2. In `wire()`, change the harness `tools` line to:

```ts
      tools: [...this.opts.tools, ...(this.opts.sessionTools?.(metadata.id) ?? [])],
```

3. Add next to `sendMessage` (same fire-and-forget pattern, but follow-up instead of steer — task results should be processed after the current turn completes, not injected into the middle of it):

```ts
  /**
   * Inject a background-task result. The assistant always takes a turn on it:
   * queued as a follow-up when a run is active (processed when the run would
   * otherwise stop), or started as a fresh turn when idle.
   */
  async injectTaskResult(id: string, text: string): Promise<void> {
    const opened = await this.getOrOpen(id);
    if (opened.running) {
      await opened.harness.followUp(text);
      return;
    }
    opened.running = true;
    opened.harness.prompt(text).catch((err) => {
      console.error(`task result injection failed for session ${id}`, err);
      opened.running = false;
    });
  }
```

- [ ] **Step 4: Run → PASS; full `npm test && npm run check`** (55 + 3 = 58 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: task result injection and per-session tools in AgentManager"
```

---

### Task 3: TaskManager

**Files:**
- Create: `server/src/task-manager.ts`
- Modify: `server/src/persona.ts` (worker prompt), `server/src/events.ts` (task event)
- Test: `server/test/task-manager.test.ts`

- [ ] **Step 1: Worker prompt + bus event (small, no own tests — covered by TaskManager tests)**

Append to `server/src/persona.ts`:

```ts
/** System prompt for background worker subagents. */
export function composeWorkerPrompt(persona: string, opts: { dataDir: string; now?: Date }): string {
  const now = opts.now ?? new Date();
  const personaIntro = persona.trim().split("\n\n")[0] ?? "";
  return `You are a background worker subagent acting on behalf of the user's personal assistant.

The assistant you work for is described as:
${personaIntro}

## Your job

- Complete the assigned task autonomously. Do not ask questions; make reasonable assumptions and note them.
- Your FINAL message is returned verbatim to the assistant as your report. Make it a complete, self-contained summary of findings, results, and anything worth relaying to the user.

## Environment

- Current date: ${now.toISOString().slice(0, 10)}
- You run on the user's private server. Files you create live under ${opts.dataDir} unless an absolute path is given.

## Tool guidance

- Use web_search to find current information and web_fetch to read pages; cite source URLs.
- bash, read, write, edit, ls, grep, and find operate directly on the server. Be careful with destructive commands.`;
}
```

In `server/src/events.ts`, add the import and a `ServerEvent` variant:

```ts
import type { TaskRow } from "./tasks.ts";
```

```ts
  | { type: "task"; task: TaskRow }
```

(The WS handler in server.ts forwards every non-`agent` event to all clients already — no change needed there.)

- [ ] **Step 2: Failing TaskManager tests**

`server/test/task-manager.test.ts`:

```ts
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { EventBus, type ServerEvent } from "../src/events.ts";
import { Indexer } from "../src/indexer.ts";
import { PersonaStore } from "../src/persona.ts";
import { PiAuthStore } from "../src/pi-auth.ts";
import { TaskStore } from "../src/tasks.ts";
import { TaskManager } from "../src/task-manager.ts";
import { fauxAssistantMessage, setupFaux } from "./helpers.ts";

let faux: ReturnType<typeof setupFaux>;
beforeEach(() => {
  faux = setupFaux();
});
afterEach(() => faux.unregister());

interface MadeTm {
  tm: TaskManager;
  store: TaskStore;
  indexer: Indexer;
  bus: EventBus;
  dataDir: string;
  notified: Array<{ sessionId: string; text: string }>;
}

function makeTaskManager(opts: { concurrency?: number; timeoutMs?: number } = {}): MadeTm {
  const dataDir = mkdtempSync(join(tmpdir(), "tm-"));
  const store = new TaskStore(join(dataDir, "tasks"));
  const indexer = new Indexer(join(dataDir, "index.db"));
  const bus = new EventBus();
  const notified: Array<{ sessionId: string; text: string }> = [];
  const tm = new TaskManager({
    dataDir,
    store,
    indexer,
    bus,
    persona: new PersonaStore(join(dataDir, "persona")),
    authStore: new PiAuthStore(join(dataDir, "no-auth.json")),
    resolveModel: () => faux.getModel() as any,
    subagentModel: "faux/faux",
    workerTools: [],
    concurrency: opts.concurrency ?? 2,
    timeoutMs: opts.timeoutMs ?? 10_000,
    notifyParent: async (sessionId, text) => {
      notified.push({ sessionId, text });
    },
  });
  return { tm, store, indexer, bus, dataDir, notified };
}

async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("TaskManager", () => {
  test("delegate runs a subagent to completion and notifies the parent", async () => {
    const { tm, indexer, bus, dataDir, notified } = makeTaskManager();
    const events: ServerEvent[] = [];
    bus.subscribe((e) => events.push(e));
    faux.setResponses([fauxAssistantMessage("REPORT: the answer is 42")]);

    const row = await tm.delegate({ parentSessionId: "parent-1", task: "compute", label: "compute" });
    expect(row.status).toBe("pending");

    await waitFor(() => indexer.getTask(row.id)?.status === "completed");
    const final = indexer.getTask(row.id)!;
    expect(final.resultSummary).toContain("42");
    expect(final.subagentSessionId).toBeTruthy();

    // parent notified with the report
    expect(notified).toHaveLength(1);
    expect(notified[0]!.sessionId).toBe("parent-1");
    expect(notified[0]!.text).toContain('[Task "compute" completed]');
    expect(notified[0]!.text).toContain("42");

    // task status events flowed over the bus
    const statuses = events.filter((e) => e.type === "task").map((e: any) => e.task.status);
    expect(statuses).toContain("running");
    expect(statuses).toContain("completed");

    // subagent session JSONL exists under the subagent cwd (never the chat cwd)
    const subDirs = readdirSync(join(dataDir, "sessions"));
    expect(subDirs).toContain("--subagent--");
    expect(subDirs).not.toContain("--chat--");

    // transcript is readable
    const messages = await tm.getTranscript(row.id);
    expect(messages.some((m: any) => m.role === "assistant")).toBe(true);
  });

  test("concurrency cap queues excess tasks", async () => {
    const { tm, indexer } = makeTaskManager({ concurrency: 1 });
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    faux.setResponses([
      async () => {
        await gate;
        return fauxAssistantMessage("first done");
      },
      fauxAssistantMessage("second done"),
    ]);

    const a = await tm.delegate({ parentSessionId: "p", task: "a", label: "a" });
    const b = await tm.delegate({ parentSessionId: "p", task: "b", label: "b" });

    await waitFor(() => indexer.getTask(a.id)?.status === "running");
    expect(indexer.getTask(b.id)?.status).toBe("pending"); // capped

    releaseFirst();
    await waitFor(() => indexer.getTask(b.id)?.status === "completed");
    expect(indexer.getTask(a.id)?.status).toBe("completed");
  });

  test("timeout aborts the subagent and fails the task", async () => {
    const { tm, indexer, notified } = makeTaskManager({ timeoutMs: 150 });
    faux.setResponses([
      async () => {
        // must outlast timeoutMs but resolve well within waitFor's window:
        // if abort() doesn't interrupt the faux factory, prompt() only settles
        // when this resolves, and the failed event is recorded after that
        await new Promise((r) => setTimeout(r, 2_000));
        return fauxAssistantMessage("too late");
      },
    ]);
    const row = await tm.delegate({ parentSessionId: "p", task: "slow", label: "slow" });
    await waitFor(() => indexer.getTask(row.id)?.status === "failed", 8_000);
    expect(indexer.getTask(row.id)!.resultSummary).toContain("timed out");
    await waitFor(() => notified.length === 1);
    expect(notified[0]!.text).toContain('[Task "slow" failed]');
  });

  test("cancel works for pending and running tasks without notifying the parent", async () => {
    const { tm, indexer, notified } = makeTaskManager({ concurrency: 1 });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    faux.setResponses([
      async () => {
        await gate;
        return fauxAssistantMessage("never used");
      },
    ]);
    const running = await tm.delegate({ parentSessionId: "p", task: "a", label: "a" });
    const pending = await tm.delegate({ parentSessionId: "p", task: "b", label: "b" });
    await waitFor(() => indexer.getTask(running.id)?.status === "running");

    expect(await tm.cancel(pending.id)).toBe(true);
    expect(indexer.getTask(pending.id)?.status).toBe("cancelled");

    expect(await tm.cancel(running.id)).toBe(true);
    release();
    await waitFor(() => indexer.getTask(running.id)?.status === "cancelled");
    await new Promise((r) => setTimeout(r, 200)); // give any stray notify a chance to fire
    expect(notified).toEqual([]);
    expect(await tm.cancel(running.id)).toBe(false); // already terminal
  });

  test("recoverInterrupted marks stale running tasks and notifies parents", async () => {
    const { tm, store, indexer, notified } = makeTaskManager();
    // simulate a crash: events from a previous process, no live runner
    store.append({
      type: "created",
      taskId: "stale-1",
      parentSessionId: "p9",
      label: "stale",
      task: "x",
      model: "faux/faux",
      timestamp: new Date().toISOString(),
    });
    store.append({
      type: "started",
      taskId: "stale-1",
      subagentSessionId: "s9",
      timestamp: new Date().toISOString(),
    });
    await tm.recoverInterrupted();
    expect(indexer.getTask("stale-1")?.status).toBe("interrupted");
    expect(notified).toHaveLength(1);
    expect(notified[0]!).toMatchObject({ sessionId: "p9" });
    expect(notified[0]!.text).toContain("interrupted");
  });

  test("rebuildIndex repopulates the tasks table from JSONL", async () => {
    const { tm, store, indexer } = makeTaskManager();
    store.append({
      type: "created",
      taskId: "r1",
      parentSessionId: "p",
      label: "done already",
      task: "x",
      model: "faux/faux",
      timestamp: "2026-06-09T10:00:00Z",
    });
    store.append({ type: "completed", taskId: "r1", report: "fin", timestamp: "2026-06-09T10:01:00Z" });
    indexer.reset();
    await tm.rebuildIndex();
    expect(indexer.getTask("r1")).toMatchObject({ status: "completed", resultSummary: "fin" });
  });
});
```

- [ ] **Step 3: Run, verify FAIL** (module missing).

- [ ] **Step 4: Implement `server/src/task-manager.ts`**

```ts
import path from "node:path";
import {
  AgentHarness,
  JsonlSessionRepo,
  uuidv7,
  type AgentMessage,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Model } from "@earendil-works/pi-ai";
import type { EventBus } from "./events.ts";
import type { Indexer } from "./indexer.ts";
import type { ModelResolver } from "./models.ts";
import { resolveApiKey } from "./pi-auth.ts";
import type { PiAuthStore } from "./pi-auth.ts";
import { composeWorkerPrompt } from "./persona.ts";
import type { PersonaStore } from "./persona.ts";
import { type TaskRow, type TaskStore } from "./tasks.ts";

const SUBAGENT_CWD = "subagent";
const REPORT_MAX = 16_000;

/** Full text of an assistant message (all text blocks), capped for injection. */
function fullTextOf(message: AgentMessage, cap = REPORT_MAX): string {
  const content = (message as any).content;
  if (typeof content === "string") return content.slice(0, cap);
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c.type === "text")
    .map((c: any) => String(c.text ?? ""))
    .join("\n")
    .slice(0, cap);
}

export interface DelegateInput {
  parentSessionId: string;
  task: string;
  label: string;
  context?: string;
  model?: string;
}

export interface TaskManagerOptions {
  dataDir: string;
  store: TaskStore;
  indexer: Indexer;
  bus: EventBus;
  persona: PersonaStore;
  authStore: PiAuthStore;
  resolveModel: ModelResolver;
  /** default "provider/modelId" for subagents */
  subagentModel: string;
  workerTools: AgentTool<any>[];
  concurrency: number;
  timeoutMs: number;
  /** inject a completion/failure message into the parent session */
  notifyParent: (parentSessionId: string, text: string) => Promise<void>;
}

/**
 * Runs delegated tasks as in-process subagents with their own JSONL sessions
 * (repo cwd "subagent", invisible to the chat sidebar). Task lifecycle events
 * in TaskStore are the SSOT; the sqlite tasks table and bus events are derived.
 */
export class TaskManager {
  private readonly opts: TaskManagerOptions;
  private readonly env: NodeExecutionEnv;
  private readonly repo: JsonlSessionRepo;
  private readonly queue: string[] = [];
  private readonly active = new Map<string, AgentHarness>();
  private runningCount = 0;

  constructor(opts: TaskManagerOptions) {
    this.opts = opts;
    this.env = new NodeExecutionEnv({ cwd: opts.dataDir });
    this.repo = new JsonlSessionRepo({
      fs: this.env,
      sessionsRoot: path.join(opts.dataDir, "sessions"),
    });
  }

  // ---- public API ----------------------------------------------------------

  async delegate(input: DelegateInput): Promise<TaskRow> {
    const modelRef = input.model ?? this.opts.subagentModel;
    this.opts.resolveModel(modelRef); // validate early: bad refs fail the tool call, not the run
    const taskId = uuidv7();
    const row = this.record({
      type: "created",
      taskId,
      parentSessionId: input.parentSessionId,
      label: input.label,
      task: input.task,
      context: input.context,
      model: modelRef,
      timestamp: new Date().toISOString(),
    });
    this.queue.push(taskId);
    this.pump();
    return row;
  }

  get(taskId: string): TaskRow | undefined {
    return this.opts.indexer.getTask(taskId);
  }

  /** Cancel a pending or running task. Returns false when unknown or already terminal. */
  async cancel(taskId: string): Promise<boolean> {
    const row = this.opts.store.fold(taskId);
    if (!row || (row.status !== "pending" && row.status !== "running")) return false;
    const queued = this.queue.indexOf(taskId);
    if (queued >= 0) this.queue.splice(queued, 1);
    // record cancellation BEFORE aborting so run() sees it and skips fail/notify
    this.record({ type: "cancelled", taskId, timestamp: new Date().toISOString() });
    const harness = this.active.get(taskId);
    if (harness) await harness.abort();
    return true;
  }

  async getTranscript(taskId: string): Promise<AgentMessage[]> {
    const row = this.opts.store.fold(taskId);
    if (!row?.subagentSessionId) return [];
    const metadata = (await this.repo.list({ cwd: SUBAGENT_CWD })).find(
      (m) => m.id === row.subagentSessionId,
    );
    if (!metadata) return [];
    const session = await this.repo.open(metadata);
    return (await session.buildContext()).messages;
  }

  /** Boot: tasks left pending/running by a previous process become interrupted. */
  async recoverInterrupted(): Promise<void> {
    for (const taskId of this.opts.store.listIds()) {
      const row = this.opts.store.fold(taskId);
      if (!row || (row.status !== "pending" && row.status !== "running")) continue;
      this.record({ type: "interrupted", taskId, timestamp: new Date().toISOString() });
      try {
        await this.opts.notifyParent(
          row.parentSessionId,
          `[Task "${row.label}" interrupted] The server restarted while this task was running. Re-delegate it if it is still needed.`,
        );
      } catch (err) {
        console.error(`failed to notify parent about interrupted task ${taskId}`, err);
      }
    }
  }

  /** Repopulate the (derived) tasks table from the JSONL event files. */
  async rebuildIndex(): Promise<void> {
    for (const taskId of this.opts.store.listIds()) {
      const row = this.opts.store.fold(taskId);
      if (row) this.opts.indexer.upsertTask(row);
    }
  }

  // ---- internals -----------------------------------------------------------

  /** Append an event, refresh the derived row, broadcast it. */
  private record(event: Parameters<TaskStore["append"]>[0]): TaskRow {
    this.opts.store.append(event);
    const row = this.opts.store.fold(event.taskId)!;
    this.opts.indexer.upsertTask(row);
    this.opts.bus.emit({ type: "task", task: row });
    return row;
  }

  private pump(): void {
    while (this.runningCount < this.opts.concurrency && this.queue.length > 0) {
      const taskId = this.queue.shift()!;
      this.runningCount++;
      void this.run(taskId).finally(() => {
        this.runningCount--;
        this.pump();
      });
    }
  }

  private async run(taskId: string): Promise<void> {
    const events = this.opts.store.read(taskId);
    const created = events.find((e) => e.type === "created");
    const row = this.opts.store.fold(taskId);
    if (!created || created.type !== "created" || row?.status !== "pending") return; // cancelled while queued

    let outcome: { type: "completed"; report: string } | { type: "failed"; error: string };
    try {
      const model = this.opts.resolveModel(created.model);
      const session = await this.repo.create({ cwd: SUBAGENT_CWD });
      const metadata = await session.getMetadata();
      await session.appendModelChange(model.provider, model.id);
      this.record({
        type: "started",
        taskId,
        subagentSessionId: metadata.id,
        timestamp: new Date().toISOString(),
      });

      const harness = new AgentHarness({
        env: this.env,
        session,
        model,
        tools: this.opts.workerTools,
        systemPrompt: async () =>
          composeWorkerPrompt(await this.opts.persona.load(), { dataDir: this.opts.dataDir }),
        getApiKeyAndHeaders: async (m: Model<any>) => {
          const apiKey = await resolveApiKey(m.provider, this.opts.authStore);
          return apiKey ? { apiKey } : undefined;
        },
      });
      this.active.set(taskId, harness);

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void harness.abort();
      }, this.opts.timeoutMs);

      let result: AgentMessage;
      try {
        const prompt = created.context ? `${created.task}\n\nContext:\n${created.context}` : created.task;
        result = await harness.prompt(prompt);
      } finally {
        clearTimeout(timer);
        this.active.delete(taskId);
      }

      const stopReason = (result as any).stopReason;
      const errorMessage = (result as any).errorMessage;
      if (timedOut) {
        outcome = {
          type: "failed",
          error: `timed out after ${Math.round(this.opts.timeoutMs / 1000)}s`,
        };
      } else if (stopReason === "aborted") {
        outcome = { type: "failed", error: "aborted" };
      } else if (errorMessage) {
        outcome = { type: "failed", error: String(errorMessage) };
      } else {
        outcome = { type: "completed", report: fullTextOf(result) || "(empty report)" };
      }
    } catch (err) {
      this.active.delete(taskId);
      outcome = { type: "failed", error: err instanceof Error ? err.message : String(err) };
    }

    // a cancel may have been recorded while we were running — it wins, no notify
    if (this.opts.store.fold(taskId)?.status === "cancelled") return;

    if (outcome.type === "completed") {
      this.record({ type: "completed", taskId, report: outcome.report, timestamp: new Date().toISOString() });
    } else {
      this.record({ type: "failed", taskId, error: outcome.error, timestamp: new Date().toISOString() });
    }

    const text =
      outcome.type === "completed"
        ? `[Task "${created.label}" completed]\n\n${outcome.report}`
        : `[Task "${created.label}" failed] ${outcome.error}`;
    try {
      await this.opts.notifyParent(created.parentSessionId, text);
    } catch (err) {
      console.error(`failed to notify parent for task ${taskId}`, err);
    }
  }
}
```

- [ ] **Step 5: Run → PASS; full suite + check** (58 + 6 = 64 tests).

If the cancel-running test is flaky because `harness.abort()` resolves before the faux factory's gate releases: the run ends with `stopReason: "aborted"` once released, `run()` then sees status `cancelled` and returns without notifying — the assertions already allow this ordering (they wait for `cancelled` and then assert no notifications). Debug with the actual event files under the temp dir if anything else surfaces.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: TaskManager running subagents with cap, timeout, cancel, recovery"
```

---

### Task 4: Delegation tools, config, boot wiring, and the full-loop integration test

**Files:**
- Create: `server/src/tools/delegation.ts`
- Modify: `server/src/config.ts`, `server/src/persona.ts` (chat prompt guidance), `server/src/index.ts`
- Test: `server/test/config.test.ts` (extend), `server/test/delegation.test.ts` (integration)

- [ ] **Step 1: Failing config test**

Add to `server/test/config.test.ts`:

```ts
  test("delegation settings default and override", () => {
    const def = loadConfig({ YTSEJAM_AUTH_TOKEN: "x" });
    expect(def.subagentModel).toBe(def.defaultModel);
    expect(def.taskConcurrency).toBe(4);
    expect(def.taskTimeoutMinutes).toBe(15);
    const over = loadConfig({
      YTSEJAM_AUTH_TOKEN: "x",
      YTSEJAM_SUBAGENT_MODEL: "faux/faux",
      YTSEJAM_TASK_CONCURRENCY: "2",
      YTSEJAM_TASK_TIMEOUT_MIN: "5",
    });
    expect(over.subagentModel).toBe("faux/faux");
    expect(over.taskConcurrency).toBe(2);
    expect(over.taskTimeoutMinutes).toBe(5);
  });
```

Run → FAIL. Then in `server/src/config.ts` add to `Config`:

```ts
  /** default "provider/modelId" for delegated subagents */
  subagentModel: string;
  /** max concurrently running subagent tasks */
  taskConcurrency: number;
  /** per-task timeout in minutes */
  taskTimeoutMinutes: number;
```

and in `loadConfig`'s return (note: `defaultModel` must be computed before use — extract it to a const above the return):

```ts
  const defaultModel = env.YTSEJAM_DEFAULT_MODEL ?? "anthropic/claude-sonnet-4-6";
```

```ts
    defaultModel,
    subagentModel: env.YTSEJAM_SUBAGENT_MODEL ?? defaultModel,
    taskConcurrency: Number(env.YTSEJAM_TASK_CONCURRENCY ?? 4),
    taskTimeoutMinutes: Number(env.YTSEJAM_TASK_TIMEOUT_MIN ?? 15),
```

Run → PASS.

- [ ] **Step 2: Delegation tools**

`server/src/tools/delegation.ts`:

```ts
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TaskManager } from "../task-manager.ts";

const delegateParams = Type.Object({
  task: Type.String({
    description:
      "Complete, self-contained instructions for the subagent. It cannot see this conversation — include everything it needs.",
  }),
  label: Type.String({ description: "Short human-readable label (3-6 words) shown in the UI" }),
  context: Type.Optional(Type.String({ description: "Extra background the subagent may need" })),
  model: Type.Optional(Type.String({ description: 'Override model as "provider/modelId" (optional)' })),
});

const taskIdParams = Type.Object({ taskId: Type.String() });

function elapsed(row: { startedAt: string | null }): string {
  if (!row.startedAt) return "not started";
  return `${Math.round((Date.now() - new Date(row.startedAt).getTime()) / 1000)}s`;
}

/**
 * Tools bound to one chat session (the parent). getTaskManager is late-bound
 * because the TaskManager is constructed after the AgentManager at boot.
 */
export function createDelegationTools(
  getTaskManager: () => TaskManager,
  sessionId: string,
): AgentTool<any>[] {
  const delegate: AgentTool<typeof delegateParams> = {
    name: "delegate",
    label: "Delegate to subagent",
    description:
      "Start a background subagent to work on a task asynchronously. Returns immediately with a task id; you will receive a message in this conversation when the task completes or fails. Use it for research or multi-step work that would block the conversation; do NOT use it for trivial single-step actions. Subagents cannot delegate further.",
    parameters: delegateParams,
    execute: async (_id, params) => {
      const row = await getTaskManager().delegate({
        parentSessionId: sessionId,
        task: params.task,
        label: params.label,
        context: params.context,
        model: params.model,
      });
      return {
        content: [
          {
            type: "text",
            text: `Delegated task ${row.id} ("${row.label}"). It runs in the background — continue helping the user; you'll get a [Task ...] message here when it finishes.`,
          },
        ],
        details: { taskId: row.id, label: row.label },
      };
    },
  };

  const checkTask: AgentTool<typeof taskIdParams> = {
    name: "check_task",
    label: "Check task status",
    description: "Check the status of a delegated background task by id.",
    parameters: taskIdParams,
    execute: async (_id, params) => {
      const row = getTaskManager().get(params.taskId);
      if (!row) throw new Error(`Unknown task: ${params.taskId}`);
      const summary = row.resultSummary ? `\nresult: ${row.resultSummary}` : "";
      return {
        content: [
          {
            type: "text",
            text: `Task ${row.id} ("${row.label}"): ${row.status} (elapsed: ${elapsed(row)})${summary}`,
          },
        ],
        details: { taskId: row.id, status: row.status },
      };
    },
  };

  const cancelTask: AgentTool<typeof taskIdParams> = {
    name: "cancel_task",
    label: "Cancel task",
    description: "Cancel a pending or running delegated task by id.",
    parameters: taskIdParams,
    execute: async (_id, params) => {
      const ok = await getTaskManager().cancel(params.taskId);
      return {
        content: [
          { type: "text", text: ok ? `Cancelled task ${params.taskId}.` : `Task ${params.taskId} is not cancellable (unknown or already finished).` },
        ],
        details: { cancelled: ok },
      };
    },
  };

  return [delegate, checkTask, cancelTask];
}
```

Also add delegation guidance to the CHAT system prompt — in `server/src/persona.ts`, `composeSystemPrompt`'s Tool guidance section, add this line after the bash line:

```
- Use the delegate tool to run long research or multi-step work in a background subagent: you keep chatting while it runs and get a [Task ...] message on completion. Tell the user what you delegated. Don't delegate trivial one-step work.
```

- [ ] **Step 3: Boot wiring**

In `server/src/index.ts` (current content shown in repo): add imports

```ts
import { TaskManager } from "./task-manager.ts";
import { TaskStore } from "./tasks.ts";
import { createDelegationTools } from "./tools/delegation.ts";
```

Replace the manager construction + rebuild block with:

```ts
// taskManager is created after manager (it injects into it); the delegation
// tools late-bind through the closure, which only runs when a session opens
let taskManager!: TaskManager;
const manager = new AgentManager({
  dataDir: config.dataDir,
  indexer,
  bus,
  persona,
  resolveModel: (ref) => resolveModel(ref, authStore),
  defaultModel: config.defaultModel,
  tools: createTools(config.dataDir),
  sessionTools: (sessionId) => createDelegationTools(() => taskManager, sessionId),
  generateTitles: config.generateTitles,
  authStore,
});

taskManager = new TaskManager({
  dataDir: config.dataDir,
  store: new TaskStore(path.join(config.dataDir, "tasks")),
  indexer,
  bus,
  persona,
  authStore,
  resolveModel: (ref) => resolveModel(ref, authStore),
  subagentModel: config.subagentModel,
  workerTools: createTools(config.dataDir), // web + system tools; no delegation (no recursion)
  concurrency: config.taskConcurrency,
  timeoutMs: config.taskTimeoutMinutes * 60_000,
  notifyParent: (sessionId, text) => manager.injectTaskResult(sessionId, text),
});

// sqlite is derived: rebuild from JSONL on boot so offline JSONL edits are reflected
await manager.rebuildIndex();
await taskManager.rebuildIndex();
await taskManager.recoverInterrupted();
```

(`createApp` gains `taskManager` in Task 5 — for now leave the createApp call unchanged; it compiles because AppDeps doesn't require it yet.)

- [ ] **Step 4: Full-loop integration test**

`server/test/delegation.test.ts` — the crown jewel: a chat turn delegates, the subagent runs, the parent is notified and takes a turn, all with the faux provider. The faux response queue is consumed across BOTH agents concurrently, so fixed-order responses are nondeterministic — use a single routing factory pushed several times that inspects the context:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { EventBus } from "../src/events.ts";
import { Indexer } from "../src/indexer.ts";
import { AgentManager } from "../src/manager.ts";
import { PersonaStore } from "../src/persona.ts";
import { PiAuthStore } from "../src/pi-auth.ts";
import { TaskManager } from "../src/task-manager.ts";
import { TaskStore } from "../src/tasks.ts";
import { createDelegationTools } from "../src/tools/delegation.ts";

let faux: ReturnType<typeof registerFauxProvider>;
beforeEach(() => {
  faux = registerFauxProvider();
});
afterEach(() => faux.unregister());

/** Route faux replies by inspecting the request context — deterministic under concurrency. */
function routingResponse() {
  return (context: any) => {
    const system = String(context.systemPrompt ?? "");
    const messages = context.messages ?? [];
    const last = messages[messages.length - 1];
    const lastText = Array.isArray(last?.content)
      ? last.content.map((c: any) => c.text ?? "").join("")
      : String(last?.content ?? "");

    if (system.includes("background worker subagent")) {
      return fauxAssistantMessage("SUBAGENT REPORT: the answer is 42");
    }
    if (last?.role === "toolResult") {
      return fauxAssistantMessage("Delegated. I'll let you know when it's done.");
    }
    if (lastText.includes('[Task "find answer" completed]')) {
      return fauxAssistantMessage("Your task finished: the answer is 42.");
    }
    return fauxAssistantMessage([
      fauxToolCall("delegate", { task: "compute the answer", label: "find answer" }),
    ]);
  };
}

test("full delegation loop: chat turn → subagent → parent notified and replies", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "deleg-"));
  const indexer = new Indexer(join(dataDir, "index.db"));
  const bus = new EventBus();
  const persona = new PersonaStore(join(dataDir, "persona"));
  const authStore = new PiAuthStore(join(dataDir, "no-auth.json"));
  const fauxModel = faux.getModel() as any;

  let taskManager!: TaskManager;
  const manager = new AgentManager({
    dataDir,
    indexer,
    bus,
    persona,
    resolveModel: () => fauxModel,
    defaultModel: "faux/faux",
    tools: [],
    sessionTools: (sessionId) => createDelegationTools(() => taskManager, sessionId),
    generateTitles: false,
    authStore,
  });
  taskManager = new TaskManager({
    dataDir,
    store: new TaskStore(join(dataDir, "tasks")),
    indexer,
    bus,
    persona,
    authStore,
    resolveModel: () => fauxModel,
    subagentModel: "faux/faux",
    workerTools: [],
    concurrency: 2,
    timeoutMs: 10_000,
    notifyParent: (sessionId, text) => manager.injectTaskResult(sessionId, text),
  });

  // enough routed responses for: parent toolCall turn, parent post-tool turn,
  // subagent turn, parent notification turn (+ slack for retries)
  faux.setResponses(Array.from({ length: 8 }, () => routingResponse()));

  const row = await manager.createSession();
  await manager.sendMessage(row.id, "please find the answer in the background");

  // wait until the task completes and the parent's final reply lands
  const deadline = Date.now() + 10_000;
  let done = false;
  while (!done && Date.now() < deadline) {
    const tasks = indexer.listTasks();
    const messages = await manager.getMessages(row.id).catch(() => []);
    done =
      tasks.length === 1 &&
      tasks[0]!.status === "completed" &&
      (messages as any[]).some(
        (m) => m.role === "assistant" && JSON.stringify(m.content).includes("task finished"),
      );
    if (!done) await new Promise((r) => setTimeout(r, 50));
  }
  expect(done).toBe(true);

  const task = indexer.listTasks()[0]!;
  expect(task.parentSessionId).toBe(row.id);
  expect(task.resultSummary).toContain("42");

  // parent transcript contains: user msg, toolCall turn, [Task completed] injection, final reply
  const messages = (await manager.getMessages(row.id)) as any[];
  const userTexts = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content.map((c: any) => c.text ?? "").join(""));
  expect(userTexts.some((t) => t.includes('[Task "find answer" completed]'))).toBe(true);
}, 20_000);
```

- [ ] **Step 5: Run everything**

`npm test && npm run check` — expect 64 + 1 config + 1 integration = 66. The integration test is timing-sensitive; if it flakes, increase the routed-response count (each faux call consumes one) and check `waitForIdle` interactions before touching production code.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: delegate/check/cancel tools wired end to end"
```

---

### Task 5: REST endpoints for tasks

**Files:**
- Modify: `server/src/server.ts`, `server/test/helpers.ts`
- Test: `server/test/api.test.ts` (extend)

- [ ] **Step 1: Extend helpers**

`server/test/helpers.ts` — build a TaskManager alongside the manager so API tests can exercise tasks. Add top-level imports `import { TaskStore } from "../src/tasks.ts";` and `import { TaskManager } from "../src/task-manager.ts";`, then inside `makeManager`, after the `manager` construction:

```ts
  const taskManager = new TaskManager({
    dataDir,
    store: new TaskStore(join(dataDir, "tasks")),
    indexer,
    bus,
    persona: new PersonaStore(join(dataDir, "persona")),
    authStore: new PiAuthStore(join(dataDir, "no-auth.json")),
    resolveModel: () => fauxModel,
    subagentModel: "faux/faux",
    workerTools: [],
    concurrency: 2,
    timeoutMs: 10_000,
    notifyParent: (sessionId, text) => manager.injectTaskResult(sessionId, text),
  });
  return { manager, taskManager, indexer, bus, dataDir };
```

(The existing `PersonaStore` import is already there. Note `makeManager` keeps its `overrides` parameter from Task 2.)

- [ ] **Step 2: Failing API tests**

In `server/test/api.test.ts`: the `deps` construction now needs `taskManager: made.taskManager` (AppDeps gains it). Add a new describe:

```ts
describe("tasks api", () => {
  test("list, transcript, cancel", async () => {
    faux.setResponses([fauxAssistantMessage("task report"), fauxAssistantMessage("ack")]);
    const row = await deps.manager.createSession();
    const task = await deps.taskManager.delegate({
      parentSessionId: row.id,
      task: "do it",
      label: "do it",
    });

    // wait for completion
    for (let i = 0; i < 200 && deps.indexer.getTask(task.id)?.status !== "completed"; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(deps.indexer.getTask(task.id)?.status).toBe("completed");

    const list = (await (await app.request("/api/tasks", { headers: auth })).json()) as any;
    expect(list.tasks).toHaveLength(1);
    expect(list.tasks[0]).toMatchObject({ id: task.id, status: "completed" });

    const transcript = (await (
      await app.request(`/api/tasks/${task.id}/transcript`, { headers: auth })
    ).json()) as any;
    expect(transcript.task.id).toBe(task.id);
    expect(transcript.messages.some((m: any) => m.role === "assistant")).toBe(true);

    // cancel on a finished task → 409
    const cancel = await app.request(`/api/tasks/${task.id}/cancel`, { method: "POST", headers: auth });
    expect(cancel.status).toBe(409);

    // unknown ids → 404
    expect((await app.request("/api/tasks/nope/transcript", { headers: auth })).status).toBe(404);
    expect((await app.request("/api/tasks/nope/cancel", { method: "POST", headers: auth })).status).toBe(404);
  });
});
```

(`deps.taskManager` and `deps.indexer` must be reachable: the test file's `deps` is typed `AppDeps`, which gains `taskManager`; `indexer` is already in AppDeps.)

- [ ] **Step 3: Run, verify FAIL, then implement in `server/src/server.ts`**

Add `import type { TaskManager } from "./task-manager.ts";`, add `taskManager: TaskManager;` to `AppDeps`, and add routes after the sessions routes:

```ts
  app.get("/api/tasks", (c) => c.json({ tasks: indexer.listTasks() }));

  app.post("/api/tasks/:id/cancel", async (c) => {
    const id = c.req.param("id");
    if (!indexer.getTask(id)) return c.json({ error: "not found" }, 404);
    const ok = await deps.taskManager.cancel(id);
    if (!ok) return c.json({ error: "not cancellable" }, 409);
    return c.json({ ok: true });
  });

  app.get("/api/tasks/:id/transcript", async (c) => {
    const id = c.req.param("id");
    const task = indexer.getTask(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const messages = await deps.taskManager.getTranscript(id);
    return c.json({ task, messages });
  });
```

Also update `server/test/ws.test.ts`'s `createApp` deps with `taskManager: made.taskManager`. And in `server/src/index.ts`, add `taskManager` to the `createApp({...})` call.

- [ ] **Step 4: Full suite** — `npm test && npm run check` (66 + 1 = 67).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: task REST endpoints (list, cancel, transcript)"
```

---

### Task 6: Web UI — task state, task cards, transcript viewer, tasks dialog

No automated UI tests (per phase 1 convention); verification is `npm run build` + the manual pass in Task 7.

**Files:**
- Create: `web/src/components/TaskCard.tsx`, `web/src/components/TasksDialog.tsx`
- Modify: `web/src/lib/types.ts`, `web/src/lib/api.ts`, `web/src/useApp.ts`, `web/src/components/Message.tsx`, `web/src/components/Chat.tsx`, `web/src/components/Sidebar.tsx`, `web/src/App.tsx`

- [ ] **Step 1: Types + api client**

`web/src/lib/types.ts` — add:

```ts
export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface TaskRow {
  id: string;
  parentSessionId: string;
  subagentSessionId: string | null;
  label: string;
  status: TaskStatus;
  model: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  resultSummary: string;
}
```

and extend `ServerEvent` with `| { type: "task"; task: TaskRow }`. Also add `details?: unknown;` to `ChatMessage` (tool results carry `{taskId}` details for delegate calls).

`web/src/lib/api.ts` — add to `client`:

```ts
  listTasks: () => api<{ tasks: TaskRow[] }>("/api/tasks"),
  cancelTask: (id: string) => api<{ ok: true }>(`/api/tasks/${id}/cancel`, { method: "POST" }),
  getTaskTranscript: (id: string) =>
    api<{ task: TaskRow; messages: ChatMessage[] }>(`/api/tasks/${id}/transcript`),
```

(and add `TaskRow` to the type import).

- [ ] **Step 2: useApp task state**

In `web/src/useApp.ts`:

```ts
  const [tasks, setTasks] = useState<Record<string, TaskRow>>({});
```

(add `TaskRow` to the type imports). In `onEvent`, before the `session_meta` branch add:

```ts
    if (event.type === "task") {
      setTasks((prev) => ({ ...prev, [event.task.id]: event.task }));
      return;
    }
```

In the boot `useEffect`, alongside `refreshSessions()` add:

```ts
    void client.listTasks().then((r) => {
      setTasks(Object.fromEntries(r.tasks.map((t) => [t.id, t])));
    });
```

Return `tasks` from the hook.

- [ ] **Step 3: TaskCard component**

`web/src/components/TaskCard.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { client } from "@/lib/api";
import type { ChatMessage, TaskRow } from "@/lib/types";
import { Message } from "./Message";

const STATUS_STYLES: Record<string, string> = {
  pending: "text-neutral-400",
  running: "text-yellow-400 animate-pulse",
  completed: "text-green-400",
  failed: "text-red-400",
  cancelled: "text-neutral-500",
  interrupted: "text-orange-400",
};

function elapsed(task: TaskRow): string {
  if (!task.startedAt) return "";
  const end = task.finishedAt ? new Date(task.finishedAt).getTime() : Date.now();
  const secs = Math.max(0, Math.round((end - new Date(task.startedAt).getTime()) / 1000));
  return secs < 120 ? `${secs}s` : `${Math.round(secs / 60)}m`;
}

export function TaskTranscriptDialog({
  taskId,
  open,
  onOpenChange,
}: {
  taskId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [task, setTask] = useState<TaskRow | null>(null);

  useEffect(() => {
    if (!open || !taskId) return;
    let stop = false;
    async function poll() {
      try {
        const r = await client.getTaskTranscript(taskId!);
        if (stop) return;
        setTask(r.task);
        setMessages(r.messages);
        if (r.task.status === "running" || r.task.status === "pending") {
          setTimeout(poll, 2000);
        }
      } catch {
        // transcript may not exist yet (task pending); retry
        if (!stop) setTimeout(poll, 2000);
      }
    }
    void poll();
    return () => {
      stop = true;
    };
  }, [open, taskId]);

  const toolResults = new Map<string, ChatMessage>();
  for (const m of messages) {
    if (m.role === "toolResult" && m.toolCallId) toolResults.set(m.toolCallId, m);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {task ? `${task.label} — ${task.status}` : "Task transcript"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {messages.length === 0 && <p className="text-sm text-neutral-500">No transcript yet…</p>}
          {messages.map((m, i) => (
            <Message key={i} message={m} toolResults={toolResults} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function TaskCard({
  task,
  onViewTranscript,
}: {
  task: TaskRow | undefined;
  onViewTranscript: (taskId: string) => void;
}) {
  if (!task) {
    return (
      <div className="my-1 rounded-md border border-neutral-700 bg-neutral-900 p-2 text-sm text-neutral-500">
        background task (status unknown)
      </div>
    );
  }
  return (
    <div className="my-1 flex items-center gap-3 rounded-md border border-neutral-700 bg-neutral-900 p-2 text-sm">
      <span className={STATUS_STYLES[task.status] ?? ""}>●</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate font-medium">{task.label}</span>
          <span className="text-xs text-neutral-500">
            {task.status}
            {elapsed(task) && ` · ${elapsed(task)}`}
          </span>
        </div>
        {task.resultSummary && (
          <p className="truncate text-xs text-neutral-500">{task.resultSummary}</p>
        )}
      </div>
      {(task.status === "running" || task.status === "pending") && (
        <Button variant="outline" size="sm" onClick={() => void client.cancelTask(task.id)}>
          Cancel
        </Button>
      )}
      <Button variant="outline" size="sm" onClick={() => onViewTranscript(task.id)}>
        View
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: Render delegate tool calls as TaskCards**

`web/src/components/Message.tsx` — the `Message` component gains optional task props and routes `delegate` toolCalls to `TaskCard`:

1. Add imports:

```tsx
import type { ChatMessage, ContentBlock, TaskRow } from "@/lib/types";
import { TaskCard } from "./TaskCard";
```

2. Extend the `Message` props:

```tsx
export function Message({
  message,
  toolResults,
  tasks,
  onViewTranscript,
}: {
  message: ChatMessage;
  toolResults: Map<string, ChatMessage>;
  tasks?: Record<string, TaskRow>;
  onViewTranscript?: (taskId: string) => void;
}) {
```

3. In the block mapping, before the generic `toolCall` branch, add:

```tsx
          if (b.type === "toolCall" && b.name === "delegate" && tasks && onViewTranscript) {
            const result = b.id ? toolResults.get(b.id) : undefined;
            const taskId =
              (result?.details as any)?.taskId ??
              /task ([0-9a-f-]{16,})/i.exec(
                typeof result?.content === "string"
                  ? result.content
                  : (result?.content ?? []).map((c) => c.text ?? "").join(" "),
              )?.[1];
            return <TaskCard key={i} task={taskId ? tasks[taskId] : undefined} onViewTranscript={onViewTranscript} />;
          }
```

(uuidv7 ids are hex+dashes; the regex is the fallback when `details` wasn't persisted.)

- [ ] **Step 5: Chat threads the task props + hosts the transcript dialog**

`web/src/components/Chat.tsx`:

1. Props gain `tasks: Record<string, TaskRow>` (import the type). 
2. Add local state and the dialog:

```tsx
  const [transcriptTaskId, setTranscriptTaskId] = useState<string | null>(null);
```

3. Pass `tasks={tasks}` and `onViewTranscript={setTranscriptTaskId}` to every `<Message ...>` (both the list and the streaming one), and render at the end of the `<main>` (after the composer div):

```tsx
      <TaskTranscriptDialog
        taskId={transcriptTaskId}
        open={transcriptTaskId !== null}
        onOpenChange={(open) => {
          if (!open) setTranscriptTaskId(null);
        }}
      />
```

with `import { TaskTranscriptDialog } from "./TaskCard";`.

- [ ] **Step 6: Tasks dialog + sidebar button**

`web/src/components/TasksDialog.tsx`:

```tsx
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { TaskRow } from "@/lib/types";
import { TaskCard, TaskTranscriptDialog } from "./TaskCard";

export function TasksDialog({
  open,
  onOpenChange,
  tasks,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tasks: Record<string, TaskRow>;
}) {
  const [transcriptTaskId, setTranscriptTaskId] = useState<string | null>(null);
  const sorted = Object.values(tasks).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Background tasks</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            {sorted.length === 0 && <p className="text-sm text-neutral-500">No tasks yet.</p>}
            {sorted.map((t) => (
              <TaskCard key={t.id} task={t} onViewTranscript={setTranscriptTaskId} />
            ))}
          </div>
        </DialogContent>
      </Dialog>
      <TaskTranscriptDialog
        taskId={transcriptTaskId}
        open={transcriptTaskId !== null}
        onOpenChange={(o) => {
          if (!o) setTranscriptTaskId(null);
        }}
      />
    </>
  );
}
```

`web/src/components/Sidebar.tsx` — add a Tasks button next to the settings button. Props gain `onOpenTasks: () => void; runningTasks: number;`:

```tsx
        <Button variant="outline" onClick={onOpenTasks}>
          Tasks{runningTasks > 0 ? ` (${runningTasks})` : ""}
        </Button>
```

`web/src/App.tsx` — `Main` gains:

```tsx
  const [tasksOpen, setTasksOpen] = useState(false);
  const runningTasks = Object.values(app.tasks).filter(
    (t) => t.status === "running" || t.status === "pending",
  ).length;
```

Pass `onOpenTasks={() => setTasksOpen(true)}` and `runningTasks={runningTasks}` to `Sidebar`, `tasks={app.tasks}` to `Chat`, and render `<TasksDialog open={tasksOpen} onOpenChange={setTasksOpen} tasks={app.tasks} />` next to `Settings` (imports accordingly).

- [ ] **Step 7: Build**

```bash
cd web && npm run build
```

Fix any type errors (the likely ones: missing imports, the ContentBlock text join in the regex fallback). Server tests still green: `cd ../server && npm test`.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: task cards, transcript viewer, and tasks dialog in the web UI"
```

---

### Task 7: README + end-to-end verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README** — add rows to the Configuration table:

```markdown
| `YTSEJAM_SUBAGENT_MODEL` | same as default model | model for delegated background tasks |
| `YTSEJAM_TASK_CONCURRENCY` | `4` | max concurrently running background tasks |
| `YTSEJAM_TASK_TIMEOUT_MIN` | `15` | per-task timeout (minutes) |
```

and a feature line under the intro: `The assistant can delegate work to background subagents and notifies you in-chat when they finish.`

- [ ] **Step 2: Full gates**

```bash
cd ~/projects/ytsejam && npm test && npm run check && npm run build && git status --short
```

All green (67 server tests), tree clean except README.

- [ ] **Step 3: Live end-to-end (real model)**

```bash
cd server
YTSEJAM_AUTH_TOKEN=dev YTSEJAM_DATA_DIR=/tmp/ytsejam-p2 YTSEJAM_PORT=3226 \
  YTSEJAM_SUBAGENT_MODEL=github-copilot/claude-haiku-4.5 node src/index.ts
```

In the browser at :3226 (or via curl + transcript polling if headless): send
"delegate a background task to research what JSONL is and report back; keep chatting with me meanwhile".
Verify: the assistant calls `delegate` and replies immediately; a task card appears (pending → running, elapsed ticking); "Tasks (1)" shows in the sidebar; View opens the live subagent transcript; on completion the assistant posts a follow-up message summarizing the report without any user input; the unread badge/notification fires if you're in another session. Also verify cancel: delegate another task and cancel it from the card — the task shows cancelled and the assistant is NOT notified.

Restart test: delegate a slow task, restart the server mid-run, confirm the task shows `interrupted` and the assistant received the interruption message.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: phase 2 delegation config in README"
```

---

## Spec coverage map (phase 2 slice)

| Spec requirement | Task |
| --- | --- |
| `data/tasks/<task-id>.jsonl` lifecycle SSOT | 1 |
| sqlite tasks table (derived, rebuildable) | 1, 3 (rebuildIndex) |
| delegate tool `{task, context?, model?, label}` returning immediately | 4 |
| check_task / cancel_task tools | 4 |
| Subagents: full in-process agents, own JSONL sessions, worker prompt naming persona, web+system tools, NO delegate (no recursion) | 3, 4 (workerTools = createTools only) |
| Concurrency cap (default 4, configurable) + pending queue | 3, 4 (config) |
| Per-task timeout (default 15 min) → failed, never silent | 3, 4 (config) |
| Completion/failure → follow-up injection, assistant always takes a turn | 2, 3 |
| Unread badge + browser notification on completion | existing phase 1 path (assistant turn → message_end → unread) — verified in 7 |
| Server restart → running tasks `interrupted` + parent notified | 3 (recoverInterrupted), 7 (verified) |
| Task cards in chat (label/status/elapsed, live) | 6 |
| Click card → subagent transcript (read-only, watchable) | 6 (2s polling while running) |
| Tasks view across sessions | 6 (TasksDialog + sidebar button) |
| GET /api/tasks, POST /api/tasks/:id/cancel | 5 |
| Subagent transcript endpoint | 5 (/api/tasks/:id/transcript) |
| Task status changes over the single WS | 3 (bus event) + existing WS passthrough |
| Delegation etiquette in chat system prompt | 4 |
