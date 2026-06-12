import { describe, it, expect } from "vitest";
import type { Model, AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  computeReserveTokens,
  buildSettings,
  decideCompaction,
  classifyOverflow,
  CUSTOM_INSTRUCTIONS,
  buildSurrenderMessage,
  formatDevLogLine,
  serializeJsonRecord,
  type CompactionEvent,
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
      stopReason: "stop",
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test-model",
    } as AgentMessage);

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

  it("returns false on stopReason=stop (not an error at all)", () => {
    const m = { ...overflowMsg, stopReason: "stop", errorMessage: undefined } as AssistantMessage;
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
    tokensBefore: 947_112,
    tokensAfter: 184_309,
    summaryTokens: 4_821,
    firstKeptEntryId: "evt_8f12",
    droppedTurns: 27,
    filesRead: ["server/src/manager.ts"],
    filesModified: ["server/src/compaction.ts"],
    compactionDurationMs: 8_412,
    succeeded: true,
    backupPath: "/home/bjk/.ytsejam/data/sessions/abc123/session.jsonl.pre-compact-1718193600",
  };

  it("formats a single line for proactive main-session compaction", () => {
    const line = formatDevLogLine(baseEvent);
    expect(line).toMatch(/^2026-06-12.*: compaction in session abc123 — proactive/);
    expect(line).toMatch(/anthropic\/claude-sonnet-4-6/);
    expect(line).toMatch(/ctx 947112→184309 tokens/);
    expect(line).toMatch(/dropped 27 turns/);
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
      droppedTurns: 3,
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
    expect(parsed.dropped_turns).toBe(3);
    expect(parsed.files_read).toEqual([]);
    expect(parsed.files_modified).toEqual([]);
    expect(parsed.compaction_duration_ms).toBe(100);
    expect(parsed.succeeded).toBe(true);
    expect(parsed.backup_path).toBe("/tmp/x");
  });
});
