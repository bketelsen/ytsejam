import { isContextOverflow, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
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

/**
 * Wrapper around pi-ai's isContextOverflow for the reactive-backstop path.
 *
 * Deliberately scoped to errors that pi-ai surfaces as `stopReason === "error"`
 * with a recognizable Anthropic error-text pattern (`/prompt is too long/i`,
 * `/request_too_large/i`). pi-ai also has detectors for silent overflow
 * (z.ai length-based with stopReason="stop"; Xiaomi MiMo length-truncation
 * with stopReason="length"), but the guard below makes those UNREACHABLE
 * here — they are intentionally out of scope for the reactive backstop, which
 * only fires on explicit provider errors. If silent-overflow detection ever
 * becomes a requirement (e.g. ytsejam routes to a z.ai/MiMo provider), the
 * guard would need to relax to `["stop","length"].includes(msg.stopReason) &&
 * <usage-based check>` or equivalent — do NOT just delete the guard, which
 * would also classify normal successful turns as overflow.
 *
 * The `model.contextWindow` argument is currently inert (pi-ai only uses it
 * on the now-unreachable silent paths); passed for forward-compat.
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
  droppedTurns: number;
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
 *     <trigger>, <model>, ctx <before>→<after> tokens, dropped <N> turns, summary <S> tokens,
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
    `ctx ${e.tokensBefore}→${e.tokensAfter} tokens, dropped ${e.droppedTurns} turns, ` +
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
    dropped_turns: e.droppedTurns,
    files_read: e.filesRead,
    files_modified: e.filesModified,
    compaction_duration_ms: e.compactionDurationMs,
    succeeded: e.succeeded,
    backup_path: e.backupPath,
  };
}
