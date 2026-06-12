import { appendFile, copyFile, mkdir, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  isContextOverflow,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import {
  estimateContextTokens,
  shouldCompact,
  type AgentHarness,
  type AgentMessage,
  type CompactionSettings,
  type JsonlSessionMetadata,
  type JsonlSessionRepo,
  type Session,
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
 * Structural token estimate for a post-compaction kept-set.
 *
 * Deliberately bypasses pi's `estimateContextTokens` because that function
 * anchors on the last surviving assistant message's `usage.totalTokens` — a
 * value that, immediately post-compaction, is the STALE pre-compaction
 * snapshot from the very turn that triggered compaction. Reading it would
 * tautologically return `tokens_before`.
 *
 * Walks each message and sums `Math.ceil(chars / 4)` over:
 *   - string `.content` (user messages, our synthesized assistant text)
 *   - `{type:"text"}` parts of array `.content` (assistant messages, and the
 *     `content: (TextContent|ImageContent)[]` of `role:"toolResult"` messages —
 *     tool RESULT text IS counted)
 * plus `summaryTokens` (the compaction summary's own token count, passed in).
 *
 * Deliberately OMITS (counts as 0):
 *   - `{type:"toolCall"}` blocks — their `.arguments` JSON (often multi-KB on
 *     bash/delegate/write calls) is not summed
 *   - `{type:"thinking"}` blocks — their `.thinking` text is not summed
 *   - `{type:"image"}` blocks (no text anyway)
 *   - messages whose `.content` is missing/null/non-string-non-array
 *     (compactionSummary/branchSummary/bashExecution union members)
 *
 * Conservative-optimistic by design: the undercount on tool-call-heavy turns
 * can reach ~15-20%, absorbed by the `reserveTokens` cushion (~48k for the
 * production model) when the gate compares the estimate against `budget`.
 * Good enough to gate the `succeeded` post-condition (Task 4); not intended
 * as a billing-grade measurement.
 *
 * See docs/plans/2026-06-12-issue-72-design.md §D4 for the design rationale.
 */
export function estimateKeptSetTokens(
  messages: AgentMessage[],
  summaryTokens: number,
): number {
  let chars = 0;
  for (const msg of messages) {
    const content = (msg as any).content;
    if (typeof content === "string") {
      chars += content.length;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part && part.type === "text" && typeof part.text === "string") {
          chars += part.text.length;
        }
      }
    }
  }
  return summaryTokens + Math.ceil(chars / 4);
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
 * Generic retry prompt used after a successful reactive compaction.
 *
 * NB: This is NOT a byte-for-byte replay of the user's original message —
 * the manager doesn't retain the raw user turn, and pi's AgentHarness
 * exposes no "re-run last turn" primitive. The summary preserves the user's
 * most recent stated goal (per CUSTOM_INSTRUCTIONS), so this nudge lets
 * the model resume with that context. UX trade-off documented in
 * docs/plans/2026-06-12-context-compaction-design.md §3.6 and acknowledged
 * acceptable by Task 5 review.
 */
export const REACTIVE_RETRY_PROMPT =
  "Please retry your previous response now that the conversation context has been compacted.";

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
 * Per-compaction event record. Constructed by the manager after the
 * orchestrator returns, using the pending snapshot captured before the
 * eager-clear race with pi's synchronous session_compact event.
 * Fed to both formatDevLogLine (one-line cog dev-log entry) and
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
  tokensAfterEstimated: number;
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
 *     <trigger>, <model>, ctx <before>→~<after> tokens, summary <S> tokens,
 *     files-read [<list>], files-edited [<list>]. Trigger: <reason>.[ FAILED]
 */
export function formatDevLogLine(e: CompactionEvent): string {
  const ts = e.timestamp.toISOString().replace("T", " ").slice(0, 19);
  const sessionPart = e.subagentTaskId
    ? `subagent task ${e.subagentTaskId} (parent session ${e.sessionId})`
    : `session ${e.sessionId}`;
  const filesReadStr = e.filesRead.length
    ? `[${e.filesRead.join(", ")}]`
    : "[]";
  const filesModStr = e.filesModified.length
    ? `[${e.filesModified.join(", ")}]`
    : "[]";
  const failedMarker = e.succeeded ? "" : " FAILED";
  return (
    `${ts}: compaction in ${sessionPart} — ${e.trigger}, ${e.model}, ` +
    `ctx ${e.tokensBefore}→~${e.tokensAfterEstimated} tokens, ` +
    `summary ${e.summaryTokens} tokens, files-read ${filesReadStr}, ` +
    `files-edited ${filesModStr}. Trigger: ${e.reason}.${failedMarker}`
  );
}

/**
 * Serialize a CompactionEvent to the JSON shape persisted in the per-session
 * compactions JSONL log next to pi's canonical session file path.
 *
 * Keys use snake_case to match conventional JSONL ergonomics; values are
 * primitives + arrays only (round-trips through JSON.stringify cleanly).
 */
export function serializeJsonRecord(
  e: CompactionEvent,
): Record<string, unknown> {
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
    tokens_after_estimated: e.tokensAfterEstimated,
    summary_tokens: e.summaryTokens,
    first_kept_entry_id: e.firstKeptEntryId,
    files_read: e.filesRead,
    files_modified: e.filesModified,
    compaction_duration_ms: e.compactionDurationMs,
    succeeded: e.succeeded,
    backup_path: e.backupPath,
  };
}

function sessionIdFromFilePath(sessionFilePath: string): string {
  const basename = sessionFilePath.split(/[\\/]/).pop() ?? sessionFilePath;
  const match = basename.match(/^[^_]+_(.+)\.jsonl$/);
  return match?.[1] ?? basename.replace(/\.jsonl$/, "");
}

/**
 * Build the structured observability event from the orchestrator result.
 *
 * This intentionally reads trigger/reason/tokensBefore from result.pending,
 * not from live opened.compaction.pendingCompaction: runCompactionIfPending
 * clears that live field before calling harness.compact() for race-safety,
 * and pi emits session_compact synchronously inside compact(). The event
 * handler can only cache pi's compactionEntry details; the caller-side
 * orchestrator result is the source of truth for labeling.
 */
export function buildCompactionEvent(
  model: Model<any>,
  sessionFilePath: string,
  result: RunCompactionResult,
  compactionEntry: any = {},
  _devLogPath?: string,
): CompactionEvent {
  const pending = result.pending;
  const details = compactionEntry?.details ?? {};
  const summaryText = compactionEntry?.summary ?? "";
  const succeeded = result.succeeded === true;
  const reason = result.surrendered
    ? `VERIFY CORRUPTED: ${result.error?.message ?? "unknown error"}`
    : result.succeeded === false && !result.backupPath
      ? `SKIPPED: ${result.error?.message ?? pending?.reason ?? "backup failed"}`
      : (pending?.reason ?? result.error?.message ?? "compaction fired");

  return {
    timestamp: new Date(),
    sessionId:
      compactionEntry?.sessionId ?? sessionIdFromFilePath(sessionFilePath),
    subagentTaskId: compactionEntry?.subagentTaskId ?? null,
    trigger: pending?.trigger ?? "proactive",
    reason,
    model: `${model.provider}/${model.id}`,
    contextWindow: model.contextWindow,
    reserveTokens: computeReserveTokens(model),
    keepRecentTokens: 20_000,
    tokensBefore:
      pending && pending.tokensBefore > 0
        ? pending.tokensBefore
        : (compactionEntry?.tokensBefore ?? 0),
    tokensAfterEstimated: compactionEntry?.tokensAfter ?? 0,
    summaryTokens:
      compactionEntry?.summaryTokens ??
      Math.ceil(String(summaryText).length / 4),
    firstKeptEntryId: compactionEntry?.firstKeptEntryId ?? "",
    filesRead: Array.isArray(details.readFiles) ? details.readFiles : [],
    filesModified: Array.isArray(details.modifiedFiles)
      ? details.modifiedFiles
      : [],
    compactionDurationMs: result.durationMs ?? 0,
    succeeded,
    backupPath: result.backupPath ?? "",
  };
}

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
    console.error(
      `[compaction] failed to append dev-log line to ${filePath}:`,
      err,
    );
  }
}

/**
 * Append a JSON record (one line per record) to the per-session compactions log,
 * co-located with the session JSONL file.
 *
 * Path: `<sessionFilePath>.compactions.jsonl` (e.g. if the session is at
 * `~/.ytsejam/data/sessions/--chat--/2026-06-12T...Z_<uuid>.jsonl`, the
 * log is at `...<uuid>.jsonl.compactions.jsonl` next to it). Best-effort like
 * appendDevLogLine.
 */
export async function appendSessionCompactionJsonl(
  sessionFilePath: string,
  record: Record<string, unknown>,
): Promise<void> {
  const path = `${sessionFilePath}.compactions.jsonl`;
  await appendDevLogLine(JSON.stringify(record), path);
}

/**
 * Copy the session JSONL file to a backup with a `.pre-compact-<epoch-ms>` suffix
 * in the same directory.
 *
 * The caller passes the canonical session file path (typically
 * `opened.session.metadata.path` — pi-agent-core's JsonlSessionRepo writes
 * sessions at `<sessionsRoot>/--<cwd>--/<timestamp>_<id>.jsonl`, not the
 * fictional `<dataDir>/sessions/<id>/session.jsonl`; the metadata.path is
 * the source of truth).
 *
 * Returns the absolute backup path.
 *
 * **Errors are propagated, not swallowed** — unlike the best-effort observability
 * writers. Per design §5, backup failure must ABORT the compaction; the caller
 * (Task 5 orchestrator) treats a throw here as a hard stop and skips
 * `harness.compact()` entirely. Do NOT add a try/catch here.
 */
export async function snapshotSessionJsonl(
  sessionFilePath: string,
): Promise<string> {
  const ts = Date.now();
  const dst = `${sessionFilePath}.pre-compact-${ts}`;
  await copyFile(sessionFilePath, dst);
  return dst;
}

/**
 * Keep only the N most recent `.pre-compact-*` backups for a session file.
 *
 * Scans the directory containing the session file for siblings matching
 * `<basename>.pre-compact-*`, sorts by the embedded epoch-ms timestamp
 * (string sort matches numeric sort for 13-digit ms timestamps through year
 * 2286), and deletes the older ones.
 *
 * Best-effort: scan + per-file unlink errors are logged and swallowed (we'd
 * rather have extra backups than skip the compaction itself).
 */
export async function pruneOldBackups(
  sessionFilePath: string,
  keepLast: number,
): Promise<void> {
  const sessionDir = dirname(sessionFilePath);
  const basename = sessionFilePath.slice(sessionDir.length + 1); // path basename
  const prefix = `${basename}.pre-compact-`;
  try {
    const all = await readdir(sessionDir);
    const backups = all.filter((f) => f.startsWith(prefix)).sort(); // string sort matches numeric sort for ms timestamps
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
 * Verify the session is reloadable after a compaction wrote new content.
 *
 * Takes a `reload` thunk so this helper doesn't depend on pi's specific repo
 * shape (pi's JSONL session repository exposes `create | open | list | delete | fork`,
 * not `load(id)`). The caller (Task 5 wiring) constructs the right closure
 * using pi's actual API, typically `() => repo.open(opened.session.metadata)`.
 *
 * Called immediately after a successful `harness.compact()` to catch the
 * scary "pi wrote a malformed entry" case before it kills the next session
 * resume. Best-effort: any throw is captured into the `error` field; we do
 * not re-throw because the orchestrator needs to decide whether to surrender
 * (vs. happy-path-continue with a warning).
 */
export async function verifySessionLoadable(
  reload: () => Promise<unknown>,
): Promise<{ ok: boolean; error?: Error }> {
  try {
    await reload();
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

/**
 * Per-opened-session state we need to carry for compaction wiring.
 *
 * Attached to the OpenSession object held by AgentManager / TaskManager.
 * Defined as a structural interface here so the orchestrator can be
 * implemented against this contract without circular imports back into
 * manager.ts.
 */
export interface CompactionWiringState {
  pendingCompaction: PendingCompaction | null;
  reactiveRetryAttempted: boolean;
  /** Last pi session_compact payload, cached only to enrich caller-side observability. */
  lastCompactionDetails?: any;
}

export interface PendingCompaction {
  trigger: "proactive" | "reactive";
  reason: string;
  tokensBefore: number;
  budget: number;
}

/**
 * Minimal subset of the OpenSession shape the orchestrator needs.
 *
 * Kept minimal — only the pieces compaction touches. Allows the orchestrator
 * to remain testable without importing the full OpenSession from manager.ts.
 */
export interface OpenedForCompaction {
  session: Session<JsonlSessionMetadata> & { metadata: JsonlSessionMetadata };
  harness: AgentHarness;
  compaction: CompactionWiringState;
}

/**
 * Build the structural adapter consumed by the compaction orchestrator.
 *
 * pi's Session exposes metadata asynchronously via getMetadata(); it does not
 * carry a synchronous `.metadata` property. The orchestrator only needs that
 * canonical JsonlSessionMetadata (especially `.path`) plus the harness and
 * compaction state, so callers pass their already-loaded metadata here instead
 * of mutating the third-party Session instance.
 */
export function toOpenedForCompaction(input: {
  session: Session<JsonlSessionMetadata>;
  metadata: JsonlSessionMetadata;
  harness: AgentHarness;
  compaction: CompactionWiringState;
}): OpenedForCompaction {
  return {
    session: {
      ...input.session,
      metadata: input.metadata,
    } as Session<JsonlSessionMetadata> & { metadata: JsonlSessionMetadata },
    harness: input.harness,
    compaction: input.compaction,
  };
}

export interface RunCompactionResult {
  fired: boolean;
  succeeded?: boolean;
  surrendered?: boolean;
  durationMs?: number;
  backupPath?: string;
  error?: Error;
  /**
   * Snapshot of the pendingCompaction state at the moment the orchestrator
   * decided to fire (captured BEFORE the eager-clear). The caller uses this
   * to correctly label observability writes — pi's session_compact event
   * fires synchronously inside harness.compact() at a moment when the live
   * pendingCompaction field has already been cleared, so the event handler
   * cannot read the trigger/reason directly.
   */
  pending?: PendingCompaction;
}

/**
 * The orchestrator called at idle boundaries and from the reactive-error path.
 * No-op if no pending compaction.
 *
 * Flow:
 *   1. Read+clear the pending flag (clear eagerly so concurrent triggers don't double-fire).
 *   2. snapshotSessionJsonl(opened.session.metadata.path) — backup FIRST. If this throws,
 *      ABORT compaction entirely per design §5 (don't call harness.compact). Best-effort
 *      pruneOldBackups runs in parallel (fire-and-forget) — failure doesn't abort.
 *   3. await opened.harness.compact(CUSTOM_INSTRUCTIONS).
 *   4. verifySessionLoadable(() => repo.open(opened.session.metadata)) — corruption check.
 *      If load fails: surrender flag set, user surrender message responsibility falls
 *      to the caller (manager.ts wires the surrender emit).
 *
 * Caller decides what to do based on the returned flags:
 *   - fired=false      → nothing to do
 *   - succeeded=true   → safe to continue; caller writes observability from result.pending
 *   - succeeded=false  → caller still writes FAILED observability, then decides whether to surrender
 *   - surrendered=true → JSONL corrupted post-compact; surrender message MUST be emitted by caller
 */
export async function runCompactionIfPending(
  opened: OpenedForCompaction,
  repo: JsonlSessionRepo,
): Promise<RunCompactionResult> {
  const pending = opened.compaction.pendingCompaction;
  if (!pending) return { fired: false };

  // Snapshot BEFORE eager-clear so the caller can label observability correctly.
  const pendingSnapshot = { ...pending };

  // Clear flag eagerly so concurrent triggers don't double-fire
  opened.compaction.pendingCompaction = null;

  const start = Date.now();
  const sessionFilePath = opened.session.metadata.path;
  let backupPath: string;

  try {
    backupPath = await snapshotSessionJsonl(sessionFilePath);
  } catch (err) {
    console.error(
      `[compaction] backup failed for session ${opened.session.metadata.id}, ABORTING compaction:`,
      err,
    );
    return {
      fired: true,
      succeeded: false,
      pending: pendingSnapshot,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  // Best-effort prune (no abort on failure)
  void pruneOldBackups(sessionFilePath, 3);

  try {
    await opened.harness.compact(CUSTOM_INSTRUCTIONS);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    console.error(
      `[compaction] harness.compact failed for session ${opened.session.metadata.id}:`,
      e,
    );
    return {
      fired: true,
      succeeded: false,
      durationMs: Date.now() - start,
      backupPath,
      pending: pendingSnapshot,
      error: e,
    };
  }

  // Verify the session is still loadable after compaction wrote
  const verify = await verifySessionLoadable(() =>
    repo.open(opened.session.metadata),
  );
  if (!verify.ok) {
    console.error(
      `[compaction] post-compact load verification FAILED for session ${opened.session.metadata.id}:`,
      verify.error,
    );
    return {
      fired: true,
      succeeded: false,
      surrendered: true,
      durationMs: Date.now() - start,
      backupPath,
      pending: pendingSnapshot,
      error: verify.error,
    };
  }

  return {
    fired: true,
    succeeded: true,
    durationMs: Date.now() - start,
    backupPath,
    pending: pendingSnapshot,
  };
}
