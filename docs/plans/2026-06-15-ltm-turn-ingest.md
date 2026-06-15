# LTM turn ingest + housekeeping consolidation + history backfill

> Execute with the `develop` skill, task-by-task.

**Goal:** Wire LTM turn ingestion on `agent_end`, LTM consolidation into `/housekeeping`, and a rate-limited backfill endpoint + CLI for 30 days of existing session history. Defer the read-side (`composeContext` in system prompt) to a Friday 2026-06-19 review against real data.

**Spec:** [docs/plans/2026-06-15-ltm-turn-ingest-design.md](./2026-06-15-ltm-turn-ingest-design.md)

**Architecture:** Two fire-and-forget hooks at existing `agent_end` handlers (chat + subagent) call `ltm.ingestSessionFile(sessionPath)`. A new `memory.consolidateLtm()` is invoked from the `/housekeeping` skill alongside existing cog housekeeping. Backfill is a server-owned `BackfillJob` (single concurrent instance, persists progress via LTM's own `ingest-state.json`) exposed through Bearer-auth admin HTTP routes, driven by a `ytsejam ltm backfill` CLI subcommand that polls progress and handles SIGINT cancellation.

**Tech Stack:** TypeScript, Node ≥22.6 (native TS stripping), Vitest + node:test, existing pi-agent-core `agent_end` event, existing Bearer auth pattern from PR #189, existing LTM `MemorySystem` API surface (`ingestSessionFile`, `ingestSessionDir`, `consolidate`).

**Worktree:** /tmp/ltm-turn-ingest

**Branch:** feat/ltm-turn-ingest

---

## Task 0: Surface session path to manager + task-manager

**Why first:** T1 and T2 need a way to resolve a session id to its on-disk JSONL path. Today `manager.ts` doesn't expose this — pi-agent-core owns the path. Need a stable resolver passed in via opts so the `agent_end` hook can hand the path to `ltm.ingestSessionFile`.

**Files:**
- Modify: `server/src/manager.ts` (constructor opts + `agent_end` handler region around line 362)
- Modify: `server/src/task-manager.ts` (constructor opts + `agent_end` handler region around line 282)
- Modify: `server/src/index.ts` (boot wiring — pass the resolver fn)
- Test: `server/test/manager-session-path.test.ts` (NEW — assert the resolver is invoked at `agent_end` with the right session id)

### Step 1: Find the existing pi-agent-core session path

Run: `grep -n "appendSessionName\|session\." server/src/manager.ts | head -10`
Expected: identify the `opened.session` object and which method returns its on-disk path.

### Step 2: Confirm pi-agent-core surface for session path

Run: `grep -rn "filePath\|sessionPath\|filename" node_modules/@earendil-works/pi-agent-core/dist/harness/session/*.d.ts | head -10`
Expected: a public accessor like `session.filePath` or `session.path`.

### Step 3: Write the failing test

Create `server/test/manager-session-path.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
// import the MemorySession + Manager construction shape used in existing manager tests
import { createTestManager } from "./helpers.ts";

describe("manager: resolveSessionPath on agent_end", () => {
  it("invokes the LTM ingest hook with the session's on-disk JSONL path", async () => {
    const calls: string[] = [];
    const manager = await createTestManager({
      ltm: {
        ingestSessionFile: async (p: string) => {
          calls.push(p);
          return { sessionsSeen: 1, turnsIngested: 0, recordsCreated: 0, warnings: [] };
        },
      },
    });
    const { id } = await manager.open({ /* minimal */ });
    await manager.simulateAgentEnd(id);
    // give the setTimeout(0) one tick
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1);
    assert.match(calls[0], /sessions\/.*\.jsonl$/);
  });
});
```

### Step 4: Run test to verify it fails
Run: `cd /tmp/ltm-turn-ingest && npm test --workspace=server -- manager-session-path`
Expected: FAIL (the hook doesn't exist yet).

### Step 5: Add the constructor opt + invoke in agent_end

In `server/src/manager.ts`:
- Add to `ManagerOptions` interface: `ltm?: { ingestSessionFile(p: string): Promise<unknown> }`
- In the `agent_end` handler (around line 386, after the existing `maybeGenerateTitle` `setTimeout`), append:
```ts
const ltmRef = this.opts.ltm;
if (ltmRef) {
  setTimeout(() => {
    const sessionPath = opened.session.filePath; // adjust based on Step 2 finding
    if (!sessionPath) return;
    ltmRef.ingestSessionFile(sessionPath).catch((err) => {
      console.error(`ltm ingest failed for ${opened.id}`, err);
    });
  }, 0);
}
```

### Step 6: Run test to verify it passes
Run: `cd /tmp/ltm-turn-ingest && npm test --workspace=server -- manager-session-path`
Expected: PASS.

### Step 7: Commit
```bash
git add server/src/manager.ts server/test/manager-session-path.test.ts
git commit -m "feat(manager): LTM ingest hook on agent_end (chat sessions)"
```

---

## Task 1: Same hook for task-manager (subagent sessions)

**Files:**
- Modify: `server/src/task-manager.ts` (`agent_end` region around line 282)
- Test: `server/test/task-manager-ltm-ingest.test.ts` (NEW)

### Step 1: Find the task-manager agent_end handler

Run: `grep -n "agent_end" server/src/task-manager.ts`
Expected: ~line 282 + ~line 527 (one orchestrator, one comment).

### Step 2: Write the failing test (mirror Task 0's shape)

Create `server/test/task-manager-ltm-ingest.test.ts` modeled on the Task 0 test but for task-manager.

### Step 3: Run to confirm fail
Run: `cd /tmp/ltm-turn-ingest && npm test --workspace=server -- task-manager-ltm-ingest`
Expected: FAIL.

### Step 4: Add the same hook shape to task-manager `agent_end`
Mirror the Task 0 code pattern. Same `setTimeout(0)` fire-and-forget.

### Step 5: Run to confirm pass
Run: `cd /tmp/ltm-turn-ingest && npm test --workspace=server -- task-manager-ltm-ingest`
Expected: PASS.

### Step 6: Commit
```bash
git add server/src/task-manager.ts server/test/task-manager-ltm-ingest.test.ts
git commit -m "feat(task-manager): LTM ingest hook on agent_end (subagent sessions)"
```

---

## Task 2: Wire the LTM ref through boot

**Files:**
- Modify: `server/src/index.ts` (where `manager` and `taskManager` are constructed; LTM is already initialized — just pass the ref)

### Step 1: Find the boot wiring

Run: `grep -n "new ManagerImpl\|new TaskManager\|memory.attachLtm" server/src/index.ts`
Expected: ~lines 188 (attachLtm), construction sites for both managers.

### Step 2: Pass the LTM ref to both constructors

Add `ltm` to both `ManagerOptions` and `TaskManagerOptions` passed at construction time. The ref is the same `ltm` variable already in scope after `memory.attachLtm(ltm)` at line 188.

### Step 3: Confirm boot test still passes
Run: `cd /tmp/ltm-turn-ingest && npm test --workspace=server -- boot`
Expected: PASS (any existing boot tests still green).

### Step 4: Commit
```bash
git add server/src/index.ts
git commit -m "feat(server): wire LTM ref into manager + task-manager"
```

---

## Task 3: `memory.consolidateLtm()` + housekeeping skill wire-in

**Files:**
- Modify: `server/src/memory/index.ts` (add `consolidateLtm` export)
- Modify: `server/src/tools/cog.ts` (add RPC method `consolidate_ltm` if RPC list applies, OR direct method exposure)
- Test: `server/test/memory-consolidate-ltm.test.ts` (NEW)
- Modify: housekeeping skill file (find its location first via `find ~/.ytsejam/data/skills -name "SKILL.md" -path "*housekeeping*"`)

### Step 1: Read the existing housekeeping skill

Run: `find ~/.ytsejam/data/skills -name "SKILL.md" -path "*housekeeping*" -exec cat {} \;`
Expected: see where existing housekeeping flow calls cog rpcs; identify the insertion point.

### Step 2: Write the failing test for `consolidateLtm`

Create `server/test/memory-consolidate-ltm.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as memory from "../src/memory/index.ts";

describe("memory.consolidateLtm()", () => {
  it("returns null when no LTM is attached", async () => {
    memory.attachLtm(null);
    const result = await memory.consolidateLtm();
    assert.equal(result, null);
  });
  it("returns {created, folded} when LTM is attached", async () => {
    const fakeLtm = {
      consolidate: async () => ({ created: 2, folded: 5 }),
      // plus the other shape attachLtm checks
    };
    memory.attachLtm(fakeLtm as never);
    const result = await memory.consolidateLtm();
    assert.deepEqual(result, { created: 2, folded: 5 });
    memory.attachLtm(null);
  });
});
```

### Step 3: Run to confirm fail
Run: `cd /tmp/ltm-turn-ingest && npm test --workspace=server -- memory-consolidate-ltm`
Expected: FAIL (export doesn't exist).

### Step 4: Add `consolidateLtm` to `server/src/memory/index.ts`

```ts
export async function consolidateLtm(): Promise<{ created: number; folded: number } | null> {
  if (!attachedLtm) return null;
  return attachedLtm.consolidate();
}
```

### Step 5: Run to confirm pass
Run: `cd /tmp/ltm-turn-ingest && npm test --workspace=server -- memory-consolidate-ltm`
Expected: PASS.

### Step 6: Expose as an RPC + update the housekeeping skill

- Add `"consolidate_ltm"` to the RPC method enum in `server/src/tools/cog.ts` (consult the existing list, line ~28).
- Dispatch handler: `"consolidate_ltm": () => memory.consolidateLtm()`
- Edit the housekeeping skill SKILL.md (path from Step 1) to add: after the existing `cog_rpc("housekeeping_scan")` step, a new line calling `cog_rpc("consolidate_ltm")` with a brief comment "fold old turn-records into per-session summaries (LTM)."

### Step 7: Commit
```bash
git add server/src/memory/index.ts server/src/tools/cog.ts server/test/memory-consolidate-ltm.test.ts
git commit -m "feat(memory): consolidateLtm() + RPC method for /housekeeping"

# skill file commit lives in the data dir, NOT the repo — note it but don't try to git-add
echo "Skill SKILL.md updated in ~/.ytsejam/data/skills — synced to repo by deploy/sync-skills.sh"
```

(Skills live in the user data dir, not the repo source — the sync flow handles that direction.)

---

## Task 4: BackfillJob class + tests

**Files:**
- Create: `server/src/memory/bridge/backfill-job.ts`
- Test: `server/test/backfill-job.test.ts` (NEW)

### Step 1: Write the failing test for BackfillJob

Create `server/test/backfill-job.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { BackfillJob } from "../src/memory/bridge/backfill-job.ts";

describe("BackfillJob", () => {
  it("processes files in order, respects per-batch pause, reports progress", async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-test-"));
    // fixture: 3 fake pi v3 session JSONLs
    for (let i = 0; i < 3; i++) {
      const sid = `019eb000-0000-7000-0000-00000000000${i}`;
      fs.writeFileSync(
        path.join(tmpdir, `2026-06-10T00-00-00-000Z_${sid}.jsonl`),
        JSON.stringify({ type: "session", version: 3, id: sid, timestamp: "2026-06-10T00:00:00.000Z", cwd: "chat" }) + "\n"
      );
    }
    const progressLog: number[] = [];
    const fakeLtm = {
      ingestSessionFile: async () => ({ sessionsSeen: 1, turnsIngested: 5, recordsCreated: 5, warnings: [] }),
    };
    const job = new BackfillJob({ ltm: fakeLtm as never, dir: tmpdir, ratePerSec: 100, batchSize: 2, pauseMs: 50,
      onProgress: (s) => progressLog.push(s.processed) });
    await job.run();
    assert.equal(job.status, "done");
    assert.equal(job.processed, 3);
    assert.ok(progressLog.length >= 3);
  });

  it("honors cancellation between files", async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-cancel-"));
    for (let i = 0; i < 5; i++) {
      const sid = `019eb000-0000-7000-0000-00000000000${i}`;
      fs.writeFileSync(
        path.join(tmpdir, `2026-06-10T00-00-00-000Z_${sid}.jsonl`),
        JSON.stringify({ type: "session", version: 3, id: sid, timestamp: "2026-06-10T00:00:00.000Z", cwd: "chat" }) + "\n"
      );
    }
    const fakeLtm = {
      ingestSessionFile: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { sessionsSeen: 1, turnsIngested: 1, recordsCreated: 1, warnings: [] };
      },
    };
    const job = new BackfillJob({ ltm: fakeLtm as never, dir: tmpdir, ratePerSec: 50, batchSize: 10, pauseMs: 0 });
    const runP = job.run();
    setTimeout(() => job.cancel(), 30);
    await runP;
    assert.equal(job.status, "cancelled");
    assert.ok(job.processed < 5);
  });

  it("aggregates warnings from per-file failures and keeps going", async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-warn-"));
    for (let i = 0; i < 3; i++) {
      const sid = `019eb000-0000-7000-0000-00000000000${i}`;
      fs.writeFileSync(
        path.join(tmpdir, `2026-06-10T00-00-00-000Z_${sid}.jsonl`),
        JSON.stringify({ type: "session", version: 3, id: sid, timestamp: "2026-06-10T00:00:00.000Z", cwd: "chat" }) + "\n"
      );
    }
    let n = 0;
    const fakeLtm = {
      ingestSessionFile: async () => {
        n++;
        if (n === 2) throw new Error("simulated ingest fail");
        return { sessionsSeen: 1, turnsIngested: 1, recordsCreated: 1, warnings: [] };
      },
    };
    const job = new BackfillJob({ ltm: fakeLtm as never, dir: tmpdir, ratePerSec: 100, batchSize: 10, pauseMs: 0 });
    await job.run();
    assert.equal(job.status, "done");
    assert.equal(job.processed, 3);
    assert.ok(job.warnings.some((w) => w.includes("simulated ingest fail")));
  });
});
```

### Step 2: Run to confirm fail
Run: `cd /tmp/ltm-turn-ingest && npm test --workspace=server -- backfill-job`
Expected: FAIL (file doesn't exist).

### Step 3: Implement BackfillJob

Create `server/src/memory/bridge/backfill-job.ts`:

```ts
import fs from "node:fs";
import path from "node:path";

export interface BackfillJobOptions {
  ltm: { ingestSessionFile(p: string): Promise<{ sessionsSeen: number; turnsIngested: number; recordsCreated: number; warnings: string[] }> };
  dir: string;
  ratePerSec: number;
  batchSize: number;
  pauseMs: number;
  onProgress?: (s: { processed: number; total: number; lastSessionId?: string }) => void;
}

export type BackfillStatus = "pending" | "running" | "done" | "cancelled" | "failed";

export class BackfillJob {
  readonly id: string;
  status: BackfillStatus = "pending";
  processed = 0;
  total = 0;
  lastSessionId: string | undefined;
  warnings: string[] = [];
  private cancelled = false;

  constructor(private readonly opts: BackfillJobOptions) {
    this.id = `backfill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  cancel(): void {
    this.cancelled = true;
  }

  async run(): Promise<void> {
    this.status = "running";
    let files: string[];
    try {
      files = listJsonlFiles(this.opts.dir);
    } catch (err) {
      this.status = "failed";
      this.warnings.push((err as Error).message);
      return;
    }
    this.total = files.length;
    let batchCount = 0;
    for (const file of files) {
      if (this.cancelled) {
        this.status = "cancelled";
        return;
      }
      try {
        const report = await this.opts.ltm.ingestSessionFile(file);
        this.processed++;
        this.lastSessionId = path.basename(file);
        for (const w of report.warnings) this.warnings.push(`${path.basename(file)}: ${w}`);
        this.opts.onProgress?.({ processed: this.processed, total: this.total, lastSessionId: this.lastSessionId });
        // per-turn pacing: ratePerSec applies to turns ingested
        if (report.turnsIngested > 0 && this.opts.ratePerSec > 0) {
          const delayMs = (report.turnsIngested * 1000) / this.opts.ratePerSec;
          if (delayMs > 0) await sleep(delayMs);
        }
      } catch (err) {
        this.warnings.push(`${path.basename(file)}: ${(err as Error).message}`);
      }
      batchCount++;
      if (batchCount >= this.opts.batchSize) {
        batchCount = 0;
        if (this.opts.pauseMs > 0) await sleep(this.opts.pauseMs);
      }
    }
    this.status = "done";
  }
}

function listJsonlFiles(dir: string): string[] {
  // recursive (sessions/--chat--/<file>.jsonl)
  const out: string[] = [];
  const walk = (d: string) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && ent.name.endsWith(".jsonl") && !ent.name.endsWith(".compactions.jsonl")) {
        out.push(p);
      }
    }
  };
  walk(dir);
  return out.sort();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
```

### Step 4: Run to confirm pass
Run: `cd /tmp/ltm-turn-ingest && npm test --workspace=server -- backfill-job`
Expected: PASS (all three test cases).

### Step 5: Commit
```bash
git add server/src/memory/bridge/backfill-job.ts server/test/backfill-job.test.ts
git commit -m "feat(memory): BackfillJob for rate-limited LTM history ingestion"
```

---

## Task 5: Admin HTTP routes for backfill (POST + GET + DELETE)

**Files:**
- Modify: `server/src/server.ts` (add three routes)
- Test: `server/test/backfill-routes.test.ts` (NEW — exercise route shape, auth, 409 on concurrent POST)

### Step 1: Find the existing Bearer auth pattern

Run: `grep -n "regenerate-title\|Bearer\|YTSEJAM_API_TOKEN\|requireAuth" server/src/server.ts | head -10`
Expected: identify the middleware/check used for `/api/regenerate-title` (PR #189 added it).

### Step 2: Write the failing test

Create `server/test/backfill-routes.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
// reuse the existing server test harness pattern (find via existing test imports)
import { createTestServer } from "./helpers.ts";

describe("admin backfill routes", () => {
  it("POST /api/admin/ltm-backfill requires Bearer auth", async () => {
    const { url } = await createTestServer();
    const res = await fetch(`${url}/api/admin/ltm-backfill`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    assert.equal(res.status, 401);
  });
  it("POST returns 503 when LTM is not attached", async () => {
    const { url, token } = await createTestServer({ ltm: null });
    const res = await fetch(`${url}/api/admin/ltm-backfill`, { method: "POST", body: JSON.stringify({ dir: "/tmp" }), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
    assert.equal(res.status, 503);
  });
  it("POST returns 200 with jobId; GET returns progress; DELETE cancels", async () => {
    const { url, token } = await createTestServer({ ltm: fakeLtm() });
    const postRes = await fetch(`${url}/api/admin/ltm-backfill`, { method: "POST", body: JSON.stringify({ dir: fakeFixtureDir(), ratePerSec: 100, batchSize: 10, pauseMs: 0 }), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
    assert.equal(postRes.status, 200);
    const { jobId } = await postRes.json();
    assert.match(jobId, /^backfill-/);
    const getRes = await fetch(`${url}/api/admin/ltm-backfill/${jobId}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(getRes.status, 200);
    const progress = await getRes.json();
    assert.equal(typeof progress.processed, "number");
    const delRes = await fetch(`${url}/api/admin/ltm-backfill/${jobId}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
    assert.ok(delRes.ok);
  });
  it("POST returns 409 when a job is already running", async () => {
    const { url, token } = await createTestServer({ ltm: fakeLtm({ slow: true }) });
    const first = await fetch(`${url}/api/admin/ltm-backfill`, { method: "POST", body: JSON.stringify({ dir: fakeFixtureDir() }), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
    assert.equal(first.status, 200);
    const second = await fetch(`${url}/api/admin/ltm-backfill`, { method: "POST", body: JSON.stringify({ dir: fakeFixtureDir() }), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
    assert.equal(second.status, 409);
  });
});
```

### Step 3: Run to confirm fail
Run: `cd /tmp/ltm-turn-ingest && npm test --workspace=server -- backfill-routes`
Expected: FAIL.

### Step 4: Wire the routes in `server/src/server.ts`

Add a `currentBackfillJob: BackfillJob | null = null` module-level singleton.

Three handlers (sketches; bring in line with the existing route file's idioms):

```ts
// POST /api/admin/ltm-backfill
//   - require Bearer (existing middleware)
//   - 503 if memory.health().ltm absent
//   - 409 if currentBackfillJob && status === "running"
//   - parse body { dir, ratePerSec=2, batchSize=10, pauseMs=2000 }
//   - new BackfillJob({ ltm, dir, ratePerSec, batchSize, pauseMs })
//   - currentBackfillJob = job; void job.run().finally(() => { /* keep around for terminal GET */ });
//   - return { jobId: job.id }

// GET /api/admin/ltm-backfill/:jobId
//   - require Bearer
//   - 404 if !currentBackfillJob || id mismatch
//   - return { jobId, status, processed, total, lastSessionId, warnings }

// DELETE /api/admin/ltm-backfill/:jobId
//   - require Bearer
//   - 404 if missing
//   - job.cancel(); return 204
```

### Step 5: Run to confirm pass
Run: `cd /tmp/ltm-turn-ingest && npm test --workspace=server -- backfill-routes`
Expected: PASS (all four cases).

### Step 6: Commit
```bash
git add server/src/server.ts server/test/backfill-routes.test.ts
git commit -m "feat(server): admin HTTP routes for LTM backfill (POST/GET/DELETE)"
```

---

## Task 6: `ytsejam ltm backfill` CLI subcommand

**Files:**
- Modify: `server/src/cli/ltm-commands.ts` (add `backfill` subcommand)
- Test: `server/test/cli-ltm-backfill.test.ts` (NEW — mock fetch, assert poll + SIGINT semantics)

### Step 1: Read the existing ltm-commands.ts

Run: `cat server/src/cli/ltm-commands.ts | head -60`
Expected: see the existing replay/health subcommand shape.

### Step 2: Write the failing test

Create `server/test/cli-ltm-backfill.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
// import the cli dispatcher
import { runLtmCommand } from "../src/cli/ltm-commands.ts";

describe("ytsejam ltm backfill CLI", () => {
  it("POSTs with rate/batch/pause and polls GET until done", async () => {
    const calls: { method: string; url: string }[] = [];
    let pollCount = 0;
    globalThis.fetch = (async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      calls.push({ method, url });
      if (method === "POST" && url.endsWith("/api/admin/ltm-backfill")) {
        return new Response(JSON.stringify({ jobId: "backfill-abc-123" }), { status: 200 });
      }
      if (method === "GET" && url.includes("/backfill-abc-123")) {
        pollCount++;
        return new Response(JSON.stringify({
          jobId: "backfill-abc-123",
          status: pollCount < 2 ? "running" : "done",
          processed: pollCount,
          total: 2,
          warnings: [],
        }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as never;
    process.env.YTSEJAM_API_TOKEN = "test-token";
    process.env.YTSEJAM_API_URL = "http://test";
    const exit = await runLtmCommand(["backfill", "/tmp/fixture", "--rate=2", "--poll-ms=10"]);
    assert.equal(exit, 0);
    assert.ok(calls.find((c) => c.method === "POST" && c.url.endsWith("/api/admin/ltm-backfill")));
    assert.ok(calls.filter((c) => c.method === "GET").length >= 2);
  });

  it("SIGINT during polling sends DELETE", async () => {
    // wire fetch to return long-running status; after first GET, send SIGINT to process
    // assert a DELETE call was emitted before exit
    // (see test helpers for SIGINT handling — node:test signals work via process.emit)
  });
});
```

### Step 3: Run to confirm fail
Run: `cd /tmp/ltm-turn-ingest && npm test --workspace=server -- cli-ltm-backfill`
Expected: FAIL (subcommand doesn't exist).

### Step 4: Implement the subcommand

In `server/src/cli/ltm-commands.ts`:

```ts
// Add to the subcommand dispatcher:
case "backfill": {
  const dir = rest[0];
  if (!dir) { out("backfill: missing <dir>"); return 2; }
  const rate = Number(values.rate ?? 2);
  const batch = Number(values.batch ?? 10);
  const pauseMs = Number(values["pause-ms"] ?? 2000);
  const pollMs = Number(values["poll-ms"] ?? 5000);
  const token = process.env.YTSEJAM_API_TOKEN;
  if (!token) { out("backfill: YTSEJAM_API_TOKEN not set"); return 2; }
  const baseUrl = process.env.YTSEJAM_API_URL ?? "http://127.0.0.1:9873";
  const postRes = await fetch(`${baseUrl}/api/admin/ltm-backfill`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ dir, ratePerSec: rate, batchSize: batch, pauseMs }),
  });
  if (!postRes.ok) { out(`backfill: POST failed ${postRes.status}: ${await postRes.text()}`); return 1; }
  const { jobId } = await postRes.json() as { jobId: string };
  out(`backfill: started ${jobId} (dir=${dir} rate=${rate}/s batch=${batch} pause=${pauseMs}ms)`);
  let cancelled = false;
  const onSigint = () => {
    if (cancelled) return;
    cancelled = true;
    void fetch(`${baseUrl}/api/admin/ltm-backfill/${jobId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    out("\nbackfill: cancel requested, waiting for terminal status...");
  };
  process.on("SIGINT", onSigint);
  try {
    while (true) {
      await sleep(pollMs);
      const getRes = await fetch(`${baseUrl}/api/admin/ltm-backfill/${jobId}`, { headers: { authorization: `Bearer ${token}` } });
      if (!getRes.ok) { out(`backfill: GET failed ${getRes.status}`); return 1; }
      const s = await getRes.json() as { processed: number; total: number; lastSessionId?: string; status: string; warnings: string[] };
      out(`[${s.processed}/${s.total}] last: ${s.lastSessionId ?? "-"} (${s.warnings.length} warnings) status=${s.status}`);
      if (s.status === "done" || s.status === "cancelled" || s.status === "failed") {
        out(`backfill: ${s.status}. ${s.warnings.length} warnings.`);
        for (const w of s.warnings.slice(0, 10)) out(`  ${w}`);
        return s.status === "done" ? 0 : 1;
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
}
```

### Step 5: Run to confirm pass
Run: `cd /tmp/ltm-turn-ingest && npm test --workspace=server -- cli-ltm-backfill`
Expected: PASS.

### Step 6: Commit
```bash
git add server/src/cli/ltm-commands.ts server/test/cli-ltm-backfill.test.ts
git commit -m "feat(cli): ytsejam ltm backfill subcommand with rate-limit + cancel"
```

---

## Task 7: Update ARCHITECTURE.md integration sketch + main docs

**Files:**
- Modify: `packages/ltm/ARCHITECTURE.md` (cross out shipped bullets, note read-side deferred)
- Modify: `docs/agents/OVERVIEW.md` (if it references LTM integration; check first)

### Step 1: Find current ARCHITECTURE wording

Run: `sed -n '215,250p' packages/ltm/ARCHITECTURE.md`
Expected: see the 4-bullet integration sketch.

### Step 2: Update the sketch in-place

Reshape the 4 bullets to reflect reality:
- Bullet 1 (workspace package): ✅ shipped 2026-06-12
- Bullet 2 (ingest on agent_end): ✅ shipped THIS PR
- Bullet 3 (composeContext in system prompt): ⏸ **deferred** — see `docs/plans/2026-06-15-ltm-turn-ingest-design.md` "Open question parked for Friday 2026-06-19"
- Bullet 4 (consolidate in housekeeping): ✅ shipped THIS PR

### Step 3: Check + update OVERVIEW.md if applicable

Run: `grep -n "LTM\|composeContext\|ingestSession" docs/agents/OVERVIEW.md 2>/dev/null`
Expected: identify any stale claims. Update or remove.

### Step 4: Commit
```bash
git add packages/ltm/ARCHITECTURE.md docs/agents/OVERVIEW.md
git commit -m "docs(ltm): mark integration sketch bullets 2+4 shipped; bullet 3 deferred"
```

---

## Task 8: Gate + push

### Step 1: Run the full gate

Run: `cd /tmp/ltm-turn-ingest && bash scripts/gate.sh`
Expected: PASS. Compare against baseline (158 pass, 0 fail, 0 skipped at branch creation).

### Step 2: Verify no regressions in test count

Note the new test count. Each task added 1 test file. Expected: baseline + ~6 new tests.

### Step 3: Push to origin

```bash
git push -u origin feat/ltm-turn-ingest
```

### Step 4: Open the PR (manual)

PR title: `feat(ltm): turn ingest + housekeeping consolidation + backfill (defers read-side)`

PR body skeleton:
- Summary linking the design doc
- Tasks 0-7 each as a one-line bullet
- "**Defers** the read-side decision (`composeContext` in system prompt) to Friday 2026-06-19 review — see [hot-memory pin](.) and [schedule 019eccc6-35d0]."
- "**Backfill is NOT auto-run by this PR.** After merge + deploy, run `ytsejam ltm backfill ~/.ytsejam/data/sessions` manually. Default `--rate=2` ≈ 5h wall clock; happy to run overnight."

---

## Task 9: After merge — run the backfill (separate session)

**Not a code task — a manual run-it step. Do NOT run inside this PR.**

After PR merges + the next deploy/release cuts over:

```bash
export YTSEJAM_API_TOKEN=<token>
ytsejam ltm backfill ~/.ytsejam/data/sessions --rate=2 --batch=10 --pause-ms=2000
# wall clock ≈ 5h for ~35K turns; fire-and-forget, polls every 5s
```

Then wait for Friday 2026-06-19 16:00 EDT scheduled review (schedule id 019eccc6-35d0-7f41-a7d9-1e86d6faf44d) — that handler dumps the metrics and triggers the read-side decision conversation.

---

## Notes for the develop loop

- **Test infrastructure caveat:** several tasks reference helper files (`server/test/helpers.ts`, `createTestManager`, `createTestServer`) that may or may not exist with the exact signatures used. If a helper is missing or shaped differently, the implementer should adapt the test setup to the existing patterns in `server/test/` rather than creating new harness machinery. Note any adaptations in the per-task report.
- **Bearer auth shape:** PR #189 established the pattern; the exact middleware location is in `server/src/server.ts`. Reuse it as-is — do not invent a new auth mechanism for these admin routes.
- **Concurrency model on the route:** the singleton `currentBackfillJob` lives at module scope in `server/src/server.ts`. This is intentional — at most one backfill at a time per process; respects LTM's single-writer invariant since the route handler runs in the server process that already owns the LTM lock.
- **Pacing math:** at `ratePerSec=2`, a session with 50 turns will pause `(50 * 1000) / 2 = 25000ms = 25s` after its file. This is the *intended* rate-limit. Don't be surprised by the long sleeps in `BackfillJob.run`.
