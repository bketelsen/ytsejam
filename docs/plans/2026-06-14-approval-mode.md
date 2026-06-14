# Per-session Approval Mode Implementation Plan

> Execute with the `develop` skill, task-by-task.

**Goal:** Add a per-session approval mode (YOLO/ASK) with header toggle, per-turn `/yolo` and `/careful` prefixes, inline approval cards for mutating tool calls, 5-minute auto-deny on stale approvals, and a yellow left-rail tint on YOLO sessions.

**Spec:** docs/plans/2026-06-14-approval-mode-design.md

**Architecture:** Approval state lives on the session (default YOLO). Gated tools (`bash`, `write`, `edit`, `delegate`, `schedule`, `cancel_schedule`) get their `execute` wrapped at the AgentManager assembly site to consult the session's effective mode (per-turn override > session toggle). In ASK mode the wrapper emits a WS `approval_request`, awaits a `Promise<decision>`, and either calls through or returns a synthetic denial. Session-level state is stored as a `set_approval_mode` entry in the JSONL session log (new entry type, replayable, sqlite-cacheable in `sessions.approval_mode`). Per-turn overrides come in via a new message field, not persisted as separate state. Subagent inherits YOLO regardless of parent mode (the `delegate` call itself is the gate point).

**Tech Stack:** Node + TypeScript (server), React + Vite (web), better-sqlite3, hono + @hono/node-ws, vitest.

**Worktree:** /home/bjk/projects/.worktrees/approval-mode

**Branch:** feature/approval-mode

---

## Conventions for this plan

- All `Create` paths are relative to repo root.
- All `Modify` references include approximate line numbers from current `main` (commit `e5bacff`); confirm with `grep` if drift suspected.
- Each task ends with a commit. Push happens only at /ship time (or per Brian's ship workflow if intermediate PRs are needed).
- "Run the gate" = `bash scripts/gate.sh`.
- **Baseline:** server 576 pass / 4 todo / 1 skipped, web 124 pass. Every gate run must diff to this. No new failures = OK. Any regression = stop and fix.

---

## Task 1: Schema migration — `sessions.approval_mode`

**Files:**
- Modify: `server/src/indexer.ts` (lines ~136-148, schema definition; also `SCHEMA_VERSION` constant and `upsertSession` query at line ~184)
- Modify: `server/src/indexer.ts` (the `SessionRow` type — wherever it lives)
- Test: `server/test/indexer.test.ts` (new test file if absent; else extend)

### Step 1: Bump SCHEMA_VERSION

Locate `SCHEMA_VERSION` in `server/src/indexer.ts`. Increment by 1. The index is rebuildable, so a version bump triggers `recreateSchema` on next startup — no migration ALTER needed.

### Step 2: Add the column

In `recreateSchema()`, add to the `sessions` CREATE TABLE:

```sql
approval_mode TEXT NOT NULL DEFAULT 'yolo'
```

Add `CHECK(approval_mode IN ('yolo', 'ask'))` immediately after.

### Step 3: Update `SessionRow` type

Add `approvalMode: "yolo" | "ask"` to the `SessionRow` type definition (search `interface SessionRow` or `type SessionRow` in indexer.ts).

### Step 4: Update `upsertSession` query

Add `approval_mode` to the column list, the `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)` placeholder count (was 8, now 9), the `ON CONFLICT DO UPDATE` set list, and the `.run(...)` parameter list.

Order: `id, path, title, created_at, updated_at, preview, unread, archived, approval_mode`.

### Step 5: Write the test

```ts
// server/test/indexer-approval-mode.test.ts (new file)
import { describe, expect, test } from "vitest";
import { createIndexer } from "../src/indexer.ts";

describe("indexer approval_mode column", () => {
  test("new session defaults to yolo", () => {
    const indexer = createIndexer(":memory:");
    indexer.upsertSession({
      id: "s1",
      path: "/tmp/s1.jsonl",
      title: null,
      createdAt: "2026-06-14T00:00:00Z",
      updatedAt: "2026-06-14T00:00:00Z",
      preview: "",
      unread: false,
      archived: false,
      approvalMode: "yolo",
    });
    const rows = indexer.listSessions();
    expect(rows[0]!.approvalMode).toBe("yolo");
  });

  test("ask mode round-trips", () => {
    const indexer = createIndexer(":memory:");
    indexer.upsertSession({
      id: "s2",
      path: "/tmp/s2.jsonl",
      title: null,
      createdAt: "2026-06-14T00:00:00Z",
      updatedAt: "2026-06-14T00:00:00Z",
      preview: "",
      unread: false,
      archived: false,
      approvalMode: "ask",
    });
    expect(indexer.listSessions()[0]!.approvalMode).toBe("ask");
  });

  test("invalid mode rejected by CHECK", () => {
    const indexer = createIndexer(":memory:");
    expect(() =>
      indexer.upsertSession({
        id: "s3",
        path: "/tmp/s3.jsonl",
        title: null,
        createdAt: "2026-06-14T00:00:00Z",
        updatedAt: "2026-06-14T00:00:00Z",
        preview: "",
        unread: false,
        archived: false,
        approvalMode: "bogus" as any,
      }),
    ).toThrow();
  });
});
```

Confirm `createIndexer` signature; adjust import shape if different. The `listSessions` API may need a small extension to return `approvalMode` — handle in the same task.

### Step 6: Run the test to verify

Run: `cd /home/bjk/projects/.worktrees/approval-mode && env -u NODE_ENV npx vitest --run --root server test/indexer-approval-mode.test.ts`
Expected: PASS.

### Step 7: Run full gate

Run: `bash scripts/gate.sh`
Expected: all green, baseline +3 new tests passing.

### Step 8: Commit

```bash
git add server/src/indexer.ts server/test/indexer-approval-mode.test.ts
git commit -m "feat(approval-mode): add approval_mode column to sessions index"
```

---

## Task 2: JSONL session entry — `set_approval_mode`

**Files:**
- Create: `server/src/approval/types.ts`
- Create: `server/src/approval/session-entry.ts`
- Test: `server/test/approval-session-entry.test.ts`

### Step 1: Define the entry shape

```ts
// server/src/approval/types.ts
export type ApprovalMode = "yolo" | "ask";

/**
 * JSONL session entry that persists a per-session approval-mode change.
 * Stored as `type: "set_approval_mode"` in the session's JSONL log.
 * Replayed at session-load time to derive the current mode (last-write-wins).
 */
export interface SetApprovalModeEntry {
  type: "set_approval_mode";
  id: string;            // unique entry id, set by storage
  parentId: string | null;
  timestamp: string;     // ISO
  mode: ApprovalMode;
}

export const APPROVAL_MODE_DEFAULT: ApprovalMode = "yolo";
```

### Step 2: Derive-mode-from-entries helper

```ts
// server/src/approval/session-entry.ts
import type { ApprovalMode } from "./types.ts";
import { APPROVAL_MODE_DEFAULT } from "./types.ts";

/**
 * Walk a session's tree entries newest-first, return the most recent
 * set_approval_mode entry's mode. Default if none found.
 */
export function deriveApprovalMode(entries: ReadonlyArray<{ type: string; mode?: unknown }>): ApprovalMode {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type === "set_approval_mode" && (entry.mode === "yolo" || entry.mode === "ask")) {
      return entry.mode;
    }
  }
  return APPROVAL_MODE_DEFAULT;
}
```

### Step 3: Tests

```ts
// server/test/approval-session-entry.test.ts
import { describe, expect, test } from "vitest";
import { deriveApprovalMode } from "../src/approval/session-entry.ts";

describe("deriveApprovalMode", () => {
  test("empty entries → yolo (default)", () => {
    expect(deriveApprovalMode([])).toBe("yolo");
  });

  test("entries with no set_approval_mode → yolo", () => {
    expect(deriveApprovalMode([{ type: "user_message" }, { type: "tool_call" }])).toBe("yolo");
  });

  test("single set_approval_mode → that mode", () => {
    expect(deriveApprovalMode([{ type: "set_approval_mode", mode: "ask" }])).toBe("ask");
  });

  test("multiple set_approval_mode → newest wins", () => {
    expect(
      deriveApprovalMode([
        { type: "set_approval_mode", mode: "ask" },
        { type: "user_message" },
        { type: "set_approval_mode", mode: "yolo" },
      ]),
    ).toBe("yolo");
  });

  test("malformed mode value → ignored", () => {
    expect(
      deriveApprovalMode([
        { type: "set_approval_mode", mode: "ask" },
        { type: "set_approval_mode", mode: "garbage" },
      ]),
    ).toBe("ask");
  });
});
```

### Step 4: Run tests + gate

Run: `bash scripts/gate.sh`
Expected: PASS, +5 new tests.

### Step 5: Commit

```bash
git add server/src/approval/ server/test/approval-session-entry.test.ts
git commit -m "feat(approval-mode): add set_approval_mode session entry + derivation"
```

---

## Task 3: Per-turn override prefix parser

**Files:**
- Create: `server/src/approval/prefix.ts`
- Test: `server/test/approval-prefix.test.ts`

### Step 1: Implementation

```ts
// server/src/approval/prefix.ts
import type { ApprovalMode } from "./types.ts";

export type TurnOverride = ApprovalMode | null;

/**
 * If `message` starts with `/yolo ` or `/careful ` (case-sensitive, requires
 * trailing whitespace OR end-of-string), strip the prefix and return the
 * implied override. Otherwise return null override + original message.
 *
 * `/yolocowboy` (no whitespace boundary) is NOT a match — passes through.
 * Pure stdlib, no allocations beyond the slice.
 */
export function extractTurnOverride(message: string): { override: TurnOverride; message: string } {
  const match = message.match(/^(\/yolo|\/careful)(\s+|$)/);
  if (!match) return { override: null, message };
  const verb = match[1]!;
  const mode: ApprovalMode = verb === "/yolo" ? "yolo" : "ask";
  // Strip the prefix and the single boundary whitespace char.
  // For `/yolo<EOL>` rest is empty; for `/yolo foo` rest is "foo".
  const rest = message.slice(verb.length).replace(/^\s+/, "");
  return { override: mode, message: rest };
}
```

### Step 2: Tests

```ts
// server/test/approval-prefix.test.ts
import { describe, expect, test } from "vitest";
import { extractTurnOverride } from "../src/approval/prefix.ts";

describe("extractTurnOverride", () => {
  test("no prefix → no override, unchanged message", () => {
    expect(extractTurnOverride("hello world")).toEqual({ override: null, message: "hello world" });
  });

  test("/yolo foo → yolo, foo", () => {
    expect(extractTurnOverride("/yolo foo")).toEqual({ override: "yolo", message: "foo" });
  });

  test("/careful do the thing → ask, do the thing", () => {
    expect(extractTurnOverride("/careful do the thing")).toEqual({ override: "ask", message: "do the thing" });
  });

  test("/yolo with no body → yolo, empty", () => {
    expect(extractTurnOverride("/yolo")).toEqual({ override: "yolo", message: "" });
  });

  test("/yolocowboy → no override (no boundary)", () => {
    expect(extractTurnOverride("/yolocowboy x")).toEqual({ override: null, message: "/yolocowboy x" });
  });

  test("/yolo\\nfoo → yolo, foo (newline counts as boundary)", () => {
    expect(extractTurnOverride("/yolo\nfoo")).toEqual({ override: "yolo", message: "foo" });
  });

  test("leading whitespace before /yolo → no override", () => {
    expect(extractTurnOverride(" /yolo foo")).toEqual({ override: null, message: " /yolo foo" });
  });

  test("/YOLO uppercase → no override (case-sensitive)", () => {
    expect(extractTurnOverride("/YOLO foo")).toEqual({ override: null, message: "/YOLO foo" });
  });
});
```

### Step 3: Run + commit

```bash
bash scripts/gate.sh   # expect +8 tests, all green
git add server/src/approval/prefix.ts server/test/approval-prefix.test.ts
git commit -m "feat(approval-mode): add /yolo and /careful prefix parser"
```

---

## Task 4: Tool gating registry

**Files:**
- Create: `server/src/approval/gated-tools.ts`
- Test: `server/test/approval-gated-tools.test.ts`

### Step 1: Implementation

```ts
// server/src/approval/gated-tools.ts
/**
 * Tools whose execution pauses in ASK mode and surfaces an approval card.
 * Decided in design doc 2026-06-14-approval-mode-design.md.
 *
 * Mutating shell + filesystem + outbound side-effects.
 */
export const GATED_TOOL_NAMES = new Set<string>([
  "bash",
  "write",
  "edit",
  "delegate",
  "schedule",
  "cancel_schedule",
]);

export function isGatedTool(name: string): boolean {
  return GATED_TOOL_NAMES.has(name);
}
```

### Step 2: Test

```ts
// server/test/approval-gated-tools.test.ts
import { describe, expect, test } from "vitest";
import { GATED_TOOL_NAMES, isGatedTool } from "../src/approval/gated-tools.ts";

describe("gated tools registry", () => {
  test("gated set is exactly the design-doc list", () => {
    // Pinning this prevents accidental drift — change requires a deliberate edit.
    expect([...GATED_TOOL_NAMES].sort()).toEqual(
      ["bash", "cancel_schedule", "delegate", "edit", "schedule", "write"],
    );
  });

  test("isGatedTool true for bash, write, edit, delegate, schedule, cancel_schedule", () => {
    for (const name of ["bash", "write", "edit", "delegate", "schedule", "cancel_schedule"]) {
      expect(isGatedTool(name)).toBe(true);
    }
  });

  test("isGatedTool false for read/ls/grep/find/web_*/cancel_task/cog_*/recall", () => {
    for (const name of [
      "read", "ls", "grep", "find",
      "web_search", "web_fetch",
      "cancel_task",
      "cog_read", "cog_write", "cog_append", "cog_patch", "cog_search", "cog_list",
      "recall",
    ]) {
      expect(isGatedTool(name)).toBe(false);
    }
  });
});
```

### Step 3: Run + commit

```bash
bash scripts/gate.sh
git add server/src/approval/gated-tools.ts server/test/approval-gated-tools.test.ts
git commit -m "feat(approval-mode): add gated-tools registry"
```

---

## Task 5: Approval coordinator (in-memory pending-approvals map)

**Files:**
- Create: `server/src/approval/coordinator.ts`
- Test: `server/test/approval-coordinator.test.ts`

### Step 1: Implementation

```ts
// server/src/approval/coordinator.ts
import { randomUUID } from "node:crypto";

export type ApprovalDecision = "approve" | "deny" | "timeout";

export interface ApprovalRequest {
  approvalId: string;
  sessionId: string;
  toolName: string;
  toolLabel: string;
  params: unknown;
}

export interface ApprovalCoordinatorOptions {
  /** Default 5 minutes. Tests override. */
  timeoutMs?: number;
  /** Called when an approval is created so transport (WS) can broadcast. */
  onRequest: (req: ApprovalRequest) => void;
  /** Called when an approval resolves so transport can broadcast resolved state. */
  onResolved: (approvalId: string, decision: ApprovalDecision) => void;
}

interface PendingEntry {
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
  sessionId: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class ApprovalCoordinator {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly timeoutMs: number;
  private readonly onRequest: ApprovalCoordinatorOptions["onRequest"];
  private readonly onResolved: ApprovalCoordinatorOptions["onResolved"];

  constructor(opts: ApprovalCoordinatorOptions) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onRequest = opts.onRequest;
    this.onResolved = opts.onResolved;
  }

  /**
   * Open an approval. Returns a promise that resolves with the eventual decision
   * (approve / deny / timeout). The transport must call `resolve` for approve/deny;
   * the coordinator itself triggers timeout.
   */
  request(input: Omit<ApprovalRequest, "approvalId">): Promise<ApprovalDecision> {
    const approvalId = randomUUID();
    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(approvalId)) {
          this.onResolved(approvalId, "timeout");
          resolve("timeout");
        }
      }, this.timeoutMs);
      this.pending.set(approvalId, { resolve, timer, sessionId: input.sessionId });
      this.onRequest({ approvalId, ...input });
    });
  }

  /** Called by the WS handler when the client sends a decision. */
  resolve(approvalId: string, decision: "approve" | "deny"): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(approvalId);
    this.onResolved(approvalId, decision);
    entry.resolve(decision);
    return true;
  }

  /** Cancel all pending approvals for a session (e.g. on abort). */
  cancelSession(sessionId: string, decision: ApprovalDecision = "deny"): void {
    for (const [id, entry] of this.pending) {
      if (entry.sessionId !== sessionId) continue;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      this.onResolved(id, decision);
      entry.resolve(decision);
    }
  }

  /** Snapshot of currently-pending approvals (for client reconnect catch-up). */
  list(): ReadonlyArray<{ approvalId: string; sessionId: string }> {
    return [...this.pending.entries()].map(([approvalId, entry]) => ({
      approvalId,
      sessionId: entry.sessionId,
    }));
  }
}
```

### Step 2: Tests

```ts
// server/test/approval-coordinator.test.ts
import { describe, expect, test, vi } from "vitest";
import { ApprovalCoordinator } from "../src/approval/coordinator.ts";

function noop() {}

describe("ApprovalCoordinator", () => {
  test("approve resolves the promise", async () => {
    let req!: { approvalId: string };
    const coord = new ApprovalCoordinator({
      timeoutMs: 60_000,
      onRequest: (r) => { req = r; },
      onResolved: noop,
    });
    const p = coord.request({ sessionId: "s1", toolName: "bash", toolLabel: "Bash", params: {} });
    expect(coord.resolve(req.approvalId, "approve")).toBe(true);
    await expect(p).resolves.toBe("approve");
  });

  test("deny resolves with deny", async () => {
    let req!: { approvalId: string };
    const coord = new ApprovalCoordinator({
      timeoutMs: 60_000,
      onRequest: (r) => { req = r; },
      onResolved: noop,
    });
    const p = coord.request({ sessionId: "s1", toolName: "bash", toolLabel: "Bash", params: {} });
    coord.resolve(req.approvalId, "deny");
    await expect(p).resolves.toBe("deny");
  });

  test("timeout fires after timeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const coord = new ApprovalCoordinator({
        timeoutMs: 1000,
        onRequest: noop,
        onResolved: noop,
      });
      const p = coord.request({ sessionId: "s1", toolName: "bash", toolLabel: "Bash", params: {} });
      vi.advanceTimersByTime(1001);
      await expect(p).resolves.toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  test("onResolved fires with correct decision", () => {
    const resolutions: Array<[string, string]> = [];
    let req!: { approvalId: string };
    const coord = new ApprovalCoordinator({
      timeoutMs: 60_000,
      onRequest: (r) => { req = r; },
      onResolved: (id, decision) => { resolutions.push([id, decision]); },
    });
    coord.request({ sessionId: "s1", toolName: "bash", toolLabel: "Bash", params: {} });
    coord.resolve(req.approvalId, "approve");
    expect(resolutions).toEqual([[req.approvalId, "approve"]]);
  });

  test("resolve unknown id returns false, no throw", () => {
    const coord = new ApprovalCoordinator({ timeoutMs: 60_000, onRequest: noop, onResolved: noop });
    expect(coord.resolve("does-not-exist", "approve")).toBe(false);
  });

  test("cancelSession denies all pending for that session", async () => {
    const reqs: Array<{ approvalId: string; sessionId: string }> = [];
    const coord = new ApprovalCoordinator({
      timeoutMs: 60_000,
      onRequest: (r) => { reqs.push(r); },
      onResolved: noop,
    });
    const p1 = coord.request({ sessionId: "s1", toolName: "bash", toolLabel: "Bash", params: {} });
    const p2 = coord.request({ sessionId: "s2", toolName: "bash", toolLabel: "Bash", params: {} });
    coord.cancelSession("s1");
    await expect(p1).resolves.toBe("deny");
    // p2 should still be pending
    expect(coord.list().some((e) => e.sessionId === "s2")).toBe(true);
    // Clean up
    coord.resolve(reqs[1]!.approvalId, "approve");
    await p2;
  });

  test("timer is cleared on explicit resolve (no double-fire)", async () => {
    vi.useFakeTimers();
    try {
      const resolutions: string[] = [];
      let req!: { approvalId: string };
      const coord = new ApprovalCoordinator({
        timeoutMs: 1000,
        onRequest: (r) => { req = r; },
        onResolved: (_, d) => { resolutions.push(d); },
      });
      const p = coord.request({ sessionId: "s1", toolName: "bash", toolLabel: "Bash", params: {} });
      coord.resolve(req.approvalId, "approve");
      vi.advanceTimersByTime(2000);
      await expect(p).resolves.toBe("approve");
      expect(resolutions).toEqual(["approve"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
```

### Step 3: Run + commit

```bash
bash scripts/gate.sh
git add server/src/approval/coordinator.ts server/test/approval-coordinator.test.ts
git commit -m "feat(approval-mode): add ApprovalCoordinator (pending-approvals manager)"
```

---

## Task 6: Tool execute wrapper

**Files:**
- Create: `server/src/approval/wrap-tool.ts`
- Test: `server/test/approval-wrap-tool.test.ts`

### Step 1: Implementation

```ts
// server/src/approval/wrap-tool.ts
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ApprovalCoordinator } from "./coordinator.ts";
import type { ApprovalMode } from "./types.ts";
import { isGatedTool } from "./gated-tools.ts";

/**
 * Per-turn context that the wrapper consults to decide gate vs. pass-through.
 * The manager sets this for the duration of a turn; the wrapper reads it.
 */
export interface ApprovalContext {
  sessionId: string;
  /** Resolved per turn: override > session toggle. */
  effectiveMode: () => ApprovalMode;
  coordinator: ApprovalCoordinator;
}

/**
 * Wrap a tool's execute fn. In YOLO mode (or for ungated tools) calls through
 * directly. In ASK mode for gated tools, opens an approval and either calls
 * through or returns a synthetic denial.
 */
export function wrapToolWithApproval<P>(
  tool: AgentTool<P>,
  ctx: ApprovalContext,
): AgentTool<P> {
  if (!isGatedTool(tool.name)) return tool;
  const originalExecute = tool.execute;
  return {
    ...tool,
    execute: async (id, params) => {
      if (ctx.effectiveMode() === "yolo") {
        return originalExecute(id, params);
      }
      const decision = await ctx.coordinator.request({
        sessionId: ctx.sessionId,
        toolName: tool.name,
        toolLabel: tool.label ?? tool.name,
        params,
      });
      if (decision === "approve") {
        return originalExecute(id, params);
      }
      const reason = decision === "timeout"
        ? "User denied this tool call (timeout)."
        : "User denied this tool call.";
      return {
        content: [{ type: "text" as const, text: reason }],
        details: { approval: decision },
      };
    },
  };
}
```

### Step 2: Tests

```ts
// server/test/approval-wrap-tool.test.ts
import { describe, expect, test } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { wrapToolWithApproval } from "../src/approval/wrap-tool.ts";
import { ApprovalCoordinator } from "../src/approval/coordinator.ts";
import type { ApprovalMode } from "../src/approval/types.ts";

function makeFakeTool(name: string): AgentTool<any> {
  return {
    name,
    label: name,
    description: "",
    parameters: { type: "object", properties: {} } as any,
    execute: async () => ({ content: [{ type: "text", text: `ran ${name}` }] }),
  };
}

function makeCoordinator(): { coord: ApprovalCoordinator; lastId: () => string } {
  let lastId = "";
  const coord = new ApprovalCoordinator({
    timeoutMs: 60_000,
    onRequest: (r) => { lastId = r.approvalId; },
    onResolved: () => {},
  });
  return { coord, lastId: () => lastId };
}

describe("wrapToolWithApproval", () => {
  test("ungated tool is returned unwrapped (reference equality)", () => {
    const { coord } = makeCoordinator();
    const tool = makeFakeTool("read");
    const ctx = { sessionId: "s1", effectiveMode: (): ApprovalMode => "ask", coordinator: coord };
    expect(wrapToolWithApproval(tool, ctx)).toBe(tool);
  });

  test("gated tool in YOLO mode calls through", async () => {
    const { coord } = makeCoordinator();
    const tool = makeFakeTool("bash");
    const ctx = { sessionId: "s1", effectiveMode: (): ApprovalMode => "yolo", coordinator: coord };
    const wrapped = wrapToolWithApproval(tool, ctx);
    const result = await wrapped.execute("call1", {});
    expect((result.content[0] as any).text).toBe("ran bash");
  });

  test("gated tool in ASK mode + approve → calls through", async () => {
    const { coord, lastId } = makeCoordinator();
    const tool = makeFakeTool("bash");
    const ctx = { sessionId: "s1", effectiveMode: (): ApprovalMode => "ask", coordinator: coord };
    const wrapped = wrapToolWithApproval(tool, ctx);
    const p = wrapped.execute("call1", {});
    // Approve shortly after.
    setImmediate(() => coord.resolve(lastId(), "approve"));
    const result = await p;
    expect((result.content[0] as any).text).toBe("ran bash");
  });

  test("gated tool in ASK mode + deny → synthetic denial, original NOT called", async () => {
    const { coord, lastId } = makeCoordinator();
    let calls = 0;
    const tool: AgentTool<any> = {
      ...makeFakeTool("bash"),
      execute: async () => { calls++; return { content: [{ type: "text", text: "should not run" }] }; },
    };
    const ctx = { sessionId: "s1", effectiveMode: (): ApprovalMode => "ask", coordinator: coord };
    const wrapped = wrapToolWithApproval(tool, ctx);
    const p = wrapped.execute("call1", {});
    setImmediate(() => coord.resolve(lastId(), "deny"));
    const result = await p;
    expect(calls).toBe(0);
    expect((result.content[0] as any).text).toBe("User denied this tool call.");
    expect((result as any).details).toEqual({ approval: "deny" });
  });

  test("gated tool in ASK mode + timeout → synthetic denial with (timeout) marker", async () => {
    const { coord } = makeCoordinator();
    // Override timeout to 10ms for this test.
    const fastCoord = new ApprovalCoordinator({
      timeoutMs: 10,
      onRequest: () => {},
      onResolved: () => {},
    });
    const tool = makeFakeTool("bash");
    const ctx = { sessionId: "s1", effectiveMode: (): ApprovalMode => "ask", coordinator: fastCoord };
    const wrapped = wrapToolWithApproval(tool, ctx);
    const result = await wrapped.execute("call1", {});
    expect((result.content[0] as any).text).toBe("User denied this tool call (timeout).");
  });

  test("effectiveMode is read at execute time, not wrap time", async () => {
    const { coord, lastId } = makeCoordinator();
    const tool = makeFakeTool("bash");
    let mode: ApprovalMode = "yolo";
    const ctx = { sessionId: "s1", effectiveMode: () => mode, coordinator: coord };
    const wrapped = wrapToolWithApproval(tool, ctx);
    // First call: YOLO, passes through.
    expect((await wrapped.execute("c1", {})).content[0]).toMatchObject({ text: "ran bash" });
    // Flip mode and verify the next call awaits an approval.
    mode = "ask";
    const p = wrapped.execute("c2", {});
    setImmediate(() => coord.resolve(lastId(), "approve"));
    expect(((await p).content[0] as any).text).toBe("ran bash");
  });

  // Mutation-test: if we accidentally swap the deny branch to call through,
  // this test catches it via the call counter above. Verified by removing the
  // `if (decision === "approve")` check during dev — test fails as expected.
});
```

### Step 3: Run + commit

```bash
bash scripts/gate.sh
git add server/src/approval/wrap-tool.ts server/test/approval-wrap-tool.test.ts
git commit -m "feat(approval-mode): wrap gated tools with approval gate"
```

---

## Task 7: Wire coordinator into server + WS protocol

**Files:**
- Modify: `server/src/server.ts` (around line 28-30 ServerOptions, line 58 WS handler, add new HTTP routes)
- Modify: `server/src/index.ts` or wherever the server is composed (instantiate coordinator, pass to AgentManager and server)
- Modify: `server/src/manager.ts` (lines 70-80 options type, lines 200-220 wire-time assembly)

### Step 1: Plumb coordinator into ServerOptions

In `server/src/server.ts`:

```ts
// In ServerOptions interface:
approval?: {
  coordinator: import("./approval/coordinator.ts").ApprovalCoordinator;
  setSessionMode: (sessionId: string, mode: import("./approval/types.ts").ApprovalMode) => Promise<void>;
};
```

### Step 2: WS handler additions

In the `/api/ws` handler (around line 58), add:

- On open: send current `coordinator.list()` snapshot to the client as `pending_approvals` event so it can re-render any in-flight cards.
- On message: parse client → server messages. New shape: `{ type: "approval_response", approvalId: string, decision: "approve" | "deny" }`. Call `coordinator.resolve(approvalId, decision)`.

Broadcast helpers: the coordinator's `onRequest` and `onResolved` callbacks (passed at construction in Task 8) call into a `broadcast` fn that sends to all WS clients:

- `{ type: "approval_request", ...request }`
- `{ type: "approval_resolved", approvalId, decision }`

### Step 3: PATCH /api/sessions/:id approval_mode

Extend the existing `app.patch("/api/sessions/:id", ...)` handler (around line 146). Currently it accepts at least `title`/`archived`-shaped fields. Add `approvalMode: "yolo" | "ask"`. When present:

1. Append a `set_approval_mode` entry to the session's JSONL via the session API.
2. Update the sqlite cache via `indexer.upsertSession` (or a focused `indexer.setApprovalMode(id, mode)` helper if cleaner).
3. Broadcast `session_updated` over WS (same shape used elsewhere) so other clients re-render the toggle and the tint.

### Step 4: Tests

Add to `server/test/api.test.ts` (or sibling new file `api-approval.test.ts`):

- `PATCH /api/sessions/:id { approvalMode: "ask" }` → 200, GET returns `approvalMode: "ask"`.
- `PATCH /api/sessions/:id { approvalMode: "bogus" }` → 400.
- WS receives `approval_request` when a gated tool runs in ASK mode (integration with a fake tool).
- WS `approval_response` resolves an in-flight tool call.

These will need a small test harness; use the existing `api.test.ts` pattern as the template.

### Step 5: Run + commit

```bash
bash scripts/gate.sh
git add server/src/server.ts server/src/index.ts server/src/manager.ts server/test/
git commit -m "feat(approval-mode): wire ApprovalCoordinator into server WS + PATCH"
```

---

## Task 8: Manager integration — per-turn effective mode + wrapping

**Files:**
- Modify: `server/src/manager.ts` (lines 70-80 options; line 211 tool assembly; turn-start path; messaging API)

### Step 1: Add approval-mode plumbing to AgentManager options

Add to options (around line 70-80):

```ts
approval?: {
  coordinator: ApprovalCoordinator;
  /** Returns the session's persisted toggle mode (read from JSONL via session entries). */
  resolveSessionMode: (sessionId: string) => ApprovalMode;
};
```

### Step 2: Capture session mode at session-open time

In `wire(...)` (line ~201) or wherever sessions get loaded, after replay, compute `deriveApprovalMode(entries)` and cache on the session record.

### Step 3: Per-turn override field on incoming messages

Extend the message-send API to accept an optional `approvalOverride: "yolo" | "ask"` field. The parser (Task 3) is called *client-side* on the composer; the server just trusts the explicit field. But also call `extractTurnOverride` server-side as a defense-in-depth fallback (in case a tool/script sends a raw message). Document: client strips, server re-checks.

### Step 4: Wrap tools at turn-start

The challenge: tools are bound at `wire()` time (line 211), but `effectiveMode` is per-turn (toggle + override). Solution: the `effectiveMode` function in `ApprovalContext` is a *closure* that reads a per-session ref:

```ts
// In the manager, per session:
const currentEffectiveMode = { value: "yolo" as ApprovalMode };
// On each user message: set currentEffectiveMode.value = override ?? sessionToggle.
// Wrapped tools read currentEffectiveMode.value via the closure.
```

So wrapping happens once at wire time; the closure resolves at each tool dispatch.

Replace the `tools: [...this.opts.tools, ...]` array on line 211 with a wrapped version when `opts.approval` is present. Use `wrapToolWithApproval` on each gated tool, passing the per-session `ApprovalContext`.

### Step 5: Apply same wrap on workdir-change rebuild

The tools list also gets rebuilt at line ~760 on workdir change. Apply the same wrap there.

### Step 6: Tests

Add an integration test in `server/test/manager-approval.test.ts`:

- Create a session with mode ASK, run a turn that emits a fake `bash` tool call, verify the call awaits and the coordinator surfaces a request, resolve with approve, assert the original was called.
- Same but with deny — assert synthetic denial returned, original not called.
- Per-turn YOLO override on an ASK session: bash runs without approval.
- Per-turn ASK override on a YOLO session: bash awaits approval.

This will require a small mock model (or use the existing test mock) that emits a `bash` tool call deterministically.

### Step 7: Run + commit

```bash
bash scripts/gate.sh
git add server/src/manager.ts server/test/manager-approval.test.ts
git commit -m "feat(approval-mode): wrap session tools with per-turn effective mode"
```

---

## Task 9: Client — types + WS message handling

**Files:**
- Modify: `web/src/api/` (wherever the session/WS types live)
- Test: `web/test/` (parallel)

### Step 1: Add types

```ts
// e.g. web/src/api/approval.ts
export type ApprovalMode = "yolo" | "ask";

export interface ApprovalRequest {
  approvalId: string;
  sessionId: string;
  toolName: string;
  toolLabel: string;
  params: unknown;
}

export interface ApprovalResolved {
  approvalId: string;
  decision: "approve" | "deny" | "timeout";
}
```

### Step 2: WS event handling

Extend the existing WS dispatcher in the web client to handle:

- `approval_request` → add to per-session pending-approvals list in component state
- `approval_resolved` → remove from pending-approvals list (any client's decision should clear all clients' cards)
- `pending_approvals` (on connect) → seed initial state
- `session_updated` (existing) → re-read `approvalMode` from the payload

### Step 3: API helpers

Add:

- `setSessionApprovalMode(sessionId, mode)` → `PATCH /api/sessions/:id { approvalMode: mode }`
- `respondToApproval(approvalId, decision)` → send WS message `{ type: "approval_response", approvalId, decision }`

### Step 4: Tests

Unit-test the prefix parser client-side (port of Task 3 — same logic for the composer):

- Same 8 test cases. Confirm round-trip identical to server.

### Step 5: Run + commit

```bash
bash scripts/gate.sh
git add web/src/ web/test/
git commit -m "feat(approval-mode): client types + WS handling + prefix parser"
```

---

## Task 10: Client — approval card component

**Files:**
- Create: `web/src/components/ApprovalCard.tsx`
- Modify: `web/src/components/Chat.tsx` (render approval cards inline with messages)
- Test: `web/test/ApprovalCard.test.tsx`

### Step 1: Component

A card rendered inline in the chat stream that shows:

- Tool name + label as the header
- Tool params formatted as a JSON pre-block (scrollable, max-height ~300px, monospace)
- Approve / Deny buttons (Approve primary, Deny secondary)
- A small "auto-denies in N:NN" countdown that updates every second

On click, call `respondToApproval`. Card stays visible (greyed/disabled) for 1s after response before being removed by the WS event.

Match the existing message-card visual aesthetic (look at how `Message.tsx` renders tool calls today).

### Step 2: Wire into Chat.tsx

In the messages render loop, for the active session, interleave any pending approvals from state by `sessionId` match. Position them at the end of the message stream (since they're current/in-flight).

### Step 3: Tests

Component tests:

- Renders tool name + params
- Approve button calls handler with "approve"
- Deny button calls handler with "deny"
- Countdown decreases over time (use fake timers)
- Card disappears when removed from props (simulating the WS resolve)

### Step 4: Run + commit

```bash
bash scripts/gate.sh
git add web/src/components/ApprovalCard.tsx web/src/components/Chat.tsx web/test/ApprovalCard.test.tsx
git commit -m "feat(approval-mode): inline approval card component"
```

---

## Task 11: Client — header toggle

**Files:**
- Modify: `web/src/components/Chat.tsx` (header area where HealthIcon lives — Brian: confirm exact element)

### Step 1: Add toggle control

Near the existing health icons in the chat header, add a two-state pill or switch labeled "YOLO" / "ASK" reflecting the current session's `approvalMode`. Tap flips it via `setSessionApprovalMode`.

Visual: small, subdued in ASK state; yellow-tinted in YOLO state to mirror the rail tint. Same iconography vocabulary as the existing health icons.

A11y: `role="switch"`, `aria-checked` reflecting "ask" (= checked = safer state on), keyboard-accessible.

### Step 2: Tests

- Toggle in YOLO state, tap → calls `setSessionApprovalMode(id, "ask")`.
- Toggle reflects mode changes pushed via WS `session_updated`.
- Keyboard Space/Enter activates the toggle.

### Step 3: Run + commit

```bash
bash scripts/gate.sh
git add web/src/components/Chat.tsx web/test/
git commit -m "feat(approval-mode): chat-header YOLO/ASK toggle"
```

---

## Task 12: Client — left-rail YOLO tint

**Files:**
- Modify: `web/src/components/Sidebar.tsx` (session list item rendering)

### Step 1: Conditional class

In the session list item, add a conditional className when `session.approvalMode === "yolo"`. The class applies a yellow/warning background — use the existing design tokens (look at how alert/warning colors are used elsewhere in the app; likely `bg-yellow-50 dark:bg-yellow-900/20` or a token in `ui/`).

Confirm the visual is readable against the rest of the sidebar's selected/hover states. Should NOT clash with the "active session" highlight.

### Step 2: Tests

- Sidebar renders yellow tint on YOLO sessions, default on ASK.
- Visual smoke (manual on Brian's device — note in /ship report).

### Step 3: Run + commit

```bash
bash scripts/gate.sh
git add web/src/components/Sidebar.tsx web/test/
git commit -m "feat(approval-mode): yellow tint on YOLO sessions in left rail"
```

---

## Task 13: Slash completion entries

**Files:**
- Modify: wherever the slash-completion data source for PR #133 lives (likely `web/src/components/useSlashMenu.ts` or `web/src/api/`; confirm with `grep`)
- Modify: server-side skill/command listing if entries are server-fed

### Step 1: Add entries

Add two entries to the completion vocabulary:

- `/yolo` — "Force this turn to skip approval gates"
- `/careful` — "Force this turn to require approval for every mutating tool"

Match the existing entry shape; they should appear in the same fuzzy-filter overlay.

### Step 2: Tests

Update the existing useSlashMenu test or add a new one verifying:

- `/yo` filters to include `/yolo`
- `/care` filters to include `/careful`
- Selecting either inserts the prefix + trailing space

### Step 3: Run + commit

```bash
bash scripts/gate.sh
git add web/src/ server/src/
git commit -m "feat(approval-mode): /yolo and /careful slash-completion entries"
```

---

## Task 14: Persona text update

**Files:**
- Modify: `server/src/persona.ts` (line ~71 "be careful with destructive commands")

### Step 1: Rewrite the tool-safety paragraph

Replace the vibe-only "be careful" line with a description of the new mode:

```
- bash, write, edit, delegate, schedule, and cancel_schedule are mutating tools. In ASK mode they pause for user approval; in YOLO mode they run immediately. The user toggles per-session via the chat header, or per-turn with /yolo and /careful prefixes. Respect denied approvals — try a different approach or report the block, don't retry the same call.
- read, ls, grep, find, web_search, web_fetch, cancel_task, and cog_* are non-mutating; they always run.
```

### Step 2: Tests

- Snapshot test against the persona text (most likely already exists somewhere; if not, the build covers it).

### Step 3: Run + commit

```bash
bash scripts/gate.sh
git add server/src/persona.ts
git commit -m "feat(approval-mode): teach persona about the approval modes"
```

---

## Task 15: End-to-end manual smoke (no commit; report at /ship)

After the gate is green across all tasks, before merging:

1. Start dev server: `bash deploy/dev.sh`
2. Open the dev PWA at `:3000`.
3. Create a new session — confirm yellow tint in left rail.
4. Send a message that triggers a `bash` call — confirm it runs without approval (YOLO default).
5. Tap the header toggle → ASK. Confirm tint disappears.
6. Send a message that triggers `bash` — confirm approval card appears inline, tap Approve → call executes.
7. Send another, tap Deny → confirm model receives "User denied" and adapts.
8. Send another, walk away for 5+ minutes — confirm auto-deny fires.
9. With session in ASK mode, send `/yolo do a quick check` — confirm `bash` runs without prompt.
10. With session in YOLO mode, send `/careful list files` (no mutating call needed; test that the override is at least *applied* — verify via session log entry or visible header badge).
11. Smoke on iPhone PWA: toggle works, card readable, buttons tap-friendly.

Report results in the /ship summary. Any UI snag goes back as a fix-cycle.

---

## Done criteria

- Gate green, baseline diff is "no regressions, +N new tests pass."
- All 14 implementation tasks committed.
- Manual smoke results recorded in /ship report.
- Design doc still accurate (no scope drift); update if anything changed.
- Persona text updated.
- One PR per task per Brian's ship workflow (or grouped if a task is too small to warrant its own).
