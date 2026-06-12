# Design: context-window compaction + overflow recovery

**Status:** APPROVED 2026-06-12 — D1–D9 accepted as drafted. Ready for `/write-plan`.
**Trigger:** Two `400 model_max_prompt_tokens_exceeded` crashes — one in a housekeeping/reflect session, one in the Phase-5 cogmemory-fold dev loop right after a reviewer return. ytsejam has zero compaction logic; pi has all the primitives but no auto-trigger.
**Spans:** ytsejam server only. No upstream PR to pi. No new dependencies. No model table.
**Self-modification hazard:** the harness running THIS session IS what we're modifying. Backup + verify is load-bearing for that reason — see §9.

---

## 1. Context

### The bug, exactly

- Symptom: `400 {"error":{"code":"model_max_prompt_tokens_exceeded","message":"prompt is too long: 1000596 tokens > 1000000 maximum","type":"invalid_request_error"}}`.
- Two distinct failure modes share that symptom:
  - **A — Input bloat.** A single skill reads enough raw store content in one tool round to blow the budget in one turn (reflect across all domains, housekeeping across all domains, foresight, evolve).
  - **B — Conversation bloat.** Many turns of tool output + skill loads + reviewer returns accumulate past the model's contextWindow with nothing pruning prior turns (today's morning crash was B in the develop loop after a long reviewer return).
- PR #59 (2026-06-12) addressed only A for reflect + history (scoped `recent_observations` by domain, read sections not whole files). It did not touch housekeeping; it did not touch the develop flow; it did nothing for B.

### What pi gives us (verified, see investigation reports in observations)

- `Model<TApi>.contextWindow: number` + `.maxTokens: number` — required fields, populated for all ~1000 entries in `pi-ai/dist/models.generated.js`. All of Brian's models covered (sonnet/opus 1M, bedrock-sonnet 200k, nova-pro 300k, nova-2-lite 128k, etc.).
- `estimateContextTokens(messages): {tokens, usageTokens, trailingTokens, lastUsageIndex}` — provider-truth + char/4 heuristic for trailing messages.
- `shouldCompact(contextTokens, contextWindow, settings): boolean` — formula `tokens > contextWindow - reserveTokens`.
- `harness.compact(customInstructions?)` — public method; requires `phase === "idle"`; uses pi's hard-coded `DEFAULT_COMPACTION_SETTINGS = {enabled:true, reserveTokens:16384, keepRecentTokens:20000}`.
- `harness.on("context", handler)` — per-turn message-mutation hook.
- `harness.on("session_compact", handler)` — post-fact compaction-event hook (carries `compactionEntry`, `fromHook`).
- `isContextOverflow(msg, contextWindow?)` — regex-matches Anthropic's "prompt is too long" / "request_too_large" on `AssistantMessage.errorMessage`.
- `harness.getModel(): Model<any>` — live model object on the current harness.
- Per-event metadata: `BeforeProviderRequestEvent.model`, `ModelUpdateEvent.model`, `AssistantMessage.usage`.

### What ytsejam currently uses

Zero. No `harness.on("context")`, no `harness.compact()`, no `isContextOverflow`, no `Usage` reads. The provider call sends the prompt and lets the API 400 surface as an opaque error.

### The gap

Pi has every primitive. Ytsejam needs a small policy module that wires them together at the right hook points.

## 2. Decisions (D1–D9)

Each was a live brainstorm question with three options. The approved choice is **A** in every case; rationale is summarized below for the implementer.

| # | Decision | Choice | Rationale (one line) |
|---|---|---|---|
| D1 | Trigger model | **Proactive primary + reactive backstop** | 99% of compactions at clean turn boundaries; reactive catches single-turn-too-big edge case |
| D2 | `reserveTokens` calibration | **`max(model.maxTokens + 16_384, 32_768)`** | Correct by construction: "survive one more max-size turn after compacting"; self-tunes across all pi catalog entries |
| D3 | `customInstructions` | **Static const + no-resummarize rule for hot-memory files** | Stable across sessions; the no-resummarize rule is load-bearing because hot-memory auto-loads every turn |
| D4 | Failure-of-failure | **Bounded retry (1) + user-visible surrender + no auto-model-switch** | No infinite loops; user gets diagnostic + options; model-switch has cost/latency implications the user controls |
| D5 | Observability | **Dev-log line + per-session JSONL, no debounce, no UI work** | Cog pattern-detection falls out of dev-log writes; per-session JSONL for replay-debugging; UI is a follow-up |
| D6 | Subagent scope | **Identical policy in `task-manager.ts`, always run even near task timeout** | Subagents equally exposed; preserves partial work on long delegations |
| D7 | Test strategy | **Unit tests against pure-function policy module + gate-skipped real-LLM integration** | Pure-functional code is the sweet spot for unit tests; gate stays fast; integration test exists for cutover confidence |
| D8 | Configuration | **Zero user-facing config except `YTSEJAM_COMPACTION_ENABLED` kill switch (defaults true)** | Calibration is correct by construction; emergency disable is the one real operational use case |
| D9 | Self-modification safety | **Pre-compact backup (keep last 3 per session) + post-compact verify-on-load** | Session JSONL is the substrate this agent runs on; "trust pi has no bugs" is wrong invariant for substrate-critical writes |

## 3. Architecture

### 3.1 Trigger model

**Proactive primary path:**

```
turn_end event fired
  → estimateContextTokens(messages) → {tokens, ...}
  → shouldCompact(tokens, harness.getModel().contextWindow, settings)
    → true  → set pendingCompaction flag on session state
    → false → no-op

next turn about to dispatch (phase becomes "idle")
  → if pendingCompaction flag set
    → snapshot session JSONL → <timestamp>_<id>.jsonl.pre-compact-<epoch-ms>
    → prune older backups (keep last 3)
    → await harness.compact(CUSTOM_INSTRUCTIONS)
    → reload session via `repo.open(opened.session.metadata)` in try/catch (pi's JsonlSessionRepo has no `load` method; `open(metadata)` is the canonical reload)
      → success → clear flag, emit session_compact handler chain
      → corruption → log + dev-log warning + surrender message to user
  → resume normal dispatch
```

**Reactive backstop path:**

```
provider response received
  → if AssistantMessage.stopReason === "error"
    → isContextOverflow(msg, harness.getModel().contextWindow)
      → true  → if retryAttempted_thisTurn → enter surrender flow
              → else → mark retryAttempted, force compact (same backup/verify),
                       retry the turn ONCE
      → false → not our problem, surface error normally
```

**Surrender flow:**

```
emit user-visible assistant message:
  "I hit a context-window limit and couldn't recover automatically.
  The current request appears to be larger than the model's input
  ceiling on its own (likely a single oversized file or tool result).
  Options: (a) ask me to summarize what I have so far; (b) start a
  fresh session; (c) switch to a larger-context model.
  Diagnostic: prompt was <X> tokens against contextWindow <Y>."
```

### 3.2 Calibration

```ts
function computeReserveTokens(model: Model<any>): number {
  return Math.max(model.maxTokens + 16_384, 32_768);
}

function buildSettings(model: Model<any>): CompactionSettings {
  return {
    enabled: true,
    reserveTokens: computeReserveTokens(model),
    keepRecentTokens: 20_000,  // pi default — kept; "how much tail to preserve unsummarized"
  };
}
```

Examples computed at runtime, not stored:

| Model | contextWindow | maxTokens | reserveTokens | Fires at | Headroom |
|---|---:|---:|---:|---:|---|
| anthropic/claude-sonnet-4-6 | 1,000,000 | 64,000 | 80,000 | 920,000 (92%) | 80k |
| anthropic/claude-opus-4-8 | 1,000,000 | 128,000 | 144,000 | 856,000 (86%) | 144k |
| bedrock claude-sonnet-4-5 | 200,000 | 64,000 | 80,000 | 120,000 (60%) | 80k |
| bedrock nova-pro | 300,000 | 8,192 | 32,768 | 267,232 (89%) | 33k |
| bedrock nova-2-lite | 128,000 | 4,096 | 32,768 | 95,232 (74%) | 33k |

The 32k floor handles small-output models (e.g. nova-2-lite has only 4k output; without the floor, reserveTokens would be 20,480 — too small a cushion for the input side of next turn).

### 3.3 customInstructions (exact text deferred to plan)

Static const exported from `compaction.ts`. Shape:

```
You are summarizing a conversation in ytsejam (a single-user personal AI assistant).

PRESERVE EXACTLY:
  - The user's most recent stated goal.
  - Any active git branch / worktree path / PR number / commit SHA.
  - Any reviewer verdict (spec or quality) that triggered a fix cycle,
    including the full issue list.
  - Any subagent task id mentioned + what was delegated.
  - Any plan-doc task currently in progress.
  - Any [Scheduled task ...] context.

DO NOT re-summarize content from cog_read of any file ending in `hot-memory.md`.
Instead, note only: [loaded hot-memory: <path>]. The next turn auto-loads
hot-memory from the system prompt; resummarizing it doubles tokens.

DO NOT re-summarize tool output from cog_read / cog_search / cog_list when the
output is being used for retrieval (the agent's memory tools).
Note only: [read <path>] or [searched <query> → N results].

CONDENSE aggressively:
  - Full file contents read via filesystem tools (read/grep/find).
  - Completed reasoning chains where the conclusion was acted on.
  - Exploratory grep/find/ls results.
  - Subagent intermediate progress (preserve only the final result).
```

(Exact wording, edge-case handling, and any additional preserve/condense rules tuned at plan time.)

### 3.4 Module shape

```
server/src/
  compaction.ts              # NEW — policy module
  compaction.test.ts          # NEW — unit + wiring tests
  compaction.integration.test.ts  # NEW (gate-skipped) — real-LLM smoke
  manager.ts                  # MODIFIED — wire hooks
  task-manager.ts             # MODIFIED — wire hooks (same helpers)

deploy/
  ytsejam.env.example         # MODIFIED — document kill switch
  README.md                   # MODIFIED — kill switch operator note
```

### 3.5 `compaction.ts` public surface (interface only)

```ts
// Decision functions (pure)
export function computeReserveTokens(model: Model<any>): number;
export function buildSettings(model: Model<any>): CompactionSettings;
export function decideCompaction(
  messages: AgentMessage[],
  model: Model<any>,
): { shouldFire: boolean; reason: string; tokensBefore: number; budget: number };
export function classifyOverflow(
  msg: AssistantMessage,
  model: Model<any>,
): boolean;  // thin wrapper for testability

// Custom-instructions const
export const CUSTOM_INSTRUCTIONS: string;

// Observability writers (called from session_compact handler)
export function formatDevLogLine(event: CompactionEvent): string;
export function serializeJsonRecord(event: CompactionEvent): Record<string, unknown>;
export async function appendDevLogLine(line: string): Promise<void>;
export async function appendSessionCompactionJsonl(
  sessionId: string,
  record: Record<string, unknown>,
  dataDir: string,
): Promise<void>;

// Backup/verify helpers
export async function snapshotSessionJsonl(
  sessionId: string,
  dataDir: string,
): Promise<string>;  // returns backup path
export async function pruneOldBackups(
  sessionId: string,
  dataDir: string,
  keepLast: number,
): Promise<void>;
export async function verifySessionLoadable(
  sessionId: string,
  repo: JsonlSessionRepo,
): Promise<{ ok: boolean; error?: Error }>;

// Surrender message builder
export function buildSurrenderMessage(
  tokens: number,
  contextWindow: number,
): string;

// Top-level orchestrator called from manager/task-manager wiring
export async function runCompactionIfPending(opened: OpenedSession): Promise<{
  fired: boolean;
  succeeded?: boolean;
  surrendered?: boolean;
  diagnostic?: string;
}>;

// Kill-switch read (single env var)
export function compactionEnabled(): boolean;  // reads YTSEJAM_COMPACTION_ENABLED
```

### 3.6 Wiring delta in `manager.ts` (sketch)

```ts
// in AgentManager.wire(...), after constructing the harness:

if (compactionEnabled()) {
  // proactive: flag at turn_end
  harness.on("turn_end", (e) => {
    const decision = decideCompaction(e.messages, harness.getModel());
    if (decision.shouldFire) {
      opened.pendingCompaction = { trigger: "proactive", ...decision };
    }
  });

  // observability: record + log on every compaction event
  harness.on("session_compact", (e) => {
    const record = buildCompactionEvent(e, harness.getModel(), opened);
    void appendDevLogLine(formatDevLogLine(record));
    void appendSessionCompactionJsonl(opened.session.id, serializeJsonRecord(record), config.dataDir);
  });
}

// In the per-message dispatch path (immediately before sending the next user message):
await runCompactionIfPending(opened);  // no-op when nothing pending

// In the provider-response handler (after receiving an AssistantMessage):
if (msg.stopReason === "error" && classifyOverflow(msg, harness.getModel())) {
  if (opened.reactiveRetryAttempted) {
    await emitSurrender(opened, /* tokens */, /* contextWindow */);
    opened.reactiveRetryAttempted = false;
    return;
  }
  opened.reactiveRetryAttempted = true;
  opened.pendingCompaction = { trigger: "reactive", reason: "isContextOverflow" };
  await runCompactionIfPending(opened);
  // retry the turn (re-dispatch the same user message)
  // ... implementer fills in the retry mechanics per pi's API
}
// reset reactive flag on any successful (non-error) turn
```

`task-manager.ts` gets the same wiring on the per-task harness.

## 4. Data flow

### Token math (proactive path)

1. `turn_end` fires with the full `messages: AgentMessage[]` of the conversation so far.
2. `estimateContextTokens(messages)` returns `{tokens, usageTokens, trailingTokens, lastUsageIndex}`. The `tokens` field is the trust-the-provider-then-estimate sum.
3. `harness.getModel()` returns the live `Model<any>` (reflects any mid-session `setModel` calls).
4. `shouldCompact(tokens, model.contextWindow, buildSettings(model))` → boolean.
5. If true, opened-session state gets `pendingCompaction = {trigger:"proactive", tokensBefore: tokens, budget: contextWindow - reserveTokens}`.
6. Next idle boundary executes the backup → compact → verify chain.

### Backup chain

```
~/.ytsejam/data/sessions/--<cwd>--/                  # pi's actual layout (cwd-encoded, e.g. --chat--, --subagent--)
  <timestamp>_<session-id>.jsonl                     # the live file (pi-managed)
  <timestamp>_<session-id>.jsonl.pre-compact-1718193600000   # backup at compaction N
  <timestamp>_<session-id>.jsonl.pre-compact-1718193902000   # backup at compaction N-1
  <timestamp>_<session-id>.jsonl.pre-compact-1718194350000   # backup at compaction N-2
  <timestamp>_<session-id>.jsonl.compactions.jsonl   # observability log (our writes, co-located)
```

Backups and the compactions JSONL log live next to the source session file, not in a per-session-id directory. The canonical path is `JsonlSessionMetadata.path` (already used in manager.ts) — pi's `JsonlSessionRepo` cwd-encodes via ``encodeCwd(cwd) = `--${cwd}--` `` and appends `<timestamp>_<id>.jsonl`; do not reconstruct paths from `(sessionId, dataDir)`.

Backup is a literal `fs.copyFile`. Pruning is `fs.readdir + sort + unlink` (keep N most recent by timestamp suffix). N=3.

### Observability writes (per event)

Dev-log entry shape (single line):

```
2026-06-12 14:32:18: compaction in session abc123 — proactive, anthropic/claude-sonnet-4-6, ctx 947112→184309 tokens, dropped 27 turns, summary 4821 tokens, files-read [server/src/manager.ts, docs/plans/...], files-edited [server/src/compaction.ts]. Trigger: shouldCompact (above 920000 budget).
```

For subagent events: prefix changes to `compaction in subagent task <task-id> (parent session <id>) — ...`.

Per-session JSONL record:

```json
{
  "timestamp": "2026-06-12T14:32:18.412Z",
  "session_id": "abc123",
  "subagent_task_id": null,
  "trigger": "proactive",
  "reason": "shouldCompact (above 920000 budget)",
  "model": "anthropic/claude-sonnet-4-6",
  "context_window": 1000000,
  "reserve_tokens": 80000,
  "keep_recent_tokens": 20000,
  "tokens_before": 947112,
  "tokens_after": 184309,
  "summary_tokens": 4821,
  "first_kept_entry_id": "evt_8f12...",
  "dropped_turns": 27,
  "files_read": ["server/src/manager.ts", "docs/plans/..."],
  "files_modified": ["server/src/compaction.ts"],
  "compaction_duration_ms": 8412,
  "succeeded": true,
  "backup_path": "~/.ytsejam/data/sessions/--chat--/2026-06-12T14-32-18-412Z_abc123.jsonl.pre-compact-1718193600000"
}
```

## 5. Error handling

### Recoverable

- **`harness.compact()` returns `CompactionError`** (codes: `aborted | summarization_failed | invalid_session | unknown`). Treat as "compaction failed, conversation continues as-is." Log to dev-log: `compaction FAILED in session <id> — <code>: <details>`. Clear pending flag. If we got here via the reactive path, also enter surrender flow (we tried to recover from a 400 and the recovery itself failed).
- **`harness.compact()` succeeds but `verifySessionLoadable` fails.** This is the "pi wrote something that breaks reload" case — substrate corruption. Log to dev-log with the backup path. Emit a user-visible message: `"compaction corrupted session storage. The session continues in memory but cannot be resumed after restart. A backup is at <path>. Please copy it before restarting ytsejam."` Do NOT attempt automatic recovery — the operator is the right entity to decide whether to restore.
- **Reactive retry path: post-retry message is also `stopReason==="error"` with `isContextOverflow` true.** Enter surrender flow. The user-visible message says explicitly we tried compacting + retrying and it didn't help; the problem is likely a single oversized input.

### Non-recoverable

- **JSONL backup write fails (disk full, permission, etc.).** ABORT the compaction — do not call `harness.compact()`. Log to dev-log: `compaction SKIPPED in session <id> — backup failed: <err>`. Conversation continues as-is; the next `turn_end` will retry the decision and likely fail backup again, surfacing the storage issue clearly.
- **Kill switch flipped mid-session.** Read `YTSEJAM_COMPACTION_ENABLED` once at harness wire-time, not per turn. Flipping it requires `systemctl --user restart ytsejam`. (Documented in deploy/README.md as the operator contract.)

### Defense-in-depth

- All compaction-related catch blocks log to `console.error` AND write to dev-log so a journald-only viewer also sees failures.
- The reactive `retryAttempted_thisTurn` flag MUST be reset on any successful (non-error) turn-end — otherwise one historical retry permanently disables retry for the session's remainder.
- Backup pruning is best-effort — failure to prune does not abort the compaction (we'd rather have extra backups than skip compaction).

## 6. Testing

### Unit tests (`compaction.test.ts`)

Faux model factory:

```ts
const fauxModel = (cw: number, mt: number): Model<any> => ({
  id: "test-model", name: "Test", api: "anthropic-messages", provider: "anthropic",
  baseUrl: "", reasoning: false, input: ["text"],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: cw, maxTokens: mt,
});
```

Cases (target ≥15):

1. `computeReserveTokens(model{1M, 64k})` → 80,000.
2. `computeReserveTokens(model{1M, 128k})` → 144,000.
3. `computeReserveTokens(model{128k, 4k})` → 32,768 (floor applies).
4. `decideCompaction` at exactly threshold → true.
5. `decideCompaction` one token below threshold → false.
6. `decideCompaction` with empty messages → false (no usage, trailing=0).
7. `classifyOverflow` on Anthropic "prompt is too long" → true.
8. `classifyOverflow` on Anthropic "request_too_large" → true.
9. `classifyOverflow` on stopReason="error" with rate-limit message → false (not overflow).
10. `classifyOverflow` on stopReason="end_turn" → false (not an error).
11. `formatDevLogLine` shape stable for proactive trigger.
12. `formatDevLogLine` shape stable for reactive trigger with subagent prefix.
13. `serializeJsonRecord` JSON shape matches schema (round-trip via JSON.parse).
14. `buildSurrenderMessage` includes both tokens and contextWindow.
15. `CUSTOM_INSTRUCTIONS` contains "hot-memory" no-resummarize sentinel.
16. Kill switch: `YTSEJAM_COMPACTION_ENABLED=false` → `compactionEnabled()` false.
17. Kill switch unset → true.
18. Kill switch arbitrary string ("yes", "1") → policy choice (probably true on any non-"false"); document and lock by test.

### Wiring tests (in `compaction.test.ts` or sibling file)

Mock harness with `EventEmitter`-shaped `.on(...)`. Verify:

- After emitting a synthetic `turn_end` with messages crossing the threshold → `pendingCompaction` flag set on opened-session object.
- `runCompactionIfPending` with flag set calls a mocked `harness.compact(CUSTOM_INSTRUCTIONS)`.
- `runCompactionIfPending` with flag unset is a no-op.
- Reactive path: emitting an error `AssistantMessage` with overflow text → `runCompactionIfPending` called.
- Surrender path: second consecutive reactive overflow → surrender message emitted, no infinite retry.

### Backup/verify tests

- `snapshotSessionJsonl` creates the backup file at the expected path.
- `pruneOldBackups(keepLast: 3)` leaves exactly 3 most-recent backups, deletes older.
- `verifySessionLoadable` returns `{ok:true}` on valid JSONL; `{ok:false, error}` on corrupted JSONL.

### Gate-skipped integration test (`compaction.integration.test.ts`)

```ts
describe.skipIf(process.env.INTEGRATION !== "1")("compaction integration", () => {
  it("compacts a real session against a small-context model", async () => {
    // Spin up a real AgentHarness with model {contextWindow: 4000} (faux provider).
    // Feed enough synthetic tool I/O to cross the threshold.
    // Assert: harness.compact() actually ran, session is loadable, dev-log entry exists.
  });
});
```

Runs with `INTEGRATION=1 npm test` or similar. Excluded from `scripts/gate.sh`. Documented in commit message + `scripts/gate.sh` comment.

## 7. Module map

| File | Status | Approx LOC | Purpose |
|---|---|---:|---|
| `server/src/compaction.ts` | NEW | ~250 | Policy module: decision, calibration, customInstructions, observability writers, backup/verify, surrender builder, kill-switch read |
| `server/src/compaction.test.ts` | NEW | ~250 | Unit tests (≥15 cases) + wiring tests (mocked harness) |
| `server/src/compaction.integration.test.ts` | NEW (gate-skipped) | ~80 | Real-LLM smoke against small-context faux model |
| `server/src/manager.ts` | MODIFIED | +30 | Wire `turn_end`, `session_compact`, reactive-error hooks |
| `server/src/task-manager.ts` | MODIFIED | +15 | Same wiring on per-task harness |
| `deploy/ytsejam.env.example` | MODIFIED | +5 | Document `YTSEJAM_COMPACTION_ENABLED` |
| `deploy/README.md` | MODIFIED | +10 | Operator section: emergency disable |
| **Total** | | **~640 LOC** | (~250 impl + ~330 test + ~60 docs/wiring) |

## 8. Sequence + dependencies

```
PR-1: policy module (compaction.ts + tests)
  ├─> independent — no consumer wiring yet, pure addition, gate passes
  │
PR-2: manager.ts wiring
  └─> depends on PR-1 merged (imports compaction module)
PR-3: task-manager.ts wiring + integration test
  └─> depends on PR-2 merged (uses same wiring pattern)
PR-4: kill-switch docs + README operator section
  └─> depends on nothing (docs only); can land anytime, but most useful after PR-2 so the docs match shipped behavior
```

Critical path: PR-1 → PR-2 → cutover (Brian-driven restart). PR-3 and PR-4 follow.

**Parallelizable:** PR-1 (policy module) and PR-4 (docs) can be drafted in parallel by two subagents. PR-2 and PR-3 cannot — PR-3 lifts PR-2's helpers.

## 9. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Pi's `harness.compact()` corrupts session JSONL | Low | Catastrophic (substrate dead) | §D9: pre-compact backup (3 deep) + post-compact verify-on-load + user-visible surrender on corruption |
| Compaction summary loses information the next turn needs | Med | Med (degraded conversation quality, not crash) | §D3 customInstructions preserve list; iterate on the const string when we see real losses |
| `reserveTokens` calibration too aggressive → fires too often | Low | Low (more compaction calls, more cost) | Formula is correct-by-construction; if real-world data shows too-aggressive, tune the +16k cushion via PR |
| `reserveTokens` calibration too lax → reactive backstop fires routinely | Low | Med (user-visible retry latency) | Reactive backstop exists for exactly this; observability surfaces the pattern via dev-log; tune via PR |
| Compaction logic itself has a bug that breaks sessions worse than the 400 | Med (first ship) | High | §D8 kill switch: `YTSEJAM_COMPACTION_ENABLED=false` reverts to old behavior immediately |
| Self-modification: deploying compaction code mid-session kills the live session | Cert. | None (expected) | Same as today's deploy hazard — Brian controls timing |
| Subagent timeout hits during compaction | Med | Low (subagent fails, parent gets diagnostic) | §D6 accepted; partial work preserved via the backup file |
| Reactive retry loop on a turn whose input alone is over-budget (single 500K file paste) | Low | Med (one wasted round-trip) | §D4 surrender flow caps at 1 retry; user gets actionable diagnostic |
| `customInstructions` string drift (constants edited without test update) | Med | Low | Test #15: `CUSTOM_INSTRUCTIONS contains "hot-memory" sentinel` catches the no-resummarize rule going missing |
| Backup files accumulate forever (pruning bug) | Med | Low | Pruning is per-compaction; even broken pruning bounds at "1 backup per compaction event" which is rare enough not to balloon |
| Dev-log file grows unbounded over months | Cert. (slow) | Low | Existing /housekeeping pipeline archives old dev-log entries; no special handling needed |

## 10. Acceptance criteria

The compaction is done when ALL of the following hold:

1. A session that previously crashed with `1000596 tokens > 1000000` (representative replay: cross-domain housekeeping run) completes without 400.
2. A synthetic "fill the context with tool I/O" dev session compacts visibly at the calibrated threshold; dev-log entry written; per-session `compactions.jsonl` updated; session resumes cleanly after restart.
3. `YTSEJAM_COMPACTION_ENABLED=false` reproduces the old 400 behavior on the same synthetic session (proves the kill switch isolates).
4. Killing the unit mid-compaction (sigterm during `harness.compact()`) and resuming loads the session cleanly via the most recent `pre-compact-*` backup (proves backup chain works for the substrate-corruption scenario).
5. Subagent compaction events are visible in dev-log with the `subagent task <id>` marker.
6. Unit tests pass; `scripts/gate.sh` green; gate-skipped integration test passes with `INTEGRATION=1`.
7. `cog_search "compaction in session"` returns dev-log entries from real compactions.

## 11. What this plan does NOT do

- Does NOT add a UI badge for compaction events. Future work; data layer ships first (the per-session JSONL is the data layer).
- Does NOT auto-switch models on overflow. User-controlled (D4).
- Does NOT add per-session compaction settings or web-UI configuration. Constants + kill switch only (D8).
- Does NOT patch reflect/housekeeping/foresight/evolve skills to be smaller. Those are still high-input skills; the harness-level compaction fixes the consequence (failure mode B from the bug analysis), and reflect's PR #59 already addressed failure mode A for that one skill. A separate plan can revisit per-skill input shrinkage if real data shows it's still needed after compaction lands.
- Does NOT add a tokenizer dependency. Pi's char/4 + provider-truth heuristic is good enough; the architecture-trilogy lesson "audit cross-language library defaults" applies — keep the dep surface lean.
- Does NOT touch pi-agent-core or pi-ai. No upstream PR.
- Does NOT change the on-disk session JSONL format. Backups are byte-copies; pi continues to be the writer.

## 12. Hidden bonus wins

- `compactions.jsonl` per-session log gives us per-session cost analytics for free (sum `summary_tokens * model.cost.input` over the file).
- The reactive backstop path means even one-off "I pasted a huge file" cases get an actionable error instead of a vendor 400. UX improvement separate from the compaction itself.
- Dev-log line per compaction makes /housekeeping naturally surface "we've compacted 14 times this week" patterns — feeds back into reserveTokens calibration over time without ad-hoc instrumentation.
- The kill switch makes "I broke compaction" survivable without a code rollback. Reduces the blast radius of any bug in this module.
- The customInstructions no-resummarize rule for hot-memory potentially saves 5-15% of every compaction's output tokens (hot-memory is ~4KB / ~1k tokens loaded every turn).

---

**Ready for build when:** Brian invokes `/write-plan` with this design as the input. Plan will live at `~/projects/ytsejam/docs/plans/2026-06-12-context-compaction.md` and the branch is `feat/context-compaction`.

-- Mentat
