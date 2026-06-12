# Context-Window Compaction + Overflow Recovery — Implementation Plan

> Execute with the `develop` skill, task-by-task.

**Goal:** Wire pi-agent-core's existing compaction primitives into ytsejam so long sessions self-compact at idle boundaries before they hit the model's contextWindow, plus a reactive backstop that recovers from API 400 overflow errors. Model-aware calibration; per-session backups for substrate safety; observability via dev-log + per-session JSONL; kill switch for emergency disable.

**Spec:** `docs/plans/2026-06-12-context-compaction-design.md`

**Architecture:** New pure-function policy module `server/src/compaction.ts` exporting decision/calibration/observability/backup helpers. Two modified call sites wire it: `manager.ts` for main sessions and `task-manager.ts` for subagent harnesses. Both invoke a shared `runCompactionIfPending(opened)` orchestrator. Proactive trigger sets a flag on `turn_end`; idle-boundary executes backup → `harness.compact()` → verify-on-load. Reactive backstop catches `isContextOverflow` errors and force-compacts with one bounded retry, then surrenders to user with diagnostic.

**Tech Stack:** TypeScript, Node 22+, vitest, `@earendil-works/pi-agent-core@0.79.1`, `@earendil-works/pi-ai@0.79.1`. No new deps.

**Worktree:** `/tmp/context-compaction`

**Branch:** `feat/context-compaction`

---

## Conventions

All commands run from `/tmp/context-compaction`. Use `env -u NODE_ENV` prefix on any `npm`/`npx`/`node` invocation (subagent worktree gotcha from patterns.md). Gate is `bash scripts/gate.sh` (no env prefix needed — it sets its own).

Each task ends with a commit on the `feat/context-compaction` branch. The /ship step at the end opens a single PR.

---

## Task 1: Pure-function policy module — calibration + decision

**Files:**
- Create: `server/src/compaction.ts`
- Create: `server/test/compaction.test.ts`

This task establishes the policy primitives with no consumer wiring. The module is a pure addition; the gate passes after this task because nothing imports it yet.

### Step 1: Write the failing tests for calibration + decision

Create `server/test/compaction.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  computeReserveTokens,
  buildSettings,
  decideCompaction,
} from "../src/compaction.js";

const fauxModel = (cw: number, mt: number): Model<any> =>
  ({
    id: "test-model",
    name: "Test",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    contextWindow: cw,
    maxTokens: mt,
  } as Model<any>);

describe("computeReserveTokens", () => {
  it("returns maxTokens + 16k for large-output models", () => {
    expect(computeReserveTokens(fauxModel(1_000_000, 64_000))).toBe(80_384);
    expect(computeReserveTokens(fauxModel(1_000_000, 128_000))).toBe(144_384);
  });

  it("returns 32k floor for small-output models", () => {
    expect(computeReserveTokens(fauxModel(128_000, 4_096))).toBe(32_768);
    expect(computeReserveTokens(fauxModel(8_192, 1_024))).toBe(32_768);
  });

  it("uses maxTokens + 16k when above floor", () => {
    // 17k + 16,384 = 33,384 > 32k floor
    expect(computeReserveTokens(fauxModel(200_000, 17_000))).toBe(33_384);
  });
});

describe("buildSettings", () => {
  it("returns CompactionSettings with computed reserve", () => {
    const s = buildSettings(fauxModel(1_000_000, 64_000));
    expect(s.enabled).toBe(true);
    expect(s.reserveTokens).toBe(80_384);
    expect(s.keepRecentTokens).toBe(20_000);
  });
});

describe("decideCompaction", () => {
  // Helper: build a synthetic AssistantMessage with usage
  const assistantMsgWithUsage = (totalTokens: number): AgentMessage =>
    ({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      usage: {
        input: totalTokens - 100,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "end_turn",
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test-model",
    } as unknown as AgentMessage);

  const userMsg = (text: string): AgentMessage =>
    ({ role: "user", content: [{ type: "text", text }] } as AgentMessage);

  it("fires when tokens exceed budget", () => {
    const model = fauxModel(1_000_000, 64_000); // budget = 919_616
    const messages = [assistantMsgWithUsage(950_000)];
    const d = decideCompaction(messages, model);
    expect(d.shouldFire).toBe(true);
    expect(d.tokensBefore).toBe(950_000);
    expect(d.budget).toBe(919_616);
  });

  it("does not fire one token below budget", () => {
    const model = fauxModel(1_000_000, 64_000);
    const messages = [assistantMsgWithUsage(919_615)];
    expect(decideCompaction(messages, model).shouldFire).toBe(false);
  });

  it("fires at exactly threshold (strict greater-than per pi)", () => {
    // pi's shouldCompact uses `tokens > contextWindow - reserveTokens` (strict)
    // so exactly-at-budget should NOT fire
    const model = fauxModel(1_000_000, 64_000);
    expect(decideCompaction([assistantMsgWithUsage(919_616)], model).shouldFire).toBe(false);
    expect(decideCompaction([assistantMsgWithUsage(919_617)], model).shouldFire).toBe(true);
  });

  it("returns shouldFire=false on empty messages", () => {
    const model = fauxModel(1_000_000, 64_000);
    const d = decideCompaction([], model);
    expect(d.shouldFire).toBe(false);
    expect(d.tokensBefore).toBe(0);
  });

  it("returns shouldFire=false when no assistant usage anywhere", () => {
    const model = fauxModel(1_000_000, 64_000);
    expect(decideCompaction([userMsg("hi")], model).shouldFire).toBe(false);
  });

  it("includes a human-readable reason string", () => {
    const model = fauxModel(1_000_000, 64_000);
    const d = decideCompaction([assistantMsgWithUsage(950_000)], model);
    expect(d.reason).toMatch(/above .* budget/);
  });
});
```

### Step 2: Run the tests to verify they fail

Run: `env -u NODE_ENV npx vitest run server/test/compaction.test.ts`

Expected: FAIL with `Cannot find module './compaction.js'` (or similar — the source file does not exist yet).

### Step 3: Write the calibration + decision functions

Create `server/src/compaction.ts`:

```ts
import type { Model } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  estimateContextTokens,
  shouldCompact,
  type CompactionSettings,
} from "@earendil-works/pi-agent-core";

/**
 * Compute the per-model reserve token budget.
 *
 * Invariant: after compaction, the next turn must fit one full-size model
 * output PLUS reasonable input. Formula: `max(model.maxTokens + 16k, 32k)`.
 *
 * The 16k cushion covers user message + tool calls + cache headers + slack.
 * The 32k floor protects small-output models (e.g. nova-2-lite has 4k output
 * but we still want >= 32k headroom on the input side of next turn).
 */
export function computeReserveTokens(model: Model<any>): number {
  return Math.max(model.maxTokens + 16_384, 32_768);
}

/**
 * Build the CompactionSettings for a given model.
 *
 * `enabled`: always true here — the kill switch is checked at the call site
 *   (compactionEnabled()), not by toggling the settings field.
 * `keepRecentTokens`: pi's default of 20k — how much of the tail to preserve
 *   unsummarized. Larger = more recent context preserved; smaller = more
 *   reclaimed space.
 */
export function buildSettings(model: Model<any>): CompactionSettings {
  return {
    enabled: true,
    reserveTokens: computeReserveTokens(model),
    keepRecentTokens: 20_000,
  };
}

export interface CompactionDecision {
  shouldFire: boolean;
  reason: string;
  tokensBefore: number;
  budget: number;
}

/**
 * Decide whether to compact based on current message stream and model.
 *
 * Pure function — caller wires it into a turn_end hook. Uses pi's
 * estimateContextTokens (provider-truth for measured turns + char/4 for
 * trailing) and pi's shouldCompact predicate.
 */
export function decideCompaction(
  messages: AgentMessage[],
  model: Model<any>,
): CompactionDecision {
  const estimate = estimateContextTokens(messages);
  const settings = buildSettings(model);
  const budget = model.contextWindow - settings.reserveTokens;
  const fire = shouldCompact(estimate.tokens, model.contextWindow, settings);
  return {
    shouldFire: fire,
    reason: fire
      ? `${estimate.tokens} tokens above ${budget} budget (contextWindow=${model.contextWindow}, reserve=${settings.reserveTokens})`
      : `${estimate.tokens} tokens within ${budget} budget`,
    tokensBefore: estimate.tokens,
    budget,
  };
}
```

### Step 4: Run the tests to verify they pass

Run: `env -u NODE_ENV npx vitest run server/test/compaction.test.ts`

Expected: PASS, 11 tests green (3 calibration + 1 settings + 6 decision).

### Step 5: Verify the gate still passes

Run: `bash scripts/gate.sh`

Expected: `=== gate: PASSED ===`. The new file + tests are pure addition, no consumer impact.

### Step 6: Commit

```bash
git add server/src/compaction.ts server/test/compaction.test.ts
git commit -m "feat(compaction): policy primitives — calibration + decision

Pure-function module exporting computeReserveTokens, buildSettings, and
decideCompaction. Model-aware reserveTokens formula: max(maxTokens + 16k, 32k).
Wraps pi-agent-core's estimateContextTokens + shouldCompact predicate.

No consumer wiring yet — pure addition. 11 unit tests green.

Spec: docs/plans/2026-06-12-context-compaction-design.md §D2 + §3.2 + §3.5."
```

---

## Task 2: Overflow classifier + customInstructions

**Files:**
- Modify: `server/src/compaction.ts` (add exports)
- Modify: `server/test/compaction.test.ts` (add tests)

### Step 1: Write the failing tests

Append to `server/test/compaction.test.ts`:

```ts
import { classifyOverflow, CUSTOM_INSTRUCTIONS, buildSurrenderMessage } from "../src/compaction.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";

describe("classifyOverflow", () => {
  const overflowMsg: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    stopReason: "error",
    errorMessage: "prompt is too long: 1000596 tokens > 1000000 maximum",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    usage: undefined as any,
  } as unknown as AssistantMessage;

  const model = {
    id: "claude-sonnet-4-6",
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "",
    name: "Claude",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as Model<any>;

  it("returns true on Anthropic 'prompt is too long' error", () => {
    expect(classifyOverflow(overflowMsg, model)).toBe(true);
  });

  it("returns true on Anthropic 'request_too_large' error", () => {
    const m = { ...overflowMsg, errorMessage: "request_too_large: tokens exceed" } as AssistantMessage;
    expect(classifyOverflow(m, model)).toBe(true);
  });

  it("returns false on rate-limit error (stopReason=error but not overflow)", () => {
    const m = { ...overflowMsg, errorMessage: "429 rate limit exceeded, retry after 30s" } as AssistantMessage;
    expect(classifyOverflow(m, model)).toBe(false);
  });

  it("returns false on stopReason=end_turn (not an error at all)", () => {
    const m = { ...overflowMsg, stopReason: "end_turn", errorMessage: undefined } as AssistantMessage;
    expect(classifyOverflow(m, model)).toBe(false);
  });
});

describe("CUSTOM_INSTRUCTIONS", () => {
  it("includes the no-resummarize sentinel for hot-memory files", () => {
    expect(CUSTOM_INSTRUCTIONS).toMatch(/hot-memory/i);
    expect(CUSTOM_INSTRUCTIONS).toMatch(/\[loaded hot-memory:/);
  });

  it("includes preserve-list anchors", () => {
    expect(CUSTOM_INSTRUCTIONS).toMatch(/PRESERVE EXACTLY/);
    expect(CUSTOM_INSTRUCTIONS).toMatch(/git branch/);
    expect(CUSTOM_INSTRUCTIONS).toMatch(/reviewer verdict/);
    expect(CUSTOM_INSTRUCTIONS).toMatch(/subagent task/);
    expect(CUSTOM_INSTRUCTIONS).toMatch(/Scheduled task/);
  });

  it("includes condense-list anchors", () => {
    expect(CUSTOM_INSTRUCTIONS).toMatch(/CONDENSE aggressively/);
  });
});

describe("buildSurrenderMessage", () => {
  it("includes both tokens and contextWindow in diagnostic", () => {
    const msg = buildSurrenderMessage(1_050_000, 1_000_000);
    expect(msg).toMatch(/1050000|1,050,000/);
    expect(msg).toMatch(/1000000|1,000,000/);
  });

  it("mentions the three user options", () => {
    const msg = buildSurrenderMessage(1_050_000, 1_000_000);
    expect(msg).toMatch(/summarize/i);
    expect(msg).toMatch(/fresh session/i);
    expect(msg).toMatch(/larger.*model|switch.*model/i);
  });
});
```

### Step 2: Run tests to verify failure

Run: `env -u NODE_ENV npx vitest run server/test/compaction.test.ts`

Expected: FAIL with `classifyOverflow is not exported` (or similar).

### Step 3: Add the exports to `server/src/compaction.ts`

Append to `server/src/compaction.ts`:

```ts
import { isContextOverflow } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";

/**
 * Wrapper around pi-ai's isContextOverflow for testability.
 *
 * pi's regex covers:
 *   - Anthropic: /prompt is too long/i, /request_too_large/i
 *   - z.ai silent overflow detection (length-based)
 *   - Xiaomi MiMo length-truncation
 *
 * We pass model.contextWindow so the silent/length detectors can compute.
 */
export function classifyOverflow(
  msg: AssistantMessage,
  model: Model<any>,
): boolean {
  if (msg.stopReason !== "error") return false;
  return isContextOverflow(msg, model.contextWindow);
}

/**
 * Static custom instructions for the summarizer LLM.
 *
 * The no-resummarize rule for hot-memory files is load-bearing: hot-memory
 * auto-loads every turn via the system prompt; re-summarizing it doubles
 * tokens. The next turn already gets the latest hot-memory; the summary
 * only needs to note "we had hot-memory loaded".
 *
 * Same reasoning for cog retrieval tool output: the agent re-reads when it
 * needs to. The summary should note WHAT was read, not the content.
 */
export const CUSTOM_INSTRUCTIONS = `
You are summarizing a conversation in ytsejam (a single-user personal AI assistant).

PRESERVE EXACTLY:
  - The user's most recent stated goal.
  - Any active git branch / worktree path / PR number / commit SHA.
  - Any reviewer verdict (spec or quality) that triggered a fix cycle, including the full issue list.
  - Any subagent task id mentioned + what was delegated.
  - Any plan-doc task currently in progress (which task #, which step #).
  - Any [Scheduled task ...] context that has not yet been acted on.

DO NOT re-summarize content from cog_read of any file ending in \`hot-memory.md\`.
Instead, note only: [loaded hot-memory: <path>]. The next turn auto-loads
hot-memory from the system prompt; resummarizing it doubles tokens.

DO NOT re-summarize tool output from cog_read / cog_search / cog_list / cog_outline
when the output was retrieval-only (the agent's memory tools).
Note only: [read <path>] or [searched <query> → N results].

CONDENSE aggressively:
  - Full file contents read via filesystem tools (read/grep/find).
  - Completed reasoning chains where the conclusion was acted on.
  - Exploratory grep/find/ls results.
  - Subagent intermediate progress (preserve only the final result + any caveats).
  - Tool output that is no longer relevant to the current goal.
`.trim();

/**
 * Build the user-visible surrender message when both proactive compaction
 * and the reactive retry fail to fit the prompt.
 *
 * This is shown when the most likely cause is a single oversized turn input
 * (e.g. a 500K-token file paste, a giant tool result) that no amount of
 * historical compaction can fix.
 */
export function buildSurrenderMessage(
  tokens: number,
  contextWindow: number,
): string {
  return [
    "I hit a context-window limit and couldn't recover automatically.",
    "",
    "The current request appears to be larger than the model's input ceiling on its own (likely a single oversized file or tool result, not accumulated history).",
    "",
    "Options:",
    "  (a) Ask me to summarize what I have so far, then continue in a smaller scope.",
    "  (b) Start a fresh session.",
    "  (c) Switch to a larger-context model (if available).",
    "",
    `Diagnostic: prompt was ~${tokens.toLocaleString()} tokens against contextWindow ${contextWindow.toLocaleString()}.`,
  ].join("\n");
}
```

### Step 4: Run tests to verify pass

Run: `env -u NODE_ENV npx vitest run server/test/compaction.test.ts`

Expected: PASS, all tests green (Task-1 11 + Task-2 ~10 = ~21 tests).

### Step 5: Verify gate

Run: `bash scripts/gate.sh`

Expected: `=== gate: PASSED ===`.

### Step 6: Commit

```bash
git add server/src/compaction.ts server/test/compaction.test.ts
git commit -m "feat(compaction): overflow classifier + customInstructions + surrender msg

Adds classifyOverflow (thin wrapper around pi-ai's isContextOverflow),
CUSTOM_INSTRUCTIONS static const with hot-memory no-resummarize rule + cog
retrieval condense rule + preserve list (goal/branch/reviewer/subagent/plan
task/schedule), and buildSurrenderMessage for the failure-of-failure case.

Spec: docs/plans/2026-06-12-context-compaction-design.md §D3 + §D4 + §3.3."
```

---

## Task 3: Observability writers (dev-log + per-session JSONL)

**Files:**
- Modify: `server/src/compaction.ts`
- Modify: `server/test/compaction.test.ts`

### Step 1: Write the failing tests

Append to `server/test/compaction.test.ts`:

```ts
import {
  formatDevLogLine,
  serializeJsonRecord,
  type CompactionEvent,
} from "../src/compaction.js";

describe("formatDevLogLine", () => {
  const baseEvent: CompactionEvent = {
    timestamp: new Date("2026-06-12T14:32:18.412Z"),
    sessionId: "abc123",
    subagentTaskId: null,
    trigger: "proactive",
    reason: "above 920000 budget",
    model: "anthropic/claude-sonnet-4-6",
    contextWindow: 1_000_000,
    reserveTokens: 80_384,
    keepRecentTokens: 20_000,
    tokensBefore: 947_112,
    tokensAfter: 184_309,
    summaryTokens: 4_821,
    firstKeptEntryId: "evt_8f12",
    filesRead: ["server/src/manager.ts"],
    filesModified: ["server/src/compaction.ts"],
    compactionDurationMs: 8_412,
    succeeded: true,
    backupPath: "~/.ytsejam/data/sessions/--chat--/<timestamp>_<sessionId>.jsonl.pre-compact-1718193600000",
  };

  it("formats a single line for proactive main-session compaction", () => {
    const line = formatDevLogLine(baseEvent);
    expect(line).toMatch(/^2026-06-12.*: compaction in session abc123 — proactive/);
    expect(line).toMatch(/anthropic\/claude-sonnet-4-6/);
    expect(line).toMatch(/ctx 947112→184309 tokens/);
    expect(line).toMatch(/summary 4821 tokens/);
    expect(line).toMatch(/Trigger: above 920000 budget/);
  });

  it("adds subagent prefix when subagentTaskId is present", () => {
    const e = { ...baseEvent, subagentTaskId: "task-xyz" };
    const line = formatDevLogLine(e);
    expect(line).toMatch(/subagent task task-xyz \(parent session abc123\)/);
  });

  it("formats reactive trigger explicitly", () => {
    const e = { ...baseEvent, trigger: "reactive" as const, reason: "isContextOverflow" };
    const line = formatDevLogLine(e);
    expect(line).toMatch(/reactive/);
    expect(line).toMatch(/Trigger: isContextOverflow/);
  });

  it("includes FAILED marker when succeeded=false", () => {
    const e = { ...baseEvent, succeeded: false };
    expect(formatDevLogLine(e)).toMatch(/FAILED/);
  });
});

describe("serializeJsonRecord", () => {
  it("round-trips via JSON.parse with all expected keys", () => {
    const e: CompactionEvent = {
      timestamp: new Date("2026-06-12T14:32:18.412Z"),
      sessionId: "abc",
      subagentTaskId: null,
      trigger: "proactive",
      reason: "test",
      model: "test/m",
      contextWindow: 1000,
      reserveTokens: 100,
      keepRecentTokens: 50,
      tokensBefore: 950,
      tokensAfter: 200,
      summaryTokens: 10,
      firstKeptEntryId: "evt",
      filesRead: [],
      filesModified: [],
      compactionDurationMs: 100,
      succeeded: true,
      backupPath: "/tmp/x",
    };
    const json = serializeJsonRecord(e);
    const parsed = JSON.parse(JSON.stringify(json));
    expect(parsed.timestamp).toBe("2026-06-12T14:32:18.412Z");
    expect(parsed.session_id).toBe("abc");
    expect(parsed.subagent_task_id).toBeNull();
    expect(parsed.trigger).toBe("proactive");
    expect(parsed.context_window).toBe(1000);
    expect(parsed.reserve_tokens).toBe(100);
    expect(parsed.tokens_before).toBe(950);
    expect(parsed.tokens_after).toBe(200);
    expect(parsed.summary_tokens).toBe(10);
    expect(parsed.files_read).toEqual([]);
    expect(parsed.files_modified).toEqual([]);
    expect(parsed.compaction_duration_ms).toBe(100);
    expect(parsed.succeeded).toBe(true);
    expect(parsed.backup_path).toBe("/tmp/x");
  });
});
```

### Step 2: Run tests to verify failure

Run: `env -u NODE_ENV npx vitest run server/test/compaction.test.ts`

Expected: FAIL — `formatDevLogLine`, `serializeJsonRecord`, `CompactionEvent` not exported.

### Step 3: Implement the observability types + writers

Append to `server/src/compaction.ts`:

```ts
/**
 * Per-compaction event record. Constructed at session_compact handler time,
 * fed to both formatDevLogLine (one-line cog dev-log entry) and
 * serializeJsonRecord (full structured record for per-session JSONL).
 */
export interface CompactionEvent {
  timestamp: Date;
  sessionId: string;
  subagentTaskId: string | null;
  trigger: "proactive" | "reactive";
  reason: string;
  model: string; // "provider/id"
  contextWindow: number;
  reserveTokens: number;
  keepRecentTokens: number;
  tokensBefore: number;
  tokensAfter: number;
  summaryTokens: number;
  firstKeptEntryId: string;
  filesRead: string[];
  filesModified: string[];
  compactionDurationMs: number;
  succeeded: boolean;
  backupPath: string;
}

/**
 * Format a single-line dev-log entry for cog appending.
 *
 * Shape:
 *   YYYY-MM-DD HH:MM:SS: compaction in session <id>[ subagent task <tid> (parent session <id>)] —
 *     <trigger>, <model>, ctx <before>→<after> tokens, summary <S> tokens,
 *     files-read [<list>], files-edited [<list>]. Trigger: <reason>.[ FAILED]
 */
export function formatDevLogLine(e: CompactionEvent): string {
  const ts = e.timestamp.toISOString().replace("T", " ").slice(0, 19);
  const sessionPart = e.subagentTaskId
    ? `subagent task ${e.subagentTaskId} (parent session ${e.sessionId})`
    : `session ${e.sessionId}`;
  const filesReadStr = e.filesRead.length ? `[${e.filesRead.join(", ")}]` : "[]";
  const filesModStr = e.filesModified.length ? `[${e.filesModified.join(", ")}]` : "[]";
  const failedMarker = e.succeeded ? "" : " FAILED";
  return (
    `${ts}: compaction in ${sessionPart} — ${e.trigger}, ${e.model}, ` +
    `ctx ${e.tokensBefore}→${e.tokensAfter} tokens, ` +
    `summary ${e.summaryTokens} tokens, files-read ${filesReadStr}, ` +
    `files-edited ${filesModStr}. Trigger: ${e.reason}.${failedMarker}`
  );
}

/**
 * Serialize a CompactionEvent to the JSON shape persisted in
 * `~/.ytsejam/data/sessions/<id>/compactions.jsonl`.
 *
 * Keys use snake_case to match conventional JSONL ergonomics; values are
 * primitives + arrays only (round-trips through JSON.stringify cleanly).
 */
export function serializeJsonRecord(e: CompactionEvent): Record<string, unknown> {
  return {
    timestamp: e.timestamp.toISOString(),
    session_id: e.sessionId,
    subagent_task_id: e.subagentTaskId,
    trigger: e.trigger,
    reason: e.reason,
    model: e.model,
    context_window: e.contextWindow,
    reserve_tokens: e.reserveTokens,
    keep_recent_tokens: e.keepRecentTokens,
    tokens_before: e.tokensBefore,
    tokens_after: e.tokensAfter,
    summary_tokens: e.summaryTokens,
    first_kept_entry_id: e.firstKeptEntryId,
    files_read: e.filesRead,
    files_modified: e.filesModified,
    compaction_duration_ms: e.compactionDurationMs,
    succeeded: e.succeeded,
    backup_path: e.backupPath,
  };
}
```

### Step 4: Run tests to verify pass

Run: `env -u NODE_ENV npx vitest run server/test/compaction.test.ts`

Expected: PASS — Task-1 + Task-2 + Task-3 tests all green.

### Step 5: Verify gate

Run: `bash scripts/gate.sh`

Expected: `=== gate: PASSED ===`.

### Step 6: Commit

```bash
git add server/src/compaction.ts server/test/compaction.test.ts
git commit -m "feat(compaction): observability writers — formatDevLogLine + serializeJsonRecord

CompactionEvent interface + two pure formatters: formatDevLogLine produces
the single-line cog dev-log entry shape, serializeJsonRecord produces the
structured per-session JSONL record. Both consume the same event object.

Spec: docs/plans/2026-06-12-context-compaction-design.md §D5 + §4."
```

---

## Task 4: Async writers + kill switch + backup/verify helpers

**Files:**
- Modify: `server/src/compaction.ts`
- Modify: `server/test/compaction.test.ts`

### Step 1: Write the failing tests

Append to `server/test/compaction.test.ts`:

```ts
import { mkdtemp, mkdir, writeFile, readdir, readFile, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendDevLogLine,
  appendSessionCompactionJsonl,
  snapshotSessionJsonl,
  pruneOldBackups,
  verifySessionLoadable,
  compactionEnabled,
} from "../src/compaction.js";

describe("compactionEnabled", () => {
  const prev = process.env.YTSEJAM_COMPACTION_ENABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.YTSEJAM_COMPACTION_ENABLED;
    else process.env.YTSEJAM_COMPACTION_ENABLED = prev;
  });

  it("defaults to true when unset", () => {
    delete process.env.YTSEJAM_COMPACTION_ENABLED;
    expect(compactionEnabled()).toBe(true);
  });

  it("returns false when set to 'false' (case-insensitive)", () => {
    process.env.YTSEJAM_COMPACTION_ENABLED = "false";
    expect(compactionEnabled()).toBe(false);
    process.env.YTSEJAM_COMPACTION_ENABLED = "FALSE";
    expect(compactionEnabled()).toBe(false);
    process.env.YTSEJAM_COMPACTION_ENABLED = "False";
    expect(compactionEnabled()).toBe(false);
  });

  it("returns true for any other value", () => {
    for (const v of ["true", "1", "yes", "on", "", "anything"]) {
      process.env.YTSEJAM_COMPACTION_ENABLED = v;
      expect(compactionEnabled()).toBe(true);
    }
  });
});

describe("appendDevLogLine + appendSessionCompactionJsonl", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "compaction-test-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("appends a line + newline to the given file (creates parents)", async () => {
    const path = join(tmp, "deep/nested/dev-log.md");
    await appendDevLogLine("- 2026-06-12: hello", path);
    await appendDevLogLine("- 2026-06-12: world", path);
    const content = await readFile(path, "utf8");
    expect(content).toBe("- 2026-06-12: hello\n- 2026-06-12: world\n");
  });

  it("appends a JSON line to <dataDir>/sessions/<id>/compactions.jsonl", async () => {
    const dataDir = tmp;
    await mkdir(join(dataDir, "sessions", "abc"), { recursive: true });
    await appendSessionCompactionJsonl("abc", { foo: 1, bar: "x" }, dataDir);
    await appendSessionCompactionJsonl("abc", { foo: 2 }, dataDir);
    const path = join(dataDir, "sessions", "abc", "compactions.jsonl");
    const content = await readFile(path, "utf8");
    const lines = content.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([{ foo: 1, bar: "x" }, { foo: 2 }]);
  });
});

describe("snapshotSessionJsonl + pruneOldBackups", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "compaction-test-"));
    await mkdir(join(tmp, "sessions", "sid"), { recursive: true });
    await writeFile(join(tmp, "sessions", "sid", "session.jsonl"), "line1\nline2\n");
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("creates a backup file with pre-compact-<timestamp> suffix", async () => {
    const backupPath = await snapshotSessionJsonl("sid", tmp);
    expect(backupPath).toMatch(/session\.jsonl\.pre-compact-\d+$/);
    const content = await readFile(backupPath, "utf8");
    expect(content).toBe("line1\nline2\n");
  });

  it("pruneOldBackups keeps the N most recent", async () => {
    // create 5 backups with increasing timestamps in the filename
    for (let i = 1; i <= 5; i++) {
      await writeFile(
        join(tmp, "sessions", "sid", `session.jsonl.pre-compact-${1000 + i}`),
        `backup ${i}`,
      );
    }
    await pruneOldBackups("sid", tmp, 3);
    const files = (await readdir(join(tmp, "sessions", "sid")))
      .filter((f) => f.includes("pre-compact"))
      .sort();
    expect(files).toEqual([
      "session.jsonl.pre-compact-1003",
      "session.jsonl.pre-compact-1004",
      "session.jsonl.pre-compact-1005",
    ]);
  });

  it("pruneOldBackups is a no-op when fewer backups than keepLast", async () => {
    await writeFile(
      join(tmp, "sessions", "sid", "session.jsonl.pre-compact-1001"),
      "only one",
    );
    await pruneOldBackups("sid", tmp, 3);
    const files = (await readdir(join(tmp, "sessions", "sid")))
      .filter((f) => f.includes("pre-compact"));
    expect(files).toEqual(["session.jsonl.pre-compact-1001"]);
  });
});

describe("verifySessionLoadable", () => {
  it("returns ok:true on valid JSONL", async () => {
    // mock repo with successful load
    const repo = { load: async () => ({ id: "sid" }) } as any;
    const result = await verifySessionLoadable("sid", repo);
    expect(result.ok).toBe(true);
  });

  it("returns ok:false with error on load failure", async () => {
    const repo = { load: async () => { throw new Error("corrupted"); } } as any;
    const result = await verifySessionLoadable("sid", repo);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe("corrupted");
  });
});
```

### Step 2: Run tests to verify failure

Run: `env -u NODE_ENV npx vitest run server/test/compaction.test.ts`

Expected: FAIL — async writers + kill switch + backup helpers + verifySessionLoadable not exported.

### Step 3: Add the imports to vitest test file

At the TOP of `server/test/compaction.test.ts`, ensure these are in the import set:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
```

(If `beforeEach`/`afterEach` were missing from existing imports, add them.)

### Step 4: Implement the async writers + kill switch + backup helpers

Append to `server/src/compaction.ts`:

```ts
import { appendFile, copyFile, mkdir, readdir, unlink, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JsonlSessionRepo } from "@earendil-works/pi-agent-core";

/**
 * Read the kill-switch env var. Defaults to enabled.
 *
 * Only `false` (case-insensitive) disables. Any other value (including
 * unset, empty, "true", "1") enables. This is a one-way safety valve —
 * the env var is read once per process at wire-time; flipping requires
 * `systemctl --user restart ytsejam`.
 */
export function compactionEnabled(): boolean {
  const v = process.env.YTSEJAM_COMPACTION_ENABLED;
  if (v && v.toLowerCase() === "false") return false;
  return true;
}

/**
 * Append a line + newline to a file. Creates parent directories.
 *
 * Used for both the cog dev-log entry and as a primitive for the JSONL
 * writer. Best-effort: errors are caught and logged to console (we don't
 * want observability writes to break the conversation).
 */
export async function appendDevLogLine(
  line: string,
  filePath: string,
): Promise<void> {
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, line + "\n", "utf8");
  } catch (err) {
    console.error(`[compaction] failed to append dev-log line to ${filePath}:`, err);
  }
}

/**
 * Append a JSON record (one line per record) to the per-session compactions log.
 *
 * Path: `<dataDir>/sessions/<sessionId>/compactions.jsonl`.
 * Best-effort like appendDevLogLine.
 */
export async function appendSessionCompactionJsonl(
  sessionId: string,
  record: Record<string, unknown>,
  dataDir: string,
): Promise<void> {
  const path = join(dataDir, "sessions", sessionId, "compactions.jsonl");
  await appendDevLogLine(JSON.stringify(record), path);
}

/**
 * Copy the session JSONL file to a backup with a `pre-compact-<unix-ts>` suffix.
 * Returns the backup path.
 *
 * NB: timestamp is millisecond-precision integer for sortability.
 */
export async function snapshotSessionJsonl(
  sessionId: string,
  dataDir: string,
): Promise<string> {
  const sessionDir = join(dataDir, "sessions", sessionId);
  const src = join(sessionDir, "session.jsonl");
  const ts = Date.now();
  const dst = join(sessionDir, `session.jsonl.pre-compact-${ts}`);
  await copyFile(src, dst);
  return dst;
}

/**
 * Keep only the N most recent pre-compact backups for a session.
 *
 * Sorts by timestamp embedded in the filename (lexicographic == numeric here
 * because timestamps are fixed-width-enough that string sort matches numeric
 * sort for any realistic span). Deletes the older ones.
 *
 * Best-effort: errors during prune are logged and swallowed (we'd rather
 * have extra backups than skip the compaction itself).
 */
export async function pruneOldBackups(
  sessionId: string,
  dataDir: string,
  keepLast: number,
): Promise<void> {
  const sessionDir = join(dataDir, "sessions", sessionId);
  try {
    const all = await readdir(sessionDir);
    const backups = all
      .filter((f) => f.startsWith("session.jsonl.pre-compact-"))
      .sort(); // string sort matches numeric sort for ms timestamps
    if (backups.length <= keepLast) return;
    const toDelete = backups.slice(0, backups.length - keepLast);
    for (const f of toDelete) {
      try {
        await unlink(join(sessionDir, f));
      } catch (err) {
        console.error(`[compaction] failed to prune backup ${f}:`, err);
      }
    }
  } catch (err) {
    console.error(`[compaction] failed to scan backups in ${sessionDir}:`, err);
  }
}

/**
 * Verify that the session JSONL is loadable by re-reading it through the repo.
 *
 * Called immediately after a successful `harness.compact()` to catch the
 * scary "pi wrote a malformed entry" case before it kills the next session
 * resume.
 */
export async function verifySessionLoadable(
  sessionId: string,
  repo: JsonlSessionRepo,
): Promise<{ ok: boolean; error?: Error }> {
  try {
    await repo.open(opened.session.metadata);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}
```

### Step 5: Run tests to verify pass

Run: `env -u NODE_ENV npx vitest run server/test/compaction.test.ts`

Expected: PASS — all tests through Task 4 green (~32 cases total).

### Step 6: Verify gate

Run: `bash scripts/gate.sh`

Expected: `=== gate: PASSED ===`.

### Step 7: Commit

```bash
git add server/src/compaction.ts server/test/compaction.test.ts
git commit -m "feat(compaction): async writers + kill switch + backup/verify helpers

- compactionEnabled(): reads YTSEJAM_COMPACTION_ENABLED kill switch (defaults true)
- appendDevLogLine / appendSessionCompactionJsonl: best-effort observability writes
- snapshotSessionJsonl / pruneOldBackups: pre-compact backup chain (keep last 3)
- verifySessionLoadable: post-compact corruption check via repo.open(metadata)

All writes are best-effort with logged-and-swallowed errors so observability
or backup failures never break the conversation.

Spec: docs/plans/2026-06-12-context-compaction-design.md §D8 + §D9 + §4."
```

---

## Task 5: Orchestrator + main-session wiring (manager.ts)

**Files:**
- Modify: `server/src/compaction.ts` (add `runCompactionIfPending` + types for opened-session extensions)
- Modify: `server/src/manager.ts` (wire turn_end + session_compact + reactive-error hooks)
- Modify: `server/test/compaction.test.ts` (wiring tests with mocked harness)

### Step 1: Add orchestrator + extension type to compaction.ts

Append to `server/src/compaction.ts`:

```ts
import type { AgentHarness, Session } from "@earendil-works/pi-agent-core";

/**
 * Per-opened-session state we need to carry for compaction wiring.
 *
 * Attached to the OpenedSession object held by AgentManager / TaskManager.
 * Defined as a structural interface here so we don't have to export the
 * full OpenedSession shape from manager.ts (avoids circular imports).
 */
export interface CompactionWiringState {
  pendingCompaction: PendingCompaction | null;
  reactiveRetryAttempted: boolean;
}

export interface PendingCompaction {
  trigger: "proactive" | "reactive";
  reason: string;
  tokensBefore: number;
  budget: number;
}

/**
 * The full opened-session shape the orchestrator needs. Manager/TaskManager
 * pass an object satisfying this interface. Kept minimal — only the pieces
 * compaction touches.
 */
export interface OpenedForCompaction {
  session: { id: string };
  harness: AgentHarness;
  compaction: CompactionWiringState;
}

export interface RunCompactionResult {
  fired: boolean;
  succeeded?: boolean;
  surrendered?: boolean;
  durationMs?: number;
  backupPath?: string;
  error?: Error;
}

/**
 * The orchestrator called at idle boundaries (and from the reactive-error
 * path). No-op if no pending compaction.
 *
 * Returns a result the caller uses to decide subsequent flow:
 *   - fired=false      → nothing to do
 *   - fired=true, succeeded=true  → compaction wrote to session; safe to continue
 *   - fired=true, succeeded=false → compaction failed; clear pending; if reactive caller, surrender
 *   - fired=true, surrendered=true → JSONL corrupted post-compact; user-visible surrender message emitted
 */
export async function runCompactionIfPending(
  opened: OpenedForCompaction,
  dataDir: string,
  repo: JsonlSessionRepo,
): Promise<RunCompactionResult> {
  const pending = opened.compaction.pendingCompaction;
  if (!pending) return { fired: false };

  // Clear flag eagerly so concurrent triggers don't double-fire
  opened.compaction.pendingCompaction = null;

  const start = Date.now();
  let backupPath: string;

  try {
    backupPath = await snapshotSessionJsonl(opened.session.id, dataDir);
  } catch (err) {
    console.error(`[compaction] backup failed for session ${opened.session.id}, ABORTING compaction:`, err);
    return { fired: true, succeeded: false, error: err instanceof Error ? err : new Error(String(err)) };
  }

  // Best-effort prune (no abort on failure)
  void pruneOldBackups(opened.session.id, dataDir, 3);

  try {
    await opened.harness.compact(CUSTOM_INSTRUCTIONS);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    console.error(`[compaction] harness.compact failed for session ${opened.session.id}:`, e);
    return {
      fired: true,
      succeeded: false,
      durationMs: Date.now() - start,
      backupPath,
      error: e,
    };
  }

  // Verify the session is still loadable after compaction wrote
  const verify = await verifySessionLoadable(opened.session.id, repo);
  if (!verify.ok) {
    console.error(
      `[compaction] post-compact load verification FAILED for session ${opened.session.id}:`,
      verify.error,
    );
    return {
      fired: true,
      succeeded: false,
      surrendered: true,
      durationMs: Date.now() - start,
      backupPath,
      error: verify.error,
    };
  }

  return {
    fired: true,
    succeeded: true,
    durationMs: Date.now() - start,
    backupPath,
  };
}
```

### Step 2: Write wiring tests (mocked harness)

Append to `server/test/compaction.test.ts`:

```ts
import { runCompactionIfPending, type OpenedForCompaction } from "../src/compaction.js";
import { EventEmitter } from "node:events";

describe("runCompactionIfPending", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "orchestrator-test-"));
    await mkdir(join(tmp, "sessions", "sid"), { recursive: true });
    await writeFile(join(tmp, "sessions", "sid", "session.jsonl"), "line\n");
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const makeMockOpened = (compactImpl: () => Promise<void>): OpenedForCompaction => {
    const ee = new EventEmitter() as any;
    ee.compact = compactImpl;
    return {
      session: { id: "sid" },
      harness: ee,
      compaction: { pendingCompaction: null, reactiveRetryAttempted: false },
    };
  };

  const okRepo = { load: async () => ({ id: "sid" }) } as any;
  const failingRepo = { load: async () => { throw new Error("corrupt"); } } as any;

  it("returns fired:false when no pending", async () => {
    const opened = makeMockOpened(async () => { });
    const r = await runCompactionIfPending(opened, tmp, okRepo);
    expect(r.fired).toBe(false);
  });

  it("calls harness.compact and returns succeeded:true on happy path", async () => {
    let called = false;
    const opened = makeMockOpened(async () => { called = true; });
    opened.compaction.pendingCompaction = {
      trigger: "proactive", reason: "test", tokensBefore: 900_000, budget: 800_000,
    };
    const r = await runCompactionIfPending(opened, tmp, okRepo);
    expect(called).toBe(true);
    expect(r.fired).toBe(true);
    expect(r.succeeded).toBe(true);
    expect(r.backupPath).toMatch(/pre-compact-\d+$/);
    expect(opened.compaction.pendingCompaction).toBeNull(); // cleared
  });

  it("returns succeeded:false on harness.compact error", async () => {
    const opened = makeMockOpened(async () => { throw new Error("summarization_failed"); });
    opened.compaction.pendingCompaction = {
      trigger: "proactive", reason: "test", tokensBefore: 900_000, budget: 800_000,
    };
    const r = await runCompactionIfPending(opened, tmp, okRepo);
    expect(r.fired).toBe(true);
    expect(r.succeeded).toBe(false);
    expect(r.error?.message).toBe("summarization_failed");
  });

  it("returns surrendered:true when post-compact load fails", async () => {
    const opened = makeMockOpened(async () => { /* compact succeeds */ });
    opened.compaction.pendingCompaction = {
      trigger: "proactive", reason: "test", tokensBefore: 900_000, budget: 800_000,
    };
    const r = await runCompactionIfPending(opened, tmp, failingRepo);
    expect(r.fired).toBe(true);
    expect(r.succeeded).toBe(false);
    expect(r.surrendered).toBe(true);
    expect(r.error?.message).toBe("corrupt");
  });
});
```

### Step 3: Run tests to verify failure

Run: `env -u NODE_ENV npx vitest run server/test/compaction.test.ts`

Expected: PASS for new tests (since the orchestrator is implemented). If anything fails, fix and re-run.

### Step 4: Wire into manager.ts

Read the current manager.ts to find the right hook points:

```bash
grep -n "wire\|openSession\|AgentHarness\|harness\.on\|turn_end" server/src/manager.ts | head -30
```

In `server/src/manager.ts`:

1. **Add imports** near the top with the other pi-agent-core imports:

```ts
import {
  compactionEnabled,
  decideCompaction,
  classifyOverflow,
  runCompactionIfPending,
  formatDevLogLine,
  serializeJsonRecord,
  appendDevLogLine,
  appendSessionCompactionJsonl,
  buildSurrenderMessage,
  computeReserveTokens,
  type CompactionWiringState,
  type CompactionEvent,
} from "../src/compaction.js";
```

2. **Extend the OpenedSession type** that manager.ts uses internally — add a `compaction: CompactionWiringState` field with default `{ pendingCompaction: null, reactiveRetryAttempted: false }`. (Find the type/interface near the top of `wire()` or `openSession()` and add the field where the session/harness/etc are stored.)

3. **At the end of `wire()`** (after the harness is constructed and tools/handlers are attached), gate behind `compactionEnabled()` and wire three hooks:

```ts
// Compaction wiring (no-op if YTSEJAM_COMPACTION_ENABLED=false at boot)
if (compactionEnabled()) {
  opened.compaction = { pendingCompaction: null, reactiveRetryAttempted: false };

  // Proactive: flag at turn_end when over budget
  harness.on("turn_end", async (e: any) => {
    try {
      const messages = (await opened.session.buildContext()).messages;
      const decision = decideCompaction(messages, harness.getModel());
      if (decision.shouldFire) {
        opened.compaction.pendingCompaction = {
          trigger: "proactive",
          reason: decision.reason,
          tokensBefore: decision.tokensBefore,
          budget: decision.budget,
        };
      }
    } catch (err) {
      console.error("[compaction] turn_end decision failed:", err);
    }
  });

  // Observability on every compaction event (regardless of who triggered it)
  harness.on("session_compact", async (e: any) => {
    try {
      const model = harness.getModel();
      const event: CompactionEvent = {
        timestamp: new Date(),
        sessionId: opened.session.id,
        subagentTaskId: null, // main session
        trigger: opened.compaction.pendingCompaction?.trigger ?? "proactive",
        reason: opened.compaction.pendingCompaction?.reason ?? "session_compact fired",
        model: `${model.provider}/${model.id}`,
        contextWindow: model.contextWindow,
        reserveTokens: computeReserveTokens(model),
        keepRecentTokens: 20_000,
        tokensBefore: opened.compaction.pendingCompaction?.tokensBefore ?? 0,
        tokensAfter: 0, // filled below
        summaryTokens: 0, // filled below from e.compactionEntry if available
        firstKeptEntryId: "",
        filesRead: [],
        filesModified: [],
        compactionDurationMs: 0,
        succeeded: true,
        backupPath: "",
      };
      // Best-effort extract details from the pi compaction entry
      if (e.compactionEntry?.details) {
        event.filesRead = e.compactionEntry.details.readFiles ?? [];
        event.filesModified = e.compactionEntry.details.modifiedFiles ?? [];
      }
      if (e.compactionEntry?.summary) {
        // Rough token estimate: chars/4
        event.summaryTokens = Math.ceil(e.compactionEntry.summary.length / 4);
      }
      if (e.compactionEntry?.firstKeptEntryId) {
        event.firstKeptEntryId = e.compactionEntry.firstKeptEntryId;
      }
      // Post-compact token measurement
      try {
        const after = (await opened.session.buildContext()).messages;
        const { estimateContextTokens } = await import("@earendil-works/pi-agent-core");
        event.tokensAfter = estimateContextTokens(after).tokens;
      } catch { /* best-effort */ }

      await appendDevLogLine(
        formatDevLogLine(event),
        `${this.opts.config.memoryDir ?? `${this.opts.config.dataDir}/memory`}/projects/ytsejam/dev-log.md`,
      );
      await appendSessionCompactionJsonl(
        opened.session.id,
        serializeJsonRecord(event),
        this.opts.config.dataDir,
      );
    } catch (err) {
      console.error("[compaction] session_compact observability failed:", err);
    }
  });
}
```

4. **In the dispatch path** — where the next user message is about to be sent (search for `phase === "idle"` or where the loop hands off to the provider) — insert immediately BEFORE the next provider call:

```ts
if (compactionEnabled() && opened.compaction?.pendingCompaction) {
  await runCompactionIfPending(opened, this.opts.config.dataDir, this.opts.sessionRepo);
}
```

5. **In the provider-response handler** — where AssistantMessages come back from the harness/loop — add the reactive-error path:

```ts
if (msg.stopReason === "error" && compactionEnabled()) {
  const model = harness.getModel();
  if (classifyOverflow(msg, model)) {
    if (opened.compaction.reactiveRetryAttempted) {
      // Already tried once — surrender
      const surrenderText = buildSurrenderMessage(
        decideCompaction(await opened.session.buildContext().then(c => c.messages), model).tokensBefore,
        model.contextWindow,
      );
      // Emit as an assistant message via the existing event channel
      // (use whatever mechanism manager.ts uses to push an assistant message)
      opened.events.emit("assistant", { role: "assistant", content: [{ type: "text", text: surrenderText }] });
      opened.compaction.reactiveRetryAttempted = false;
      return;
    }
    opened.compaction.reactiveRetryAttempted = true;
    opened.compaction.pendingCompaction = {
      trigger: "reactive",
      reason: "isContextOverflow",
      tokensBefore: 0,
      budget: model.contextWindow - computeReserveTokens(model),
    };
    await runCompactionIfPending(opened, this.opts.config.dataDir, this.opts.sessionRepo);
    // Re-dispatch the previous user message (mechanism depends on the loop's structure)
    // ...
  }
}
// Reset on any non-error or non-overflow turn
if (msg.stopReason !== "error") {
  if (opened.compaction) opened.compaction.reactiveRetryAttempted = false;
}
```

> **NOTE TO IMPLEMENTER:** The exact code shapes for §3, §4, §5 above are scaffolds — the real signatures depend on what manager.ts looks like today. The implementer must:
> - Read manager.ts to find where the harness is constructed, the dispatch loop runs, and assistant messages come back.
> - Find the correct opened-session object to attach `compaction:` to.
> - Use whatever event/emit pattern manager.ts already uses to push assistant messages.
> - Re-dispatch on reactive retry uses whatever the loop's "send this user message" entry point is.
>
> Keep the wiring delta as small as possible. The orchestrator (`runCompactionIfPending`) is the contract — it returns enough information for the caller to decide flow. Don't duplicate decision logic in manager.ts.

### Step 5: Run all tests

Run: `env -u NODE_ENV npx vitest run server/src`

Expected: PASS — all existing tests + new compaction tests.

### Step 6: Verify gate

Run: `bash scripts/gate.sh`

Expected: `=== gate: PASSED ===`.

### Step 7: Commit

```bash
git add server/src/compaction.ts server/test/compaction.test.ts server/src/manager.ts
git commit -m "feat(compaction): orchestrator + main-session wiring in manager.ts

- runCompactionIfPending orchestrator: backup → harness.compact → verify → return result
- manager.ts wires three hooks: turn_end (proactive flag), session_compact (observability),
  reactive-error (classifyOverflow → force compact + retry once → surrender)
- All wiring gated behind compactionEnabled() — kill switch at boot
- Per-session backup chain (keep 3) + verify-on-load + user-visible surrender on corruption

Spec: docs/plans/2026-06-12-context-compaction-design.md §D1 + §D4 + §3.1 + §3.6."
```

---

## Task 6: Subagent wiring (task-manager.ts) — DONE

**Files:**
- Modified: `server/src/task-manager.ts`
- Modified: `server/src/compaction.ts` (typed adapter)
- Modified: `server/src/manager.ts` (adapter call sites)

Implemented: task-manager now carries per-task active harness state with session metadata and optional compaction wiring, subscribes to harness events, sets proactive/reactive pending flags at `turn_end`, runs the shared orchestrator at `agent_end`, records subagent-prefixed observability with `subagentTaskId = taskId` and `sessionId = parentSessionId`, and retries reactive overflow once with `REACTIVE_RETRY_PROMPT`. The Task 5 metadata bridge has been refactored through `toOpenedForCompaction(...)`, so neither manager nor task-manager mutates pi Session objects or casts at `runCompactionIfPending` call sites.

### Step 1: Read task-manager.ts to find the harness construction point — DONE

```bash
grep -n "AgentHarness\|harness\.on\|turn_end\|setModel\|session" server/src/task-manager.ts | head -30
```

### Step 2: Apply the same wiring pattern as Task 5 — DONE

Implemented differences from manager.ts:
- The active object is per-task and contains `{ taskId, parentSessionId, metadata, session, harness, compaction? }`.
- `CompactionEvent.subagentTaskId` is the delegated task id; `CompactionEvent.sessionId` is the parent session id, so dev-log lines read `subagent task <task-id> (parent session <id>)`.
- There is no idle hook. Proactive compaction runs at `agent_end`; reactive compaction runs at `agent_end` and queues one retry via `setTimeout(0)` + `REACTIVE_RETRY_PROMPT`. If surrender occurs, the task fails with the diagnostic text.

### Step 3: Run direct compaction tests — DONE

Run: `env -u NODE_ENV npx vitest run server/test/compaction.test.ts`

Expected: PASS.

### Step 4: Verify gate — DONE

Run: `bash scripts/gate.sh`

Expected: `=== gate: PASSED ===`.

### Step 5: Commit — DONE

Committed with manager/task-manager wiring, typed adapter, tests, and docs in one Task 6 commit.

---

## Task 7: Gate-skipped integration test

**Files:**
- Create: `server/test/compaction.integration.test.ts`

### Step 1: Write the gate-skipped integration test

Create `server/test/compaction.integration.test.ts`:

```ts
/**
 * Real-LLM smoke test — gate-skipped.
 *
 * Run manually with:
 *   INTEGRATION=1 env -u NODE_ENV npx vitest run server/test/compaction.integration.test.ts
 *
 * Excluded from scripts/gate.sh by the describe.skipIf at the top.
 */
import { describe, it, expect } from "vitest";

const INTEGRATION = process.env.INTEGRATION === "1";

describe.skipIf(!INTEGRATION)("compaction integration (real harness)", () => {
  it.todo("compacts a real session against a small-context faux model");
  // Implementer fills in:
  //   1. Construct a real AgentHarness with a faux-provider model:
  //        contextWindow: 4000, maxTokens: 256
  //   2. Feed enough tool I/O to cross the threshold
  //      (e.g. 10 synthetic read calls that each return ~500 tokens of content)
  //   3. Drive one more turn → assert opened.compaction.pendingCompaction is set
  //   4. Drive another turn → assert runCompactionIfPending was called and succeeded
  //   5. Reload session via JsonlSessionRepo → assert it loads cleanly
  //   6. Read compactions.jsonl → assert one record present with succeeded:true
  //   7. Read dev-log → assert one "compaction in session" line present
});
```

(The `it.todo` keeps the test passing without implementation — the integration test is scaffolding the implementer can flesh out during dev-time. We're shipping the *gate-skipped contract*, not the full real-LLM flow today — that needs API access and Brian's hand on the keyboard for the smoke run.)

### Step 2: Verify gate skips it

Run: `bash scripts/gate.sh`

Expected: `=== gate: PASSED ===`. The integration test runs but the `describe.skipIf` skips its body.

### Step 3: Verify manual run is well-formed

Run: `INTEGRATION=1 env -u NODE_ENV npx vitest run server/test/compaction.integration.test.ts`

Expected: One `todo` test reported (not failure). Confirms the run path works.

### Step 4: Commit

```bash
git add server/test/compaction.integration.test.ts
git commit -m "test(compaction): gate-skipped integration test scaffold

describe.skipIf(!INTEGRATION) keeps it out of scripts/gate.sh runs.
Manual run: INTEGRATION=1 env -u NODE_ENV npx vitest run server/test/compaction.integration.test.ts.

Body left as it.todo for follow-up — needs real provider API access for the
end-to-end smoke flow. Contract is the gate-skipped run path itself; the
real-LLM body is fleshed out before Brian's cutover smoke.

Spec: docs/plans/2026-06-12-context-compaction-design.md §D7 + §6."
```

---

## Task 8: Kill-switch documentation

**Files:**
- Modify: `deploy/ytsejam.env.example`
- Modify: `deploy/README.md`

### Step 1: Document the env var in `deploy/ytsejam.env.example`

Append to `deploy/ytsejam.env.example`:

```
# Context-window compaction kill switch.
# Defaults to enabled. Set to "false" (case-insensitive) to disable compaction
# entirely — sessions will then 400 with "prompt is too long" on overflow as
# they did before the compaction module landed. Emergency override only.
# Requires `systemctl --user restart ytsejam` to take effect.
# YTSEJAM_COMPACTION_ENABLED=false
```

### Step 2: Add the operator note to `deploy/README.md`

Find the existing env-vars section in `deploy/README.md` and add:

```markdown
### Context-window compaction

ytsejam auto-compacts long sessions at idle boundaries before they hit the
selected model's context-window limit. Calibration is model-aware (every
catalog entry in `@earendil-works/pi-ai` carries its own `contextWindow`
and `maxTokens`); no per-model configuration is required.

Per-session pre-compact backups live at
`~/.ytsejam/data/sessions/<id>/session.jsonl.pre-compact-<timestamp>` (last 3 kept).
Per-compaction structured logs at
`~/.ytsejam/data/sessions/<id>/compactions.jsonl`.
Each compaction also writes a one-line summary to the cog dev-log.

**Emergency disable.** If a bug in the compaction module is corrupting
sessions or otherwise misbehaving, set `YTSEJAM_COMPACTION_ENABLED=false`
in `~/.ytsejam/ytsejam.env` and `systemctl --user restart ytsejam`. The
service reverts to no-compaction behavior — sessions will 400 with
"prompt is too long" on overflow, the same as before the compaction module
landed. This is a known-bad-but-survivable state while a fix ships.
```

### Step 3: Verify gate

Run: `bash scripts/gate.sh`

Expected: `=== gate: PASSED ===`.

### Step 4: Commit

```bash
git add deploy/ytsejam.env.example deploy/README.md
git commit -m "docs(deploy): document YTSEJAM_COMPACTION_ENABLED kill switch

ytsejam.env.example: commented entry with the disable semantics + restart
requirement. deploy/README.md: operator section explaining the auto-compaction
default + the backup/observability paths + the emergency-disable procedure.

Spec: docs/plans/2026-06-12-context-compaction-design.md §D8 + §5."
```

---

## Final verification

After all tasks complete, run the gate one more time from the worktree root:

```bash
cd /tmp/context-compaction
bash scripts/gate.sh
```

Expected: `=== gate: PASSED ===`.

Then confirm the branch is ready:

```bash
git log --oneline main..feat/context-compaction
```

Expected: 8 commits (one per task), all on `feat/context-compaction`.

Then hand off to `/ship` for the PR.

---

## Acceptance checklist (re-stated for /ship)

The compaction PR is ready to merge when ALL hold:

- [ ] `scripts/gate.sh` green from the worktree
- [ ] All 8 task commits present on `feat/context-compaction`
- [ ] Unit tests cover decision, classification, calibration, observability, kill switch, backup, verify, orchestrator (~32+ cases)
- [ ] Wiring tests for orchestrator (mocked harness) pass
- [ ] Integration test scaffold is gate-skipped (verified with `bash scripts/gate.sh` and confirmed by `INTEGRATION=1 npx vitest run server/test/compaction.integration.test.ts` reporting `4 todo`)
- [ ] `deploy/ytsejam.env.example` documents `YTSEJAM_COMPACTION_ENABLED`
- [ ] `deploy/README.md` has the operator section
- [ ] Two-stage review (spec compliance + code quality) on each task that touched server source
- [ ] No grep hit for `cogmemory` regressions, no grep hit for daemon references reintroduced
- [ ] No new dependencies in `server/package.json`
- [ ] No upstream changes to `@earendil-works/pi-*` packages
