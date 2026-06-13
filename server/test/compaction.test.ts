import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, AssistantMessage } from "@earendil-works/pi-ai";

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-agent-core")>();
  return {
    ...actual,
    compact: vi.fn(),
    prepareCompaction: vi.fn(),
  };
});
vi.mock("../src/compaction.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/compaction.ts")>();
  return {
    ...actual,
    runInlineCompactionInLoop: vi.fn(actual.runInlineCompactionInLoop),
  };
});
import type {
  AgentHarness,
  AgentMessage,
  JsonlSessionMetadata,
  JsonlSessionRepo,
  Session,
} from "@earendil-works/pi-agent-core";
import {
  compact,
  prepareCompaction,
} from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, makeManager, setupFaux } from "./helpers.ts";

import {
  computeReserveTokens,
  buildSettings,
  decideCompaction,
  estimateKeptSetTokens,
  classifyOverflow,
  CUSTOM_INSTRUCTIONS,
  buildSurrenderMessage,
  buildSurrenderAgentMessage,
  buildCompactionEvent,
  formatDevLogLine,
  serializeJsonRecord,
  compactionEnabled,
  appendDevLogLine,
  appendSessionCompactionJsonl,
  snapshotSessionJsonl,
  pruneOldBackups,
  verifySessionLoadable,
  runCompactionIfPending,
  runInlineCompactionInLoop,
  toOpenedForCompaction,
  type CompactionEvent,
  type CompactionWiringState,
  type OpenedForCompaction,
} from "../src/compaction.ts";

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
  }) as Model<any>;

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
      stopReason: "stop",
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test-model",
    }) as AgentMessage;

  const userMsg = (text: string): AgentMessage =>
    ({ role: "user", content: [{ type: "text", text }] }) as AgentMessage;

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
    expect(
      decideCompaction([assistantMsgWithUsage(919_616)], model).shouldFire,
    ).toBe(false);
    expect(
      decideCompaction([assistantMsgWithUsage(919_617)], model).shouldFire,
    ).toBe(true);
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

describe("estimateKeptSetTokens", () => {
  it("returns summaryTokens alone when messages array is empty", () => {
    const r = estimateKeptSetTokens([], 1500);
    expect(r).toBe(1500);
  });

  it("adds char/4 heuristic for string-content messages", () => {
    const messages: any[] = [
      { role: "user", content: "x".repeat(400) }, // 100 tokens
      { role: "assistant", content: "y".repeat(800) }, // 200 tokens
    ];
    const r = estimateKeptSetTokens(messages, 0);
    expect(r).toBe(300);
  });

  it("adds char/4 heuristic for array-content messages (text parts)", () => {
    const messages: any[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "x".repeat(400) }, // 100
          { type: "text", text: "y".repeat(400) }, // 100
        ],
      },
    ];
    const r = estimateKeptSetTokens(messages, 0);
    expect(r).toBe(200);
  });

  it("ignores toolCall blocks (the .arguments JSON is dropped)", () => {
    const messages: any[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "x".repeat(400) }, // 100
          {
            type: "toolCall",
            id: "t1",
            name: "bash",
            arguments: { command: "y".repeat(10_000) },
          },
        ],
      },
    ];
    // Deliberately under-counts: toolCall.arguments JSON is dropped because the
    // current helper only sums {type:"text"} text parts. The reserveTokens
    // cushion (~48k) absorbs this slop for the succeeded gate's purpose.
    const r = estimateKeptSetTokens(messages, 0);
    expect(r).toBe(100);
  });

  it("ignores thinking blocks (the .thinking text is dropped)", () => {
    const messages: any[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "x".repeat(400) }, // 100
          { type: "thinking", thinking: "y".repeat(10_000) },
        ],
      },
    ];
    // Same rationale as toolCall: under-counted by design, absorbed by cushion.
    const r = estimateKeptSetTokens(messages, 0);
    expect(r).toBe(100);
  });

  it("silently treats malformed/missing content as 0 chars (defensive)", () => {
    // The AgentMessage union has members without a .content field
    // (compactionSummary, branchSummary, bashExecution). The cast
    // (msg as any).content is undefined for those at runtime — the function
    // MUST NOT throw. Same for messages where a future producer accidentally
    // emits non-string/non-array content.
    const messages: any[] = [
      { role: "compactionSummary", summary: "x".repeat(4000) }, // no .content field
      { role: "user", content: null },
      { role: "user", content: undefined },
      { role: "user", content: 42 },
      { role: "user", content: {} }, // not an array, not a string
      {
        role: "user",
        content: [
          null,
          undefined,
          { type: "text" },
          { type: "text", text: 42 },
        ],
      }, // malformed array parts
      { role: "user", content: "x".repeat(40) }, // 10 — one valid signal so the result isn't 0
    ];
    const r = estimateKeptSetTokens(messages, 0);
    expect(r).toBe(10);
  });

  it("sums summaryTokens + messages heuristic", () => {
    const messages: any[] = [{ role: "user", content: "x".repeat(400) }]; // 100
    const r = estimateKeptSetTokens(messages, 2500);
    expect(r).toBe(2600);
  });

  it("does NOT consult usage.totalTokens on any message", () => {
    // The whole point of this helper: ignore stale provider-usage anchors.
    const messages: any[] = [
      {
        role: "assistant",
        content: "x".repeat(400), // 100 tokens by heuristic
        usage: { totalTokens: 999_999, input: 0, output: 0 },
      },
    ];
    const r = estimateKeptSetTokens(messages, 0);
    expect(r).toBe(100);
  });
});

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
    const m = {
      ...overflowMsg,
      errorMessage: "request_too_large: tokens exceed",
    } as AssistantMessage;
    expect(classifyOverflow(m, model)).toBe(true);
  });

  it("returns false on rate-limit error (stopReason=error but not overflow)", () => {
    const m = {
      ...overflowMsg,
      errorMessage: "429 rate limit exceeded, retry after 30s",
    } as AssistantMessage;
    expect(classifyOverflow(m, model)).toBe(false);
  });

  it("returns false on stopReason=stop (not an error at all)", () => {
    const m = {
      ...overflowMsg,
      stopReason: "stop",
      errorMessage: undefined,
    } as AssistantMessage;
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

describe("formatDevLogLine", () => {
  const baseEvent: CompactionEvent = {
    timestamp: new Date("2026-06-12T14:32:18.412Z"),
    sessionId: "abc123",
    subagentTaskId: null,
    trigger: "proactive",
    reason: "above 920000 budget",
    model: "anthropic/claude-sonnet-4-6",
    contextWindow: 1_000_000,
    reserveTokens: 80_000,
    keepRecentTokens: 20_000,
    tokensBeforeEstimated: 947_112,
    tokensAfterEstimated: 184_309,
    summaryTokens: 4_821,
    firstKeptEntryId: "evt_8f12",
    filesRead: ["server/src/manager.ts"],
    filesModified: ["server/src/compaction.ts"],
    compactionDurationMs: 8_412,
    succeeded: true,
    backupPath:
      "/tmp/ytsejam-test-data/sessions/--chat--/2026-06-12T14-32-18-412Z_abc123.jsonl.pre-compact-1718193600000",
    entryPoint: "idle",
  };

  it("formats a single line for proactive main-session compaction", () => {
    const line = formatDevLogLine(baseEvent);
    expect(line).toMatch(
      /^2026-06-12.*: compaction in session abc123 — proactive/,
    );
    expect(line).toMatch(/anthropic\/claude-sonnet-4-6/);
    expect(line).toMatch(/ctx ~947112→~184309 tokens/);
    expect(line).toMatch(/summary 4821 tokens/);
    expect(line).toMatch(/Trigger: above 920000 budget/);
    expect(line).toMatch(/ via=idle$/);
  });

  it("adds subagent prefix when subagentTaskId is present", () => {
    const e = { ...baseEvent, subagentTaskId: "task-xyz" };
    const line = formatDevLogLine(e);
    expect(line).toMatch(/subagent task task-xyz \(parent session abc123\)/);
  });

  it("formats reactive trigger explicitly", () => {
    const e = {
      ...baseEvent,
      trigger: "reactive" as const,
      reason: "isContextOverflow",
    };
    const line = formatDevLogLine(e);
    expect(line).toMatch(/reactive/);
    expect(line).toMatch(/Trigger: isContextOverflow/);
  });

  it("includes FAILED marker when succeeded=false", () => {
    const e = { ...baseEvent, succeeded: false };
    expect(formatDevLogLine(e)).toMatch(/FAILED/);
  });

  it("CompactionEvent carries an entryPoint field and serializes to snake_case", () => {
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
    expect(record.entry_point).toBe("inner_loop");
  });

  it("formatDevLogLine appends via=<entryPoint>", () => {
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
    expect(line).toContain("via=inner_loop");
  });
});

describe("buildCompactionEvent", () => {
  const sessionFilePath =
    "/tmp/sessions/--chat--/2026-06-12T00-00-00-000Z_test-session.jsonl";

  it("uses the result.pending snapshot for trigger label (PROACTIVE case)", () => {
    const event = buildCompactionEvent(
      fauxModel(1_000_000, 64_000),
      sessionFilePath,
      {
        fired: true,
        succeeded: true,
        durationMs: 1234,
        backupPath: "/tmp/session.jsonl.pre-compact-1",
        pending: {
          trigger: "proactive",
          reason: "above 800000 budget",
          tokensBefore: 850_000,
          budget: 800_000,
        },
      },
      {},
      "idle",
    );

    expect(event.trigger).toBe("proactive");
    expect(event.reason).toBe("above 800000 budget");
    expect(event.tokensBeforeEstimated).toBe(850_000);
    expect(formatDevLogLine(event)).toContain("proactive");
    expect(formatDevLogLine(event)).toContain("Trigger: above 800000 budget");
  });

  it("uses the result.pending snapshot for trigger label (REACTIVE case)", () => {
    const event = buildCompactionEvent(
      fauxModel(1_000_000, 64_000),
      sessionFilePath,
      {
        fired: true,
        succeeded: true,
        pending: {
          trigger: "reactive",
          reason: "isContextOverflow",
          tokensBefore: 0,
          budget: 800_000,
        },
      },
      {},
      "reactive_path",
    );

    expect(event.trigger).toBe("reactive");
    expect(event.reason).toBe("isContextOverflow");
    expect(formatDevLogLine(event)).toContain("reactive");
    expect(formatDevLogLine(event)).toContain("Trigger: isContextOverflow");
  });

  it("falls through reactive pending tokensBefore=0 to compactionEntry tokensBefore", () => {
    const event = buildCompactionEvent(
      fauxModel(1_000_000, 64_000),
      sessionFilePath,
      {
        fired: true,
        succeeded: true,
        pending: {
          trigger: "reactive",
          reason: "isContextOverflow",
          tokensBefore: 0,
          budget: 800_000,
        },
      },
      { tokensBefore: 12_345 },
      "reactive_path",
    );

    expect(event.tokensBeforeEstimated).toBe(12_345);
  });

  it("records succeeded:false correctly when result.succeeded is false", () => {
    const event = buildCompactionEvent(
      fauxModel(1_000_000, 64_000),
      sessionFilePath,
      {
        fired: true,
        succeeded: false,
        error: new Error("summarization_failed"),
        pending: {
          trigger: "proactive",
          reason: "above 800000 budget",
          tokensBefore: 850_000,
          budget: 800_000,
        },
      },
      {},
      "idle",
    );

    expect(event.succeeded).toBe(false);
    expect(formatDevLogLine(event)).toMatch(/FAILED/);
  });

  it("uses subagent task id and parent session id from compaction entry", () => {
    const event = buildCompactionEvent(
      fauxModel(1_000_000, 64_000),
      sessionFilePath,
      {
        fired: true,
        succeeded: true,
        pending: {
          trigger: "proactive",
          reason: "above 800000 budget",
          tokensBefore: 850_000,
          budget: 800_000,
        },
      },
      {
        sessionId: "parent-session-123",
        subagentTaskId: "task-abc",
        tokensAfter: 120_000,
      },
      "idle",
    );

    expect(event.sessionId).toBe("parent-session-123");
    expect(event.subagentTaskId).toBe("task-abc");
    expect(formatDevLogLine(event)).toContain(
      "subagent task task-abc (parent session parent-session-123)",
    );
  });

  it("marks succeeded=false when kept-set estimate exceeds budget", () => {
    const event = buildCompactionEvent(
      fauxModel(1_000_000, 64_000),
      sessionFilePath,
      {
        fired: true,
        succeeded: true, // harness path succeeded
        durationMs: 1000,
        backupPath: "/tmp/session.jsonl.pre-compact-x",
        pending: {
          trigger: "proactive",
          reason: "test",
          tokensBefore: 850_000,
          budget: 100_000,
        },
      },
      {
        tokensBefore: 850_000,
        tokensAfter: 250_000, // 2.5x over budget — should flip succeeded
        summaryTokens: 2000,
      },
      "idle",
    );
    expect(event.succeeded).toBe(false);
    expect(event.reason).toMatch(/KEPT_SET_OVERSIZED/);
    expect(event.reason).toContain("tokensAfterEstimated=250000");
    expect(event.reason).toContain("budget=100000");
  });

  it("marks succeeded=true when kept-set estimate fits under budget", () => {
    const event = buildCompactionEvent(
      fauxModel(1_000_000, 64_000),
      sessionFilePath,
      {
        fired: true,
        succeeded: true,
        durationMs: 1000,
        backupPath: "/tmp/session.jsonl.pre-compact-x",
        pending: {
          trigger: "proactive",
          reason: "test",
          tokensBefore: 850_000,
          budget: 100_000,
        },
      },
      {
        tokensBefore: 850_000,
        tokensAfter: 60_000, // under 100k budget
        summaryTokens: 2000,
      },
      "idle",
    );
    expect(event.succeeded).toBe(true);
    expect(event.reason).not.toMatch(/KEPT_SET_OVERSIZED/);
  });

  it("does NOT add the post-condition when harness path already failed", () => {
    // If harness.compact() threw, succeeded=false stands regardless of estimate.
    // The reason should be the harness error, not KEPT_SET_OVERSIZED.
    const event = buildCompactionEvent(
      fauxModel(1_000_000, 64_000),
      sessionFilePath,
      {
        fired: true,
        succeeded: false,
        durationMs: 1000,
        backupPath: "/tmp/session.jsonl.pre-compact-x",
        pending: {
          trigger: "proactive",
          reason: "test",
          tokensBefore: 850_000,
          budget: 100_000,
        },
        error: new Error("compact threw"),
      },
      {
        tokensBefore: 850_000,
        tokensAfter: 60_000, // would pass the post-condition if checked
        summaryTokens: 2000,
      },
      "idle",
    );
    expect(event.succeeded).toBe(false);
    expect(event.reason).not.toMatch(/KEPT_SET_OVERSIZED/);
    expect(event.reason).toContain("compact threw");
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
      tokensBeforeEstimated: 950,
      tokensAfterEstimated: 200,
      summaryTokens: 10,
      firstKeptEntryId: "evt",
      filesRead: [],
      filesModified: [],
      compactionDurationMs: 100,
      succeeded: true,
      backupPath: "/tmp/x",
      entryPoint: "idle",
    };
    const json = serializeJsonRecord(e);
    const parsed = JSON.parse(JSON.stringify(json));
    expect(parsed.timestamp).toBe("2026-06-12T14:32:18.412Z");
    expect(parsed.session_id).toBe("abc");
    expect(parsed.subagent_task_id).toBeNull();
    expect(parsed.trigger).toBe("proactive");
    expect(parsed.context_window).toBe(1000);
    expect(parsed.reserve_tokens).toBe(100);
    expect(parsed.tokens_before_estimated).toBe(950);
    expect(parsed.tokens_after_estimated).toBe(200);
    expect(parsed.summary_tokens).toBe(10);
    expect(parsed.files_read).toEqual([]);
    expect(parsed.files_modified).toEqual([]);
    expect(parsed.compaction_duration_ms).toBe(100);
    expect(parsed.succeeded).toBe(true);
    expect(parsed.backup_path).toBe("/tmp/x");
  });
});

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
  let sessionFilePath: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "compaction-test-"));
    const sessionDir = join(tmp, "sessions", "--chat--");
    await mkdir(sessionDir, { recursive: true });
    sessionFilePath = join(
      sessionDir,
      "2026-06-12T00-00-00-000Z_test-uuid.jsonl",
    );
    await writeFile(sessionFilePath, "line1\nline2\n");
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

  it("appends a JSON line to <sessionFilePath>.compactions.jsonl", async () => {
    await appendSessionCompactionJsonl(sessionFilePath, { foo: 1, bar: "x" });
    await appendSessionCompactionJsonl(sessionFilePath, { foo: 2 });
    const path = `${sessionFilePath}.compactions.jsonl`;
    const content = await readFile(path, "utf8");
    const lines = content
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([{ foo: 1, bar: "x" }, { foo: 2 }]);
  });
});

describe("snapshotSessionJsonl + pruneOldBackups", () => {
  let tmp: string;
  let sessionDir: string;
  let sessionFilePath: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "compaction-test-"));
    sessionDir = join(tmp, "sessions", "--chat--");
    await mkdir(sessionDir, { recursive: true });
    sessionFilePath = join(
      sessionDir,
      "2026-06-12T00-00-00-000Z_test-uuid.jsonl",
    );
    await writeFile(sessionFilePath, "line1\nline2\n");
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("creates a backup file with pre-compact-<timestamp> suffix", async () => {
    const backupPath = await snapshotSessionJsonl(sessionFilePath);
    expect(backupPath).toMatch(/\.pre-compact-\d+$/);
    expect(backupPath.startsWith(`${sessionFilePath}.pre-compact-`)).toBe(true);
    const content = await readFile(backupPath, "utf8");
    expect(content).toBe("line1\nline2\n");
  });

  it("rejects when source file is missing", async () => {
    const missing = join(tmp, "sessions", "--chat--", "nonexistent.jsonl");
    await expect(snapshotSessionJsonl(missing)).rejects.toThrow();
  });

  it("pruneOldBackups keeps the N most recent", async () => {
    // create 5 backups with increasing timestamps in the filename
    for (let i = 1; i <= 5; i++) {
      await writeFile(
        `${sessionFilePath}.pre-compact-${1000 + i}`,
        `backup ${i}`,
      );
    }
    await pruneOldBackups(sessionFilePath, 3);
    const files = (await readdir(sessionDir))
      .filter((f) => f.includes("pre-compact"))
      .sort();
    expect(files).toEqual([
      "2026-06-12T00-00-00-000Z_test-uuid.jsonl.pre-compact-1003",
      "2026-06-12T00-00-00-000Z_test-uuid.jsonl.pre-compact-1004",
      "2026-06-12T00-00-00-000Z_test-uuid.jsonl.pre-compact-1005",
    ]);
  });

  it("pruneOldBackups is a no-op when fewer backups than keepLast", async () => {
    await writeFile(`${sessionFilePath}.pre-compact-1001`, "only one");
    await pruneOldBackups(sessionFilePath, 3);
    const files = (await readdir(sessionDir)).filter((f) =>
      f.includes("pre-compact"),
    );
    expect(files).toEqual([
      "2026-06-12T00-00-00-000Z_test-uuid.jsonl.pre-compact-1001",
    ]);
  });

  it("pruneOldBackups handles realistic 13-digit ms timestamps correctly", async () => {
    for (const ts of [
      "1718193600000",
      "1718193600001",
      "1718193600999",
      "1718280000000",
    ]) {
      await writeFile(`${sessionFilePath}.pre-compact-${ts}`, `backup ${ts}`);
    }
    await pruneOldBackups(sessionFilePath, 2);
    const files = (await readdir(sessionDir))
      .filter((f) => f.includes("pre-compact"))
      .sort();
    expect(files).toEqual([
      "2026-06-12T00-00-00-000Z_test-uuid.jsonl.pre-compact-1718193600999",
      "2026-06-12T00-00-00-000Z_test-uuid.jsonl.pre-compact-1718280000000",
    ]);
  });
});

describe("verifySessionLoadable", () => {
  it("returns ok:true when reload resolves", async () => {
    const reload = async () => ({ id: "sid" });
    const result = await verifySessionLoadable(reload);
    expect(result.ok).toBe(true);
  });

  it("returns ok:false with error when reload rejects", async () => {
    const reload = async () => {
      throw new Error("corrupted");
    };
    const result = await verifySessionLoadable(reload);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe("corrupted");
  });

  it("captures non-Error throws as Error", async () => {
    const reload = async () => {
      throw "plain string";
    };
    const result = await verifySessionLoadable(reload);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe("plain string");
  });
});

describe("toOpenedForCompaction", () => {
  it("adapts session metadata without mutating the original session object", () => {
    const metadata = {
      id: "adapter-session",
      cwd: "chat",
      path: "/tmp/sessions/--chat--/2026_adapter-session.jsonl",
      createdAt: "2026-06-12T00:00:00.000Z",
    } as JsonlSessionMetadata;
    const session = {
      getMetadata: async () => metadata,
    } as unknown as Session<JsonlSessionMetadata>;
    const harness = { compact: async () => {} } as unknown as AgentHarness;
    const compaction: CompactionWiringState = {
      pendingCompaction: null,
      reactiveRetryAttempted: false,
    };

    const opened = toOpenedForCompaction({
      session,
      metadata,
      harness,
      compaction,
    });

    expect(opened.session.metadata).toBe(metadata);
    expect(opened.harness).toBe(harness);
    expect(opened.compaction).toBe(compaction);
    expect("metadata" in session).toBe(false);
  });
});

describe("runCompactionIfPending", () => {
  let tmp: string;
  let sessionFilePath: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "orchestrator-test-"));
    const sessionDir = join(tmp, "sessions", "--chat--");
    await mkdir(sessionDir, { recursive: true });
    sessionFilePath = join(
      sessionDir,
      "2026-06-12T00-00-00-000Z_test-uuid.jsonl",
    );
    await writeFile(sessionFilePath, "line\n");
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  // Helper: build a mock OpenedForCompaction with a controllable harness.compact()
  const makeMockOpened = (
    compactImpl: () => Promise<void>,
  ): OpenedForCompaction => {
    const harness = { compact: compactImpl } as unknown as AgentHarness;
    return {
      session: {
        metadata: {
          id: "test-uuid",
          path: sessionFilePath,
        } as JsonlSessionMetadata,
      } as unknown as Session<JsonlSessionMetadata> & {
        metadata: JsonlSessionMetadata;
      },
      harness,
      compaction: { pendingCompaction: null, reactiveRetryAttempted: false },
    };
  };

  const okRepo = { open: async () => ({}) } as unknown as JsonlSessionRepo;
  const failingRepo = {
    open: async () => {
      throw new Error("corrupt");
    },
  } as unknown as JsonlSessionRepo;

  it("returns fired:false when no pending", async () => {
    const opened = makeMockOpened(async () => {});
    const r = await runCompactionIfPending(opened, okRepo);
    expect(r.fired).toBe(false);
  });

  it("calls harness.compact and returns succeeded:true on happy path", async () => {
    let called = false;
    const opened = makeMockOpened(async () => {
      called = true;
    });
    opened.compaction.pendingCompaction = {
      trigger: "proactive",
      reason: "test",
      tokensBefore: 900_000,
      budget: 800_000,
    };
    const r = await runCompactionIfPending(opened, okRepo);
    expect(called).toBe(true);
    expect(r.fired).toBe(true);
    expect(r.succeeded).toBe(true);
    expect(r.pending?.trigger).toBe("proactive");
    expect(r.pending?.reason).toBe("test");
    expect(r.backupPath).toMatch(/\.pre-compact-\d+$/);
    expect(opened.compaction.pendingCompaction).toBeNull(); // cleared
  });

  it("returns succeeded:false on harness.compact error", async () => {
    const opened = makeMockOpened(async () => {
      throw new Error("summarization_failed");
    });
    opened.compaction.pendingCompaction = {
      trigger: "proactive",
      reason: "test",
      tokensBefore: 900_000,
      budget: 800_000,
    };
    const r = await runCompactionIfPending(opened, okRepo);
    expect(r.fired).toBe(true);
    expect(r.succeeded).toBe(false);
    expect(r.pending?.trigger).toBe("proactive");
    expect(r.error?.message).toBe("summarization_failed");
  });

  it("returns surrendered:true when post-compact load fails", async () => {
    const opened = makeMockOpened(async () => {
      /* compact succeeds */
    });
    opened.compaction.pendingCompaction = {
      trigger: "proactive",
      reason: "test",
      tokensBefore: 900_000,
      budget: 800_000,
    };
    const r = await runCompactionIfPending(opened, failingRepo);
    expect(r.fired).toBe(true);
    expect(r.succeeded).toBe(false);
    expect(r.surrendered).toBe(true);
    expect(r.error?.message).toBe("corrupt");
  });

  it("returns succeeded:false on backup failure (source file missing)", async () => {
    const opened = makeMockOpened(async () => {});
    // Point the session at a path that doesn't exist:
    (opened.session as any).metadata.path = join(tmp, "does-not-exist.jsonl");
    opened.compaction.pendingCompaction = {
      trigger: "proactive",
      reason: "test",
      tokensBefore: 900_000,
      budget: 800_000,
    };
    const r = await runCompactionIfPending(opened, okRepo);
    expect(r.fired).toBe(true);
    expect(r.succeeded).toBe(false);
    expect(r.error).toBeDefined();
  });
});

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

    const msg = buildSurrenderAgentMessage(opened, 0) as AssistantMessage;

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
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
  });
});

describe("AgentManager.runPendingInlineCompactionInLoop", () => {
  let faux: ReturnType<typeof setupFaux>;

  beforeEach(() => {
    vi.clearAllMocks();
    faux = setupFaux();
  });

  afterEach(() => {
    faux.unregister();
  });

  const pending = () => ({
    trigger: "proactive" as const,
    reason: "test",
    tokensBefore: 100,
    budget: 50_000,
  });

  const branchEntries = () => [
    {
      type: "message",
      id: "entry-1",
      parentId: null,
      timestamp: "2026-06-13T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    },
  ];

  it("happy path: emits markCompactionStart + markCompactionEnd('succeeded') + recordCompactionEvent and returns newMessages", async () => {
    const { manager } = makeManager(faux);
    const row = await manager.createSession();
    const opened = (manager as any).open.get(row.id);
    opened.compaction.pendingCompaction = pending();

    const newMessages = [
      {
        role: "compactionSummary",
        summary: "X",
        tokensBefore: 100,
        timestamp: "2026-06-13T00:00:01.000Z",
      },
    ] as unknown as AgentMessage[];
    const inlineResult = {
      fired: true,
      succeeded: true,
      newMessages,
      compactionEntryId: "ce-1",
      durationMs: 10,
      pending: pending(),
    };
    vi.mocked(runInlineCompactionInLoop).mockResolvedValueOnce(inlineResult);

    const markStart = vi.spyOn(manager as any, "markCompactionStart");
    const markEnd = vi.spyOn(manager as any, "markCompactionEnd");
    const recordEvent = vi
      .spyOn(manager as any, "recordCompactionEvent")
      .mockResolvedValue(undefined);
    const emitSurrender = vi
      .spyOn(manager as any, "emitCompactionSurrender")
      .mockResolvedValue(undefined);

    const result = await (manager as any).runPendingInlineCompactionInLoop(
      opened,
      branchEntries() as any,
      "inner_loop",
    );

    expect(markStart).toHaveBeenCalledOnce();
    expect(markStart).toHaveBeenCalledWith(opened, "proactive");
    expect(markEnd).toHaveBeenCalledOnce();
    expect(markEnd).toHaveBeenCalledWith(opened, "succeeded");
    expect(recordEvent).toHaveBeenCalledOnce();
    expect(recordEvent).toHaveBeenCalledWith(
      opened,
      inlineResult,
      { firstKeptEntryId: "ce-1" },
      "inner_loop",
    );
    expect(emitSurrender).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.surrendered).toBe(false);
    expect(result.newMessages).toBe(newMessages);
  });

  it("surrender path: emits markCompactionEnd('surrendered') + recordCompactionEvent + emitCompactionSurrender, returns surrendered", async () => {
    const { manager } = makeManager(faux);
    const row = await manager.createSession();
    const opened = (manager as any).open.get(row.id);
    opened.compaction.pendingCompaction = pending();

    const inlineResult = {
      fired: true,
      succeeded: false,
      surrendered: true,
      error: new Error("verify failed"),
      durationMs: 10,
      backupPath: "/tmp/foo.bak",
      pending: pending(),
    };
    vi.mocked(runInlineCompactionInLoop).mockResolvedValueOnce(inlineResult);

    const markStart = vi.spyOn(manager as any, "markCompactionStart");
    const markEnd = vi.spyOn(manager as any, "markCompactionEnd");
    const recordEvent = vi
      .spyOn(manager as any, "recordCompactionEvent")
      .mockResolvedValue(undefined);
    const emitSurrender = vi
      .spyOn(manager as any, "emitCompactionSurrender")
      .mockResolvedValue(undefined);

    const result = await (manager as any).runPendingInlineCompactionInLoop(
      opened,
      branchEntries() as any,
      "inner_loop",
    );

    expect(markStart).toHaveBeenCalledOnce();
    expect(markStart).toHaveBeenCalledWith(opened, "proactive");
    expect(markEnd).toHaveBeenCalledOnce();
    expect(markEnd).toHaveBeenCalledWith(opened, "surrendered");
    expect(recordEvent).toHaveBeenCalledOnce();
    expect(emitSurrender).toHaveBeenCalledOnce();
    expect(emitSurrender).toHaveBeenCalledWith(opened);
    expect(result.ok).toBe(false);
    expect(result.surrendered).toBe(true);
    expect(result.newMessages).toBeUndefined();
  });

  it("no-op when opened.compaction.pendingCompaction is null: no pill, no telemetry, returns {ok:true, surrendered:false}", async () => {
    const { manager } = makeManager(faux);
    const row = await manager.createSession();
    const opened = (manager as any).open.get(row.id);
    opened.compaction.pendingCompaction = null;

    const markStart = vi.spyOn(manager as any, "markCompactionStart");
    const markEnd = vi.spyOn(manager as any, "markCompactionEnd");
    const recordEvent = vi
      .spyOn(manager as any, "recordCompactionEvent")
      .mockResolvedValue(undefined);
    const emitSurrender = vi
      .spyOn(manager as any, "emitCompactionSurrender")
      .mockResolvedValue(undefined);

    const result = await (manager as any).runPendingInlineCompactionInLoop(
      opened,
      branchEntries() as any,
      "inner_loop",
    );

    expect(markStart).not.toHaveBeenCalled();
    expect(markEnd).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
    expect(emitSurrender).not.toHaveBeenCalled();
    expect(runInlineCompactionInLoop).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.surrendered).toBe(false);
    expect(result.newMessages).toBeUndefined();
  });
});

describe("runInlineCompactionInLoop", () => {
  let tmp: string;
  let sessionFilePath: string;
  let originalContent: string;

  beforeEach(async () => {
    vi.mocked(prepareCompaction).mockReset();
    vi.mocked(compact).mockReset();

    tmp = await mkdtemp(join(tmpdir(), "inline-orchestrator-test-"));
    const sessionDir = join(tmp, "sessions", "--chat--");
    await mkdir(sessionDir, { recursive: true });
    sessionFilePath = join(
      sessionDir,
      "2026-06-13T00-00-00-000Z_inline-test.jsonl",
    );
    originalContent = "original session content\n";
    await writeFile(sessionFilePath, originalContent);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const pending = () => ({
    trigger: "proactive" as const,
    reason: "inline test",
    tokensBefore: 900_000,
    budget: 800_000,
  });

  const branchEntries = () => [
    {
      type: "message",
      id: "entry-before",
      parentId: null,
      timestamp: "2026-06-13T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "old" }] },
    },
    {
      type: "message",
      id: "entry-X",
      parentId: "entry-before",
      timestamp: "2026-06-13T00:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: "kept" }] },
    },
    {
      type: "message",
      id: "entry-Y",
      parentId: "entry-X",
      timestamp: "2026-06-13T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "kept assistant" }],
        stopReason: "stop",
        api: "anthropic-messages",
        provider: "anthropic",
        model: "test-model",
      },
    },
  ] as any[];

  const preparation = () => ({
    firstKeptEntryId: "entry-X",
    messagesToSummarize: [],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 100,
    fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
    settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 20000 },
  });

  const makeOpened = (appendImpl?: (...args: any[]) => Promise<string>) => {
    const appendCompaction = vi.fn(
      appendImpl ??
        (async () => {
          await writeFile(sessionFilePath, "appended compaction\n");
          return "compaction-entry-1";
        }),
    );
    return {
      session: {
        metadata: {
          id: "inline-test",
          cwd: "chat",
          path: sessionFilePath,
          createdAt: "2026-06-13T00:00:00.000Z",
        } as JsonlSessionMetadata,
        appendCompaction,
      } as unknown as Session<JsonlSessionMetadata> & {
        metadata: JsonlSessionMetadata;
      },
      harness: {
        getModel: () => fauxModel(1_000_000, 64_000),
        getApiKeyAndHeaders: async () => ({
          apiKey: "test-api-key",
          headers: { "x-test": "1" },
        }),
        getThinkingLevel: () => "off",
      } as unknown as AgentHarness,
      compaction: { pendingCompaction: pending(), reactiveRetryAttempted: false },
    } satisfies OpenedForCompaction;
  };

  const okRepo = { open: async () => ({}) } as unknown as JsonlSessionRepo;
  const failingRepo = {
    open: async () => {
      throw new Error("corrupt");
    },
  } as unknown as JsonlSessionRepo;

  it("happy path: writes appendCompaction(..., fromHook:true) and returns newMessages", async () => {
    vi.mocked(prepareCompaction).mockReturnValue({
      ok: true,
      value: preparation() as any,
    });
    vi.mocked(compact).mockResolvedValue({
      ok: true,
      value: {
        summary: "SUM",
        firstKeptEntryId: "entry-X",
        tokensBefore: 100,
        details: { readFiles: [], modifiedFiles: [] },
      },
    });
    const opened = makeOpened();

    const result = await runInlineCompactionInLoop(
      opened,
      branchEntries() as any,
      okRepo,
    );

    expect(result.fired).toBe(true);
    expect(result.succeeded).toBe(true);
    expect(opened.session.appendCompaction).toHaveBeenCalledWith(
      "SUM",
      "entry-X",
      100,
      { readFiles: [], modifiedFiles: [] },
      true,
    );
    expect(result.compactionEntryId).toBe("compaction-entry-1");
    expect(result.newMessages).toHaveLength(3);
    expect(result.newMessages?.[0]).toMatchObject({
      role: "compactionSummary",
      summary: "SUM",
      tokensBefore: 100,
    });
    expect(result.newMessages?.[1]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "kept" }],
    });
    expect(result.newMessages?.[2]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "kept assistant" }],
    });
    expect(opened.compaction.pendingCompaction).toBeNull();
  });

  it("no-op when prepareCompaction returns undefined", async () => {
    vi.mocked(prepareCompaction).mockReturnValue({ ok: true, value: undefined });
    const opened = makeOpened();

    const result = await runInlineCompactionInLoop(
      opened,
      branchEntries() as any,
      okRepo,
    );

    expect(result.fired).toBe(false);
    expect(opened.session.appendCompaction).not.toHaveBeenCalled();
    expect(vi.mocked(compact)).not.toHaveBeenCalled();
  });

  it("error when prepareCompaction returns Result.err", async () => {
    vi.mocked(prepareCompaction).mockReturnValue({
      ok: false,
      error: new Error("prep failed") as any,
    });
    const opened = makeOpened();

    const result = await runInlineCompactionInLoop(
      opened,
      branchEntries() as any,
      okRepo,
    );

    expect(result.fired).toBe(true);
    expect(result.succeeded).toBe(false);
    expect(result.error?.message).toBe("prep failed");
    expect(opened.session.appendCompaction).not.toHaveBeenCalled();
  });

  it("error when compact() returns Result.err", async () => {
    vi.mocked(prepareCompaction).mockReturnValue({
      ok: true,
      value: preparation() as any,
    });
    vi.mocked(compact).mockResolvedValue({
      ok: false,
      error: new Error("compact failed") as any,
    });
    const opened = makeOpened();

    const result = await runInlineCompactionInLoop(
      opened,
      branchEntries() as any,
      okRepo,
    );

    expect(result.fired).toBe(true);
    expect(result.succeeded).toBe(false);
    expect(result.error?.message).toBe("compact failed");
    expect(opened.session.appendCompaction).not.toHaveBeenCalled();
  });

  it("surrender when appendCompaction throws (backup restored)", async () => {
    vi.mocked(prepareCompaction).mockReturnValue({
      ok: true,
      value: preparation() as any,
    });
    vi.mocked(compact).mockResolvedValue({
      ok: true,
      value: {
        summary: "SUM",
        firstKeptEntryId: "entry-X",
        tokensBefore: 100,
        details: {},
      },
    });
    const opened = makeOpened(async () => {
      await writeFile(sessionFilePath, "partial corrupt write\n");
      throw new Error("append failed");
    });

    const result = await runInlineCompactionInLoop(
      opened,
      branchEntries() as any,
      okRepo,
    );

    expect(result.fired).toBe(true);
    expect(result.succeeded).toBe(false);
    expect(result.surrendered).toBe(true);
    expect(result.error?.message).toBe("append failed");
    await expect(readFile(sessionFilePath, "utf8")).resolves.toBe(
      originalContent,
    );
  });

  it("surrender when verifySessionLoadable fails post-write (backup restored)", async () => {
    vi.mocked(prepareCompaction).mockReturnValue({
      ok: true,
      value: preparation() as any,
    });
    vi.mocked(compact).mockResolvedValue({
      ok: true,
      value: {
        summary: "SUM",
        firstKeptEntryId: "entry-X",
        tokensBefore: 100,
        details: {},
      },
    });
    const opened = makeOpened();

    const result = await runInlineCompactionInLoop(
      opened,
      branchEntries() as any,
      failingRepo,
    );

    expect(result.fired).toBe(true);
    expect(result.succeeded).toBe(false);
    expect(result.surrendered).toBe(true);
    expect(result.error?.message).toBe("corrupt");
    await expect(readFile(sessionFilePath, "utf8")).resolves.toBe(
      originalContent,
    );
  });
});
