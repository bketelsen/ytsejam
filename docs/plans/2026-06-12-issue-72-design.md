# Issue #72 fix design

Companion to the full investigation at `docs/plans/2026-06-12-issue-72-diagnosis.md`. Read that first for root cause, evidence, and adjacent-bug context.

## Goal

Make compaction's `tokens_after` measurement honest and gate `succeeded` on an actual post-condition, so that:
- The JSONL record no longer claims `tokens_after == tokens_before` after a working trim
- The `succeeded` flag means "kept-set will fit under budget" not "didn't crash"

## Decisions

### D1 — Replace measurement (Option A from the diagnosis)

**Not chosen:** Option B (defer the JSONL write until next assistant turn).

**Why A:** the primary consumer of `tokens_after` is the `succeeded` post-condition gate, which by definition must run synchronously at end-of-compaction. Option B can't serve that consumer; it also makes `.compactions.jsonl` eventually-consistent and adds a piece of pending state with edge cases (no next turn, next turn errors, next turn re-triggers compaction).

A heuristic structural estimate is sufficient for the gate's purpose ("did this fit roughly under budget?") because the budget itself has slop (the 48,384-token `reserveTokens` cushion). A 10% estimate error doesn't change the gate outcome in any borderline case that matters.

### D2 — Honest naming

Rename the field on disk from `tokens_after` → `tokens_after_estimated` (JSONL) and the struct field `tokensAfter` → `tokensAfterEstimated`. The current name implies measured; the value is now structural.

Dev-log line stays human-readable: `ctx <before>→<after-estimated> tokens` (the `-estimated` suffix is a hint to readers; we could also tilde-prefix as `~<N>`). Pick the tilde: it's shorter and conventionally means "approximately."

### D3 — Post-condition for `succeeded`

`succeeded` becomes the AND of:
1. `harness.compact()` did not throw (existing)
2. `verifySessionLoadable` passed (existing)
3. **NEW:** structural estimate of post-compaction kept-set is under budget (i.e. `tokensAfterEstimated < budget`)

If (3) fails, `succeeded = false` and the dev-log/JSONL record carries `succeeded: false` with a reason like `KEPT_SET_OVERSIZED: tokensAfterEstimated=X > budget=Y`. This is the trigger for the future "no-surrender-on-proactive" follow-up (#76) — once that's wired, two consecutive `succeeded:false` proactive runs on the same session surrender to the user.

### D4 — Helper location

Add `estimateKeptSetTokens(messages, summaryTokens)` to `server/src/compaction.ts` as a pure function. Walks the post-compact `messages` array (returned by `buildSessionContext`), applies `char/4` to every message body, adds `summaryTokens` from `compactionEntry`. Does **not** call pi's `estimateContextTokens` (which is the broken anchor we're avoiding). Unit-testable in isolation.

## Scope (what changes)

- `server/src/compaction.ts` — add `estimateKeptSetTokens`, update `CompactionEvent` field rename, update `buildCompactionEvent` to use the new field and compute `succeeded` post-condition, update `formatDevLogLine` to tilde-prefix the after value, update `serializeJsonRecord` to emit `tokens_after_estimated`
- `server/src/manager.ts` — `recordCompactionEvent` stops calling `estimateContextTokens`, calls `estimateKeptSetTokens` instead; pass `budget` through so the post-condition can be computed
- `server/test/compaction.test.ts` — update existing fixtures for renamed field; add tests for `estimateKeptSetTokens`, for the post-condition gate, for the negative case (oversized kept-set → `succeeded:false`)

## Out of scope (deferred to follow-up issues)

- #74 (`keepRecentTokens` hardcoded) — small, separate
- #75 (negative budget for small-context models) — small, separate
- #76 (no surrender on proactive) — depends on this fix landing first; the post-condition added here is the trigger
- A `tokens_after_observed` field that gets backfilled on the next turn — additive future work, not needed now

## Risk

Low. Only the observability path is touched. The compaction trim itself, the orchestrator, the backup/verify flow, and the reactive overflow path are all untouched. The worst case is a wrong-but-plausible estimate; the existing trim-via-kept-set behavior is preserved exactly.

## Done when

- `bash scripts/gate.sh` passes
- A fresh compaction in a live session writes `tokens_after_estimated` ≈ a reasonable fraction of `tokens_before` (not equal to it)
- `succeeded:true` only fires when the structural estimate is under budget
- The three existing compaction integration tests still pass
