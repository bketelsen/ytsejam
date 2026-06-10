# Phase 4: Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The assistant can schedule one-shot and recurring (cron) jobs that wake it up — a message is injected into a target session at fire time and the assistant acts on it; the UI lists and cancels schedules.

**Architecture:** Schedule lifecycle events append to `data/schedules/schedules.jsonl` (SSOT, single file per the spec's data layout); the sqlite `Indexer` gains a derived `schedules` table (schema v3). A `SchedulerService` ticks every 30s, fires due enabled schedules by injecting `[Scheduled task "label"] <prompt>` into the target session through the same follow-up mechanism delegation uses (renamed `AgentManager.injectMessage`), records `fired` events with the precomputed next occurrence, and on boot catches up: overdue one-shots fire once, overdue crons reschedule to their next occurrence. Tools `schedule`/`list_schedules`/`cancel_schedule` are per-session (so "this session" targeting works); a schedule can instead target a fresh session created at fire time. Spec: scheduler section of `docs/superpowers/specs/2026-06-09-personal-assistant-design.md`.

**Tech Stack:** Existing stack + one new dependency: `cron-parser@^5` (pure JS).

**Verified API facts:** `cron-parser@5.5.0` ESM exports `CronExpressionParser`; `CronExpressionParser.parse(expr, { currentDate: Date }).next().toDate()` returns the next occurrence and evaluates in the server's LOCAL timezone (verified on this machine: `"0 9 * * *"` from 12:00Z → 13:00Z under America/New_York); `.parse` throws on invalid expressions. pi APIs are all ones this codebase already uses. Current code facts: `AgentManager.injectTaskResult(id, text)` exists (manager.ts — this plan renames it to `injectMessage`); `AgentManagerOptions.sessionTools` factory exists; `index.ts` builds sessionTools with `createDelegationTools`; indexer `SCHEMA_VERSION` is currently `2`; ServerEvent union lives in `server/src/events.ts`; the WS handler forwards all non-`agent` events to every client.

**Design decisions (made here, consistent with the approved spec):** cron expressions evaluate in server-local time (document in tool description and README). `nextFireAt` is precomputed and stored ON each event (`created`/`fired`/`rescheduled`) so folding stays pure — no clock needed to fold. One-shot schedules auto-disable after firing. No PATCH/enable-disable endpoint (cancel covers the need; YAGNI). Schedules UI lives in the Settings dialog (per spec "Settings: … schedules list").

**Conventions:** Branch `feat/phase4-scheduler` (create in Task 1). Node 26 native TS, `.ts` import extensions, `erasableSyntaxOnly` (no constructor parameter properties). Tests `cd server && npm test` (currently 67 green); types `npm run check`; web `cd web && npm run build`. Commit per task; never push; don't touch docs/.

**File map:** Create `server/src/schedules.ts` (store + fold + next-fire), `server/src/scheduler.ts` (service), `server/src/tools/scheduling.ts`, tests for each. Modify `server/src/{indexer,events,manager,persona,server,index}.ts`, `server/src/tools/delegation.ts` (rename call), `server/test/{manager,delegation,api,ws}.test.ts` (rename + deps), `web/src/{lib/types.ts,lib/api.ts,components/Settings.tsx}`, `README.md`.

---

### Task 1: Schedule store, next-fire computation, Indexer schema v3

**Files:**
- Create: `server/src/schedules.ts`
- Modify: `server/package.json` (cron-parser), `server/src/indexer.ts`
- Test: `server/test/schedules.test.ts`, `server/test/indexer.test.ts` (extend)

- [ ] **Step 1: Branch + dependency**

```bash
cd /home/bjk/projects/ytsejam && git switch -c feat/phase4-scheduler
cd server && npm install cron-parser@^5
```

- [ ] **Step 2: Failing store tests**

`server/test/schedules.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  computeNextFire,
  foldScheduleEvents,
  ScheduleStore,
  type ScheduleEvent,
} from "../src/schedules.ts";

const dir = () => join(mkdtempSync(join(tmpdir(), "sched-")), "schedules");

const onceCreated: ScheduleEvent = {
  type: "created",
  scheduleId: "s1",
  label: "remind me",
  prompt: "remind the user about the dentist",
  spec: { type: "once", at: "2026-06-10T09:00:00.000Z" },
  targetSessionId: "sess-1",
  nextFireAt: "2026-06-10T09:00:00.000Z",
  timestamp: "2026-06-09T10:00:00.000Z",
};

describe("computeNextFire", () => {
  test("once: returns the at time", () => {
    expect(computeNextFire({ type: "once", at: "2026-06-10T09:00:00.000Z" }, new Date())).toBe(
      "2026-06-10T09:00:00.000Z",
    );
  });

  test("cron: returns the next occurrence after from", () => {
    const from = new Date("2026-06-09T10:00:00.000Z");
    const next = computeNextFire({ type: "cron", expr: "*/15 * * * *" }, from);
    expect(next).toBe("2026-06-09T10:15:00.000Z");
  });

  test("cron: throws on invalid expressions", () => {
    expect(() => computeNextFire({ type: "cron", expr: "not a cron" }, new Date())).toThrow();
  });
});

describe("foldScheduleEvents", () => {
  test("created → enabled with nextFireAt", () => {
    const rows = foldScheduleEvents([onceCreated]);
    expect(rows.get("s1")).toMatchObject({
      id: "s1",
      label: "remind me",
      enabled: true,
      cancelled: false,
      firedCount: 0,
      nextFireAt: "2026-06-10T09:00:00.000Z",
      lastFiredAt: null,
    });
  });

  test("one-shot fired → disabled; cron fired → stays enabled with new nextFireAt", () => {
    const rows = foldScheduleEvents([
      onceCreated,
      { type: "fired", scheduleId: "s1", firedAt: "2026-06-10T09:00:01.000Z", nextFireAt: null, timestamp: "2026-06-10T09:00:01.000Z" },
      {
        ...onceCreated,
        scheduleId: "s2",
        spec: { type: "cron", expr: "0 9 * * *" },
        nextFireAt: "2026-06-10T09:00:00.000Z",
      },
      { type: "fired", scheduleId: "s2", firedAt: "2026-06-10T09:00:01.000Z", nextFireAt: "2026-06-11T09:00:00.000Z", timestamp: "2026-06-10T09:00:01.000Z" },
    ]);
    expect(rows.get("s1")).toMatchObject({ enabled: false, firedCount: 1, nextFireAt: null });
    expect(rows.get("s2")).toMatchObject({
      enabled: true,
      firedCount: 1,
      nextFireAt: "2026-06-11T09:00:00.000Z",
      lastFiredAt: "2026-06-10T09:00:01.000Z",
    });
  });

  test("cancelled and rescheduled events", () => {
    const rows = foldScheduleEvents([
      onceCreated,
      { type: "rescheduled", scheduleId: "s1", nextFireAt: "2026-06-12T09:00:00.000Z", timestamp: "x" },
      { type: "cancelled", scheduleId: "s1", timestamp: "y" },
    ]);
    expect(rows.get("s1")).toMatchObject({
      enabled: false,
      cancelled: true,
      nextFireAt: "2026-06-12T09:00:00.000Z",
    });
  });
});

describe("ScheduleStore", () => {
  test("append/foldAll round-trip in a single JSONL file", () => {
    const store = new ScheduleStore(dir());
    expect(store.foldAll().size).toBe(0);
    store.append(onceCreated);
    store.append({ ...onceCreated, scheduleId: "s2" });
    store.append({ type: "cancelled", scheduleId: "s2", timestamp: "y" });
    const rows = store.foldAll();
    expect(rows.size).toBe(2);
    expect(rows.get("s1")!.enabled).toBe(true);
    expect(rows.get("s2")!.cancelled).toBe(true);
  });
});
```

- [ ] **Step 3: Run, verify FAIL** — `npx vitest --run test/schedules.test.ts`

- [ ] **Step 4: Implement `server/src/schedules.ts`**

```ts
import fs from "node:fs";
import path from "node:path";
import { CronExpressionParser } from "cron-parser";

export type ScheduleSpec = { type: "once"; at: string } | { type: "cron"; expr: string };

/** Derived row (sqlite + API + UI). The JSONL events are the SSOT. */
export interface ScheduleRow {
  id: string;
  label: string;
  prompt: string;
  spec: ScheduleSpec;
  /** null = create a fresh session at fire time */
  targetSessionId: string | null;
  enabled: boolean;
  cancelled: boolean;
  createdAt: string;
  lastFiredAt: string | null;
  nextFireAt: string | null;
  firedCount: number;
}

export type ScheduleEvent =
  | {
      type: "created";
      scheduleId: string;
      label: string;
      prompt: string;
      spec: ScheduleSpec;
      targetSessionId: string | null;
      nextFireAt: string;
      timestamp: string;
    }
  | { type: "fired"; scheduleId: string; firedAt: string; nextFireAt: string | null; timestamp: string }
  | { type: "rescheduled"; scheduleId: string; nextFireAt: string | null; timestamp: string }
  | { type: "cancelled"; scheduleId: string; timestamp: string };

/**
 * Next occurrence for a spec, strictly after `from`. Cron expressions
 * evaluate in the server's local timezone. Throws on invalid cron syntax.
 */
export function computeNextFire(spec: ScheduleSpec, from: Date): string {
  if (spec.type === "once") return spec.at;
  return CronExpressionParser.parse(spec.expr, { currentDate: from }).next().toDate().toISOString();
}

export function foldScheduleEvents(events: ScheduleEvent[]): Map<string, ScheduleRow> {
  const rows = new Map<string, ScheduleRow>();
  for (const e of events) {
    if (e.type === "created") {
      rows.set(e.scheduleId, {
        id: e.scheduleId,
        label: e.label,
        prompt: e.prompt,
        spec: e.spec,
        targetSessionId: e.targetSessionId,
        enabled: true,
        cancelled: false,
        createdAt: e.timestamp,
        lastFiredAt: null,
        nextFireAt: e.nextFireAt,
        firedCount: 0,
      });
      continue;
    }
    const row = rows.get(e.scheduleId);
    if (!row) continue; // tolerate orphaned events
    if (e.type === "fired") {
      row.firedCount += 1;
      row.lastFiredAt = e.firedAt;
      row.nextFireAt = e.nextFireAt;
      if (row.spec.type === "once") row.enabled = false;
    } else if (e.type === "rescheduled") {
      row.nextFireAt = e.nextFireAt;
    } else if (e.type === "cancelled") {
      row.cancelled = true;
      row.enabled = false;
    }
  }
  return rows;
}

/** Append-only schedule lifecycle events, one shared JSONL file. */
export class ScheduleStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private get filePath(): string {
    return path.join(this.dir, "schedules.jsonl");
  }

  append(event: ScheduleEvent): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`);
  }

  readAll(): ScheduleEvent[] {
    try {
      return fs
        .readFileSync(this.filePath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ScheduleEvent);
    } catch {
      return [];
    }
  }

  foldAll(): Map<string, ScheduleRow> {
    return foldScheduleEvents(this.readAll());
  }
}
```

- [ ] **Step 5: Store tests PASS, then failing Indexer tests**

Append to `server/test/indexer.test.ts` (add `import type { ScheduleRow } from "../src/schedules.ts";`):

```ts
describe("schedules table", () => {
  const sched: ScheduleRow = {
    id: "sch1",
    label: "daily brief",
    prompt: "summarize my day",
    spec: { type: "cron", expr: "0 9 * * *" },
    targetSessionId: null,
    enabled: true,
    cancelled: false,
    createdAt: "2026-06-09T10:00:00Z",
    lastFiredAt: null,
    nextFireAt: "2026-06-10T09:00:00Z",
    firedCount: 0,
  };

  test("upsert, get with spec round-trip, list ordering", () => {
    const idx = new Indexer(tempDb());
    idx.upsertSchedule(sched);
    idx.upsertSchedule({ ...sched, id: "sch2", createdAt: "2026-06-09T11:00:00Z" });
    idx.upsertSchedule({ ...sched, enabled: false, firedCount: 3 });
    expect(idx.getSchedule("sch1")).toMatchObject({
      enabled: false,
      firedCount: 3,
      spec: { type: "cron", expr: "0 9 * * *" },
    });
    expect(idx.listSchedules().map((s) => s.id)).toEqual(["sch2", "sch1"]); // newest first
    expect(idx.getSchedule("missing")).toBeUndefined();
  });
});
```

- [ ] **Step 6: Implement Indexer v3**

In `server/src/indexer.ts`:
1. `const SCHEMA_VERSION = 3;`
2. Add `import type { ScheduleRow } from "./schedules.ts";`
3. In `recreateSchema()`: add `DROP TABLE IF EXISTS schedules;` next to the other drops, and append:

```sql
      CREATE TABLE schedules (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        prompt TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        target_session_id TEXT,
        enabled INTEGER NOT NULL,
        cancelled INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        last_fired_at TEXT,
        next_fire_at TEXT,
        fired_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX schedules_created ON schedules(created_at DESC);
```

4. Methods:

```ts
  upsertSchedule(row: ScheduleRow): void {
    this.db
      .prepare(
        `INSERT INTO schedules (id, label, prompt, spec_json, target_session_id, enabled, cancelled,
           created_at, last_fired_at, next_fire_at, fired_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, cancelled=excluded.cancelled,
           last_fired_at=excluded.last_fired_at, next_fire_at=excluded.next_fire_at,
           fired_count=excluded.fired_count`,
      )
      .run(
        row.id,
        row.label,
        row.prompt,
        JSON.stringify(row.spec),
        row.targetSessionId,
        row.enabled ? 1 : 0,
        row.cancelled ? 1 : 0,
        row.createdAt,
        row.lastFiredAt,
        row.nextFireAt,
        row.firedCount,
      );
  }

  getSchedule(id: string): ScheduleRow | undefined {
    const r = this.db.prepare("SELECT * FROM schedules WHERE id=?").get(id) as any;
    return r ? this.toScheduleRow(r) : undefined;
  }

  listSchedules(): ScheduleRow[] {
    return (this.db.prepare("SELECT * FROM schedules ORDER BY created_at DESC").all() as any[]).map(
      (r) => this.toScheduleRow(r),
    );
  }

  private toScheduleRow(r: any): ScheduleRow {
    return {
      id: r.id,
      label: r.label,
      prompt: r.prompt,
      spec: JSON.parse(r.spec_json),
      targetSessionId: r.target_session_id,
      enabled: Number(r.enabled) === 1,
      cancelled: Number(r.cancelled) === 1,
      createdAt: r.created_at,
      lastFiredAt: r.last_fired_at,
      nextFireAt: r.next_fire_at,
      firedCount: Number(r.fired_count),
    };
  }
```

- [ ] **Step 7: Full suite** — `npm test && npm run check` (67 + 6 + 1 = 74 tests).

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: schedule event store and schedules index table (schema v3)"
```

---

### Task 2: Rename `injectTaskResult` → `injectMessage`; SchedulerService

**Files:**
- Modify: `server/src/manager.ts`, `server/src/index.ts` (notifyParent call comment only — it passes a closure, no change needed; verify), `server/test/manager.test.ts`
- Create: `server/src/scheduler.ts`
- Modify: `server/src/events.ts`
- Test: `server/test/scheduler.test.ts`

- [ ] **Step 1: Rename**

In `server/src/manager.ts`, rename the method `injectTaskResult` to `injectMessage` and update its doc comment to:

```ts
  /**
   * Inject an out-of-band message (task result, scheduled prompt). The
   * assistant always takes a turn on it: queued as a follow-up when a run is
   * active, or started as a fresh turn when idle.
   */
```

Update every call/reference: `server/test/manager.test.ts` (the `describe("injectTaskResult")` block — rename describe to `"injectMessage"` and the calls), `server/test/helpers.ts` and `server/test/delegation.test.ts` (`notifyParent: (sessionId, text) => manager.injectMessage(sessionId, text)`), `server/src/index.ts` (same closure). Grep to be sure: `grep -rn injectTaskResult server/` must return nothing afterward.

Run `npm test` — all 74 still green. Commit: `git add -A && git commit -m "refactor: generalize injectTaskResult to injectMessage"`

- [ ] **Step 2: ServerEvent variant**

In `server/src/events.ts` add `import type { ScheduleRow } from "./schedules.ts";` and the union member:

```ts
  | { type: "schedule"; schedule: ScheduleRow }
```

- [ ] **Step 3: Failing SchedulerService tests**

`server/test/scheduler.test.ts` — uses an injected clock and recorded callbacks; no timers, no LLM:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { EventBus, type ServerEvent } from "../src/events.ts";
import { Indexer } from "../src/indexer.ts";
import { ScheduleStore } from "../src/schedules.ts";
import { SchedulerService } from "../src/scheduler.ts";

interface Made {
  scheduler: SchedulerService;
  store: ScheduleStore;
  indexer: Indexer;
  bus: EventBus;
  injected: Array<{ sessionId: string; text: string }>;
  createdSessions: string[];
  setNow: (iso: string) => void;
}

function makeScheduler(): Made {
  const dataDir = mkdtempSync(join(tmpdir(), "schedsvc-"));
  const store = new ScheduleStore(join(dataDir, "schedules"));
  const indexer = new Indexer(join(dataDir, "index.db"));
  const bus = new EventBus();
  const injected: Array<{ sessionId: string; text: string }> = [];
  const createdSessions: string[] = [];
  let now = new Date("2026-06-09T10:00:00.000Z");
  let sessionCounter = 0;
  const scheduler = new SchedulerService({
    store,
    indexer,
    bus,
    now: () => now,
    inject: async (sessionId, text) => {
      injected.push({ sessionId, text });
    },
    createTargetSession: async (label) => {
      const id = `new-sess-${++sessionCounter}-${label}`;
      createdSessions.push(id);
      return id;
    },
  });
  return {
    scheduler,
    store,
    indexer,
    bus,
    injected,
    createdSessions,
    setNow: (iso) => {
      now = new Date(iso);
    },
  };
}

describe("SchedulerService", () => {
  test("create validates and indexes; one-shot fires once at its time into the target session", async () => {
    const m = makeScheduler();
    const row = m.scheduler.create({
      label: "dentist",
      prompt: "remind the user about the dentist appointment",
      spec: { type: "once", at: "2026-06-09T11:00:00.000Z" },
      targetSessionId: "sess-1",
    });
    expect(row.enabled).toBe(true);
    expect(m.indexer.getSchedule(row.id)).toMatchObject({ nextFireAt: "2026-06-09T11:00:00.000Z" });

    await m.scheduler.tick();
    expect(m.injected).toEqual([]); // not due yet

    m.setNow("2026-06-09T11:00:01.000Z");
    await m.scheduler.tick();
    expect(m.injected).toHaveLength(1);
    expect(m.injected[0]!.sessionId).toBe("sess-1");
    expect(m.injected[0]!.text).toContain('[Scheduled task "dentist"]');
    expect(m.injected[0]!.text).toContain("dentist appointment");
    expect(m.indexer.getSchedule(row.id)).toMatchObject({ enabled: false, firedCount: 1 });

    await m.scheduler.tick(); // does not fire again
    expect(m.injected).toHaveLength(1);
  });

  test("cron fires repeatedly with advancing nextFireAt", async () => {
    const m = makeScheduler();
    const row = m.scheduler.create({
      label: "quarterly",
      prompt: "check in",
      spec: { type: "cron", expr: "*/15 * * * *" },
      targetSessionId: "sess-1",
    });
    m.setNow("2026-06-09T10:16:00.000Z");
    await m.scheduler.tick();
    expect(m.injected).toHaveLength(1);
    const afterFirst = m.indexer.getSchedule(row.id)!;
    expect(afterFirst.enabled).toBe(true);
    expect(afterFirst.firedCount).toBe(1);
    expect(new Date(afterFirst.nextFireAt!).getTime()).toBeGreaterThan(
      new Date("2026-06-09T10:16:00.000Z").getTime(),
    );

    m.setNow("2026-06-09T10:31:00.000Z");
    await m.scheduler.tick();
    expect(m.injected).toHaveLength(2);
  });

  test("null target creates a fresh session at fire time", async () => {
    const m = makeScheduler();
    m.scheduler.create({
      label: "briefing",
      prompt: "morning briefing",
      spec: { type: "once", at: "2026-06-09T10:30:00.000Z" },
      targetSessionId: null,
    });
    m.setNow("2026-06-09T10:31:00.000Z");
    await m.scheduler.tick();
    expect(m.createdSessions).toHaveLength(1);
    expect(m.injected[0]!.sessionId).toBe(m.createdSessions[0]);
  });

  test("cancel disables; create rejects invalid input", async () => {
    const m = makeScheduler();
    const row = m.scheduler.create({
      label: "x",
      prompt: "y",
      spec: { type: "once", at: "2026-06-09T11:00:00.000Z" },
      targetSessionId: "sess-1",
    });
    expect(m.scheduler.cancel(row.id)).toBe(true);
    expect(m.scheduler.cancel(row.id)).toBe(false); // already cancelled
    m.setNow("2026-06-09T12:00:00.000Z");
    await m.scheduler.tick();
    expect(m.injected).toEqual([]);

    expect(() =>
      m.scheduler.create({
        label: "bad",
        prompt: "p",
        spec: { type: "once", at: "2026-06-09T09:00:00.000Z" }, // in the past
        targetSessionId: "s",
      }),
    ).toThrow(/future/);
    expect(() =>
      m.scheduler.create({
        label: "bad",
        prompt: "p",
        spec: { type: "cron", expr: "garbage" },
        targetSessionId: "s",
      }),
    ).toThrow();
  });

  test("catchUp: overdue one-shot fires once, overdue cron reschedules without firing", async () => {
    const m = makeScheduler();
    // events written "by a previous process": both due in the past
    m.store.append({
      type: "created",
      scheduleId: "old-once",
      label: "missed reminder",
      prompt: "missed it",
      spec: { type: "once", at: "2026-06-09T08:00:00.000Z" },
      targetSessionId: "sess-1",
      nextFireAt: "2026-06-09T08:00:00.000Z",
      timestamp: "2026-06-08T10:00:00.000Z",
    });
    m.store.append({
      type: "created",
      scheduleId: "old-cron",
      label: "hourly",
      prompt: "tick",
      spec: { type: "cron", expr: "0 * * * *" },
      targetSessionId: "sess-1",
      nextFireAt: "2026-06-09T08:00:00.000Z",
      timestamp: "2026-06-08T10:00:00.000Z",
    });
    await m.scheduler.rebuildIndex();
    await m.scheduler.catchUp();

    // one-shot fired exactly once
    expect(m.injected).toHaveLength(1);
    expect(m.injected[0]!.text).toContain("missed reminder");
    expect(m.indexer.getSchedule("old-once")).toMatchObject({ enabled: false, firedCount: 1 });

    // cron did NOT fire, but nextFireAt moved into the future
    const cron = m.indexer.getSchedule("old-cron")!;
    expect(cron.firedCount).toBe(0);
    expect(new Date(cron.nextFireAt!).getTime()).toBeGreaterThan(
      new Date("2026-06-09T10:00:00.000Z").getTime(),
    );
  });

  test("schedule events flow over the bus", async () => {
    const m = makeScheduler();
    const events: ServerEvent[] = [];
    m.bus.subscribe((e) => events.push(e));
    m.scheduler.create({
      label: "x",
      prompt: "y",
      spec: { type: "once", at: "2026-06-09T11:00:00.000Z" },
      targetSessionId: "s",
    });
    expect(events.some((e) => e.type === "schedule")).toBe(true);
  });
});
```

- [ ] **Step 4: Run, verify FAIL, then implement `server/src/scheduler.ts`**

```ts
import { uuidv7 } from "@earendil-works/pi-agent-core";
import type { EventBus } from "./events.ts";
import type { Indexer } from "./indexer.ts";
import {
  computeNextFire,
  type ScheduleRow,
  type ScheduleSpec,
  type ScheduleStore,
} from "./schedules.ts";

export interface CreateScheduleInput {
  label: string;
  prompt: string;
  spec: ScheduleSpec;
  /** null = create a fresh session at fire time */
  targetSessionId: string | null;
}

export interface SchedulerOptions {
  store: ScheduleStore;
  indexer: Indexer;
  bus: EventBus;
  /** injectable clock for tests */
  now?: () => Date;
  /** inject the fire text into a session (assistant takes a turn) */
  inject: (sessionId: string, text: string) => Promise<void>;
  /** create a fresh chat session for schedules without a target; returns its id */
  createTargetSession: (label: string) => Promise<string>;
}

/**
 * Fires due schedules by injecting their prompt into the target session.
 * Schedule events in ScheduleStore are the SSOT; sqlite/bus are derived.
 * nextFireAt is precomputed on each event so folding needs no clock.
 */
export class SchedulerService {
  private readonly opts: SchedulerOptions;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(opts: SchedulerOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => new Date());
  }

  // ---- public API ----------------------------------------------------------

  create(input: CreateScheduleInput): ScheduleRow {
    const now = this.now();
    if (input.spec.type === "once") {
      const at = new Date(input.spec.at);
      if (Number.isNaN(at.getTime())) throw new Error(`Invalid timestamp: ${input.spec.at}`);
      if (at.getTime() <= now.getTime()) throw new Error("Schedule time must be in the future");
    }
    const nextFireAt = computeNextFire(input.spec, now); // throws on bad cron
    const scheduleId = uuidv7();
    return this.record({
      type: "created",
      scheduleId,
      label: input.label,
      prompt: input.prompt,
      spec: input.spec,
      targetSessionId: input.targetSessionId,
      nextFireAt,
      timestamp: now.toISOString(),
    });
  }

  list(): ScheduleRow[] {
    return this.opts.indexer.listSchedules();
  }

  /** Cancel an active schedule. False when unknown or already cancelled/spent. */
  cancel(scheduleId: string): boolean {
    const row = this.opts.store.foldAll().get(scheduleId);
    if (!row || !row.enabled) return false;
    this.record({ type: "cancelled", scheduleId, timestamp: this.now().toISOString() });
    return true;
  }

  /** Fire everything due. Serialized: overlapping calls are skipped. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const row of this.opts.store.foldAll().values()) {
        if (!row.enabled || !row.nextFireAt) continue;
        if (new Date(row.nextFireAt).getTime() > now.getTime()) continue;
        await this.fire(row);
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Boot recovery: overdue one-shots fire once (the user wanted them);
   * overdue crons skip missed occurrences and reschedule from now.
   */
  async catchUp(): Promise<void> {
    const now = this.now();
    for (const row of this.opts.store.foldAll().values()) {
      if (!row.enabled || !row.nextFireAt) continue;
      if (new Date(row.nextFireAt).getTime() > now.getTime()) continue;
      if (row.spec.type === "once") {
        await this.fire(row);
      } else {
        this.record({
          type: "rescheduled",
          scheduleId: row.id,
          nextFireAt: computeNextFire(row.spec, now),
          timestamp: now.toISOString(),
        });
      }
    }
  }

  /** Repopulate the (derived) schedules table from JSONL. */
  async rebuildIndex(): Promise<void> {
    for (const row of this.opts.store.foldAll().values()) {
      this.opts.indexer.upsertSchedule(row);
    }
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => console.error("scheduler tick failed", err));
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- internals -----------------------------------------------------------

  private record(event: Parameters<ScheduleStore["append"]>[0]): ScheduleRow {
    this.opts.store.append(event);
    const row = this.opts.store.foldAll().get(event.scheduleId)!;
    this.opts.indexer.upsertSchedule(row);
    this.opts.bus.emit({ type: "schedule", schedule: row });
    return row;
  }

  private async fire(row: ScheduleRow): Promise<void> {
    const now = this.now();
    // record the firing FIRST so a crash mid-inject can't double-fire on catch-up
    this.record({
      type: "fired",
      scheduleId: row.id,
      firedAt: now.toISOString(),
      nextFireAt: row.spec.type === "cron" ? computeNextFire(row.spec, now) : null,
      timestamp: now.toISOString(),
    });
    try {
      const sessionId =
        row.targetSessionId ?? (await this.opts.createTargetSession(row.label));
      await this.opts.inject(sessionId, `[Scheduled task "${row.label}"] ${row.prompt}`);
    } catch (err) {
      console.error(`failed to fire schedule ${row.id} ("${row.label}")`, err);
    }
  }
}
```

- [ ] **Step 5: Run → PASS; full suite** (74 + 6 = 80 tests), `npm run check`.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: SchedulerService with tick loop, catch-up, and session injection"
```

---

### Task 3: Scheduling tools, prompt guidance, boot wiring, integration test

**Files:**
- Create: `server/src/tools/scheduling.ts`
- Modify: `server/src/persona.ts`, `server/src/index.ts`
- Test: `server/test/scheduling-tools.test.ts` (integration)

- [ ] **Step 1: Tools**

`server/src/tools/scheduling.ts`:

```ts
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SchedulerService } from "../scheduler.ts";
import type { ScheduleRow } from "../schedules.ts";

const scheduleParams = Type.Object({
  prompt: Type.String({
    description:
      "The instruction you will receive when this fires. Write it to your future self — it arrives as a [Scheduled task ...] message with no other context.",
  }),
  label: Type.String({ description: "Short human-readable label (3-6 words)" }),
  at: Type.Optional(
    Type.String({
      description: 'One-shot fire time as an ISO 8601 timestamp, e.g. "2026-06-10T09:00:00-04:00". Exactly one of at/cron.',
    }),
  ),
  cron: Type.Optional(
    Type.String({
      description:
        'Recurring schedule as a 5-field cron expression in SERVER LOCAL TIME, e.g. "0 9 * * 1-5" for 9am weekdays. Exactly one of at/cron.',
    }),
  ),
  target: Type.Optional(
    Type.Union([Type.Literal("this_session"), Type.Literal("new_session")], {
      description: "Where the fire message lands. Default this_session; new_session opens a fresh conversation at fire time.",
    }),
  ),
});

const scheduleIdParams = Type.Object({ scheduleId: Type.String() });

function describeRow(row: ScheduleRow): string {
  const spec = row.spec.type === "once" ? `once at ${row.spec.at}` : `cron "${row.spec.expr}"`;
  const state = row.cancelled ? "cancelled" : row.enabled ? `next fire ${row.nextFireAt}` : "completed";
  return `${row.id} ("${row.label}") — ${spec}; ${state}; fired ${row.firedCount}x`;
}

export function createSchedulingTools(
  getScheduler: () => SchedulerService,
  sessionId: string,
): AgentTool<any>[] {
  const schedule: AgentTool<typeof scheduleParams> = {
    name: "schedule",
    label: "Schedule a task",
    description:
      "Schedule a one-shot reminder (at) or recurring job (cron) for yourself. When it fires you receive the prompt as a [Scheduled task ...] message and act on it. Use for reminders, recurring briefings, or deferred work.",
    parameters: scheduleParams,
    execute: async (_id, params) => {
      if (!params.at === !params.cron) {
        throw new Error("Provide exactly one of `at` (one-shot) or `cron` (recurring)");
      }
      const spec = params.at
        ? ({ type: "once", at: new Date(params.at).toISOString() } as const)
        : ({ type: "cron", expr: params.cron! } as const);
      const row = getScheduler().create({
        label: params.label,
        prompt: params.prompt,
        spec,
        targetSessionId: params.target === "new_session" ? null : sessionId,
      });
      return {
        content: [
          {
            type: "text",
            text: `Scheduled ${row.id} ("${row.label}"): ${row.spec.type === "once" ? `fires once at ${row.nextFireAt}` : `recurring, next fire ${row.nextFireAt}`}.`,
          },
        ],
        details: { scheduleId: row.id },
      };
    },
  };

  const listSchedules: AgentTool<any> = {
    name: "list_schedules",
    label: "List schedules",
    description: "List all schedules with their status and next fire time.",
    parameters: Type.Object({}),
    execute: async () => {
      const rows = getScheduler().list();
      return {
        content: [
          { type: "text", text: rows.length ? rows.map(describeRow).join("\n") : "(no schedules)" },
        ],
        details: { count: rows.length },
      };
    },
  };

  const cancelSchedule: AgentTool<typeof scheduleIdParams> = {
    name: "cancel_schedule",
    label: "Cancel schedule",
    description: "Cancel an active schedule by id.",
    parameters: scheduleIdParams,
    execute: async (_id, params) => {
      const ok = getScheduler().cancel(params.scheduleId);
      return {
        content: [
          { type: "text", text: ok ? `Cancelled schedule ${params.scheduleId}.` : `Schedule ${params.scheduleId} is not active (unknown, completed, or already cancelled).` },
        ],
        details: { cancelled: ok },
      };
    },
  };

  return [schedule, listSchedules, cancelSchedule];
}
```

Note on `new Date(params.at).toISOString()`: normalizes any ISO-8601 offset to UTC; invalid dates produce `Invalid Date` whose `toISOString()` throws — which is the desired tool-call failure. The future-check lives in `SchedulerService.create`.

- [ ] **Step 2: Prompt guidance**

In `server/src/persona.ts` `composeSystemPrompt` Tool guidance section, after the delegate line add:

```
- Use the schedule tool for reminders and recurring jobs ("remind me tomorrow at 9", "every weekday morning"). The prompt you schedule arrives back as a [Scheduled task ...] message — write it so your future self can act without this conversation's context.
```

- [ ] **Step 3: Boot wiring**

In `server/src/index.ts`:

```ts
import { SchedulerService } from "./scheduler.ts";
import { ScheduleStore } from "./schedules.ts";
import { createSchedulingTools } from "./tools/scheduling.ts";
```

Change the `sessionTools` line to provide both tool sets:

```ts
  sessionTools: (sessionId) => [
    ...createDelegationTools(() => taskManager, sessionId),
    ...createSchedulingTools(() => scheduler, sessionId),
  ],
```

declare `let scheduler!: SchedulerService;` next to the taskManager declaration, and construct it after `taskManager`:

```ts
scheduler = new SchedulerService({
  store: new ScheduleStore(path.join(config.dataDir, "schedules")),
  indexer,
  bus,
  inject: (sessionId, text) => manager.injectMessage(sessionId, text),
  createTargetSession: async (label) => {
    const row = await manager.createSession();
    await manager.rename(row.id, label);
    return row.id;
  },
});
```

Extend the boot sequence (after `taskManager.recoverInterrupted()`):

```ts
await scheduler.rebuildIndex();
await scheduler.catchUp();
scheduler.start();
```

Also in THIS task (so every commit compiles): add `scheduler: SchedulerService;` to `AppDeps` in `server/src/server.ts` (with `import type { SchedulerService } from "./scheduler.ts";`), pass `scheduler` in `createApp({...})` from index.ts, and add `scheduler: made.scheduler` to the createApp deps in `server/test/api.test.ts` and `server/test/ws.test.ts`. The routes that USE it come in Task 4.

- [ ] **Step 4: Helpers**

`server/test/helpers.ts`: import `SchedulerService`/`ScheduleStore`, construct after taskManager:

```ts
  const scheduler = new SchedulerService({
    store: new ScheduleStore(join(dataDir, "schedules")),
    indexer,
    bus,
    inject: (sessionId, text) => manager.injectMessage(sessionId, text),
    createTargetSession: async (label) => {
      const row = await manager.createSession();
      await manager.rename(row.id, label);
      return row.id;
    },
  });
  return { manager, taskManager, scheduler, indexer, bus, dataDir };
```

Add `scheduler: made.scheduler` to the createApp deps in `server/test/api.test.ts` and `server/test/ws.test.ts`.

- [ ] **Step 5: Integration test**

`server/test/scheduling-tools.test.ts` — a chat turn schedules a one-shot; a manual `tick()` with an advanced clock fires it; the assistant takes a turn on the injection. Routing faux factory (parent and injection turns share the queue):

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { EventBus } from "../src/events.ts";
import { Indexer } from "../src/indexer.ts";
import { AgentManager } from "../src/manager.ts";
import { PersonaStore } from "../src/persona.ts";
import { PiAuthStore } from "../src/pi-auth.ts";
import { SchedulerService } from "../src/scheduler.ts";
import { ScheduleStore } from "../src/schedules.ts";
import { createSchedulingTools } from "../src/tools/scheduling.ts";

let faux: ReturnType<typeof registerFauxProvider>;
beforeEach(() => {
  faux = registerFauxProvider();
});
afterEach(() => faux.unregister());

function routingResponse(fireAtIso: string) {
  return (context: any) => {
    const messages = context.messages ?? [];
    const last = messages[messages.length - 1];
    const lastText = Array.isArray(last?.content)
      ? last.content.map((c: any) => c.text ?? "").join("")
      : String(last?.content ?? "");
    if (last?.role === "toolResult") {
      return fauxAssistantMessage("Scheduled! I'll handle it then.");
    }
    if (lastText.includes('[Scheduled task "water plants"]')) {
      return fauxAssistantMessage("It's time: water the plants now!");
    }
    return fauxAssistantMessage([
      fauxToolCall("schedule", {
        prompt: "tell the user to water the plants",
        label: "water plants",
        at: fireAtIso,
      }),
    ]);
  };
}

test("full scheduling loop: chat turn → schedule → tick fires → assistant acts", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "schedtools-"));
  const indexer = new Indexer(join(dataDir, "index.db"));
  const bus = new EventBus();
  const fauxModel = faux.getModel() as any;
  let now = new Date("2026-06-09T10:00:00.000Z");

  let scheduler!: SchedulerService;
  const manager = new AgentManager({
    dataDir,
    indexer,
    bus,
    persona: new PersonaStore(join(dataDir, "persona")),
    resolveModel: () => fauxModel,
    defaultModel: "faux/faux",
    tools: [],
    sessionTools: (sessionId) => createSchedulingTools(() => scheduler, sessionId),
    generateTitles: false,
    authStore: new PiAuthStore(join(dataDir, "no-auth.json")),
  });
  scheduler = new SchedulerService({
    store: new ScheduleStore(join(dataDir, "schedules")),
    indexer,
    bus,
    now: () => now,
    inject: (sessionId, text) => manager.injectMessage(sessionId, text),
    createTargetSession: async (label) => (await manager.createSession()).id,
  });

  const fireAt = "2026-06-09T11:00:00.000Z";
  faux.setResponses(Array.from({ length: 6 }, () => routingResponse(fireAt)));

  const row = await manager.createSession();
  await manager.sendMessage(row.id, "schedule a reminder to water the plants at 11am");
  await manager.waitForIdle(row.id);

  const sched = indexer.listSchedules();
  expect(sched).toHaveLength(1);
  expect(sched[0]).toMatchObject({ label: "water plants", enabled: true, targetSessionId: row.id });

  // advance the clock past the fire time and tick
  now = new Date("2026-06-09T11:00:30.000Z");
  await scheduler.tick();
  await manager.waitForIdle(row.id);

  const messages = (await manager.getMessages(row.id)) as any[];
  const userTexts = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content.map((c: any) => c.text ?? "").join(""));
  expect(userTexts.some((t) => t.includes('[Scheduled task "water plants"]'))).toBe(true);
  const assistantTexts = messages
    .filter((m) => m.role === "assistant")
    .map((m) => JSON.stringify(m.content));
  expect(assistantTexts.some((t) => t.includes("water the plants now"))).toBe(true);
  expect(indexer.listSchedules()[0]).toMatchObject({ enabled: false, firedCount: 1 });
}, 20_000);
```

- [ ] **Step 6: Full suite** — `npm test && npm run check` (80 + 1 = 81 tests).

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: schedule tools wired end to end"
```

---

### Task 4: REST endpoints + Settings UI section

**Files:**
- Modify: `server/src/server.ts`, `server/test/api.test.ts`
- Modify: `web/src/lib/types.ts`, `web/src/lib/api.ts`, `web/src/components/Settings.tsx`

- [ ] **Step 1: Failing API test**

Add to `server/test/api.test.ts`:

```ts
describe("schedules api", () => {
  test("list and cancel", async () => {
    const row = deps.scheduler.create({
      label: "api sched",
      prompt: "p",
      spec: { type: "once", at: new Date(Date.now() + 3_600_000).toISOString() },
      targetSessionId: null,
    });

    const list = (await (await app.request("/api/schedules", { headers: auth })).json()) as any;
    expect(list.schedules).toHaveLength(1);
    expect(list.schedules[0]).toMatchObject({ id: row.id, label: "api sched", enabled: true });

    const del = await app.request(`/api/schedules/${row.id}`, { method: "DELETE", headers: auth });
    expect(del.status).toBe(200);
    const after = (await (await app.request("/api/schedules", { headers: auth })).json()) as any;
    expect(after.schedules[0]).toMatchObject({ cancelled: true });

    expect((await app.request(`/api/schedules/${row.id}`, { method: "DELETE", headers: auth })).status).toBe(409);
    expect((await app.request("/api/schedules/nope", { method: "DELETE", headers: auth })).status).toBe(409);
  });
});
```

(`deps.scheduler` exists once AppDeps gained it in Task 3.)

- [ ] **Step 2: Implement routes** in `server/src/server.ts` (after the tasks routes):

```ts
  app.get("/api/schedules", (c) => c.json({ schedules: indexer.listSchedules() }));

  app.delete("/api/schedules/:id", (c) => {
    const ok = deps.scheduler.cancel(c.req.param("id"));
    if (!ok) return c.json({ error: "not cancellable" }, 409);
    return c.json({ ok: true });
  });
```

Run: `npm test` → 82 tests green.

- [ ] **Step 3: Web types + client**

`web/src/lib/types.ts`:

```ts
export type ScheduleSpec = { type: "once"; at: string } | { type: "cron"; expr: string };

export interface ScheduleRow {
  id: string;
  label: string;
  prompt: string;
  spec: ScheduleSpec;
  targetSessionId: string | null;
  enabled: boolean;
  cancelled: boolean;
  createdAt: string;
  lastFiredAt: string | null;
  nextFireAt: string | null;
  firedCount: number;
}
```

and extend `ServerEvent` with `| { type: "schedule"; schedule: ScheduleRow }`. (`useApp.onEvent` needs no change — unknown event types for the current UI simply fall through the agent branch guard; verify the first `if` chain doesn't crash on it: the `schedule` event has no `sessionId`, so add an early return alongside the task branch:)

In `web/src/useApp.ts` `onEvent`, next to the task branch:

```ts
    if (event.type === "schedule") return; // Settings refetches on open
```

`web/src/lib/api.ts`:

```ts
  listSchedules: () => api<{ schedules: ScheduleRow[] }>("/api/schedules"),
  cancelSchedule: (id: string) => api<{ ok: true }>(`/api/schedules/${id}`, { method: "DELETE" }),
```

(add `ScheduleRow` to the type import).

- [ ] **Step 4: Settings section**

In `web/src/components/Settings.tsx`: add state + fetch on open and a Schedules block after the model section.

```tsx
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
```

(add `ScheduleRow` to the types import). In the `useEffect` that runs on open:

```tsx
    void client.listSchedules().then((r) => setSchedules(r.schedules));
```

Add a handler and the section JSX:

```tsx
  async function cancelSchedule(id: string) {
    await client.cancelSchedule(id);
    const r = await client.listSchedules();
    setSchedules(r.schedules);
  }
```

```tsx
          <div>
            <h3 className="mb-1 text-sm font-medium">Schedules</h3>
            {schedules.length === 0 ? (
              <p className="text-sm text-neutral-500">No schedules. Ask the assistant to remind you about something.</p>
            ) : (
              <ul className="space-y-1">
                {schedules.map((s) => (
                  <li key={s.id} className="flex items-center gap-2 rounded-md border border-neutral-800 p-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="truncate font-medium">{s.label}</span>
                        <span className="text-xs text-neutral-500">
                          {s.spec.type === "once" ? "once" : s.spec.expr}
                          {s.cancelled
                            ? " · cancelled"
                            : s.enabled
                              ? ` · next ${s.nextFireAt ? new Date(s.nextFireAt).toLocaleString() : "—"}`
                              : " · completed"}
                        </span>
                      </div>
                      <p className="truncate text-xs text-neutral-500">{s.prompt}</p>
                    </div>
                    {s.enabled && (
                      <Button variant="outline" size="sm" onClick={() => void cancelSchedule(s.id)}>
                        Cancel
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
```

- [ ] **Step 5: Build + suite**

```bash
cd web && npm run build && cd ../server && npm test
```

82 tests, clean build.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: schedules REST endpoints and settings UI"
```

---

### Task 5: README + live end-to-end verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README** — feature line under the intro: `It can also schedule reminders and recurring jobs that wake it up (cron times are server-local).` No new env vars (tick interval is fixed at 30s).

- [ ] **Step 2: Gates** — `cd /home/bjk/projects/ytsejam && npm test && npm run check && npm run build && git status --short` (82 tests).

- [ ] **Step 3: Live e2e (real model)**

```bash
cd server
YTSEJAM_AUTH_TOKEN=dev YTSEJAM_DATA_DIR=/tmp/ytsejam-p4 YTSEJAM_PORT=3228 YTSEJAM_GENERATE_TITLES=false node src/index.ts > /tmp/p4-e2e.log 2>&1 &
```

Via REST (or browser): create a session; send "schedule a reminder for 2 minutes from now: tell me to stretch. Also create a recurring schedule: every minute, append the current time to /tmp/p4-tick.txt using bash" (cron `* * * * *`). Verify:
- both schedules appear in GET /api/schedules with sane nextFireAt
- within ~2.5 minutes the one-shot fires: the session transcript gains `[Scheduled task ...]` + an assistant turn; the schedule flips to completed (enabled false, firedCount 1)
- the recurring schedule fires at least twice (firedCount ≥ 2, /tmp/p4-tick.txt has ≥2 lines via the assistant's bash tool)
- cancel the recurring one via DELETE /api/schedules/:id → 200, no further fires for 90s
- restart test: create a one-shot 60s out, kill the server immediately, wait 90s, restart → catch-up fires it once on boot (transcript shows the injection; firedCount 1)

Kill the server; clean up /tmp/p4-tick.txt.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: scheduler feature note in README"
```

---

## Spec coverage map (phase 4 slice)

| Spec requirement | Task |
| --- | --- |
| `schedule` tool: one-shot (`at`) and recurring (cron) | 3 |
| `list_schedules` / `cancel_schedule` tools | 3 |
| Definitions + firing events in `schedules.jsonl` (SSOT) | 1 |
| sqlite schedules table (id, spec, target, prompt, enabled, last/next fire) | 1 |
| In-process loop checking due jobs every ~30s | 2 (tick/start) |
| Startup catch-up: missed one-shots fire once; missed recurring → next occurrence | 2 (catchUp) |
| Firing injects message via the same follow-up mechanism as task completion | 2 (inject → injectMessage) |
| Jobs target originating session or a dedicated session | 3 (target param) / 2 (createTargetSession) |
| Schedules list in Settings UI | 4 |
| Scheduler wakes the assistant (turn on fire) | 3 (integration test), 5 (live) |
