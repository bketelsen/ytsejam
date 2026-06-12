# Issue #72 diagnosis: `tokens_after == tokens_before` is a measurement bug, not a trim bug

## Root cause (one sentence)

`recordCompactionEvent` measures `tokens_after` by calling `estimateContextTokens()` on the post-compaction `buildContext()` output *before any new provider turn has run*, but `estimateContextTokens()` trusts the last surviving assistant message's `usage.totalTokens` as its primary signal — and that value is a stale historical snapshot from when the provider was billed for the *full pre-compaction prompt*, so the function returns the pre-compaction count even though the kept-set actually was trimmed correctly.

## Evidence

### On-disk artifact observations

- `…_019ebc39….jsonl.pre-compact-1781288368716` is **518 lines, 1.5 MB**.
- Live `…_019ebc39….jsonl` is **593 lines, 1.8 MB**.
- `sha256sum` of `head -518 live` exactly equals `sha256sum backup` → the live file is **pure append** of (1) one compaction marker on line 519 + (2) 74 post-compaction conversation entries on lines 520–593. **No rewrite ever happened, and none was supposed to** — pi-agent-core compaction is logical (append a marker; on read, skip everything before `firstKeptEntryId`), not physical.
- The compaction marker (`type:"compaction"`, `id:"019ebd10"`) carries `firstKeptEntryId:"019ebd03"`, which corresponds to **line 459 of the backup** — i.e. 60 of 518 entries (≈11.6 %) are kept; 458 entries are logically trimmed.
- Byte-budget proof the trim is real: lines 459–518 (kept) = **115 KB**; lines 1–458 (trimmed) = **1.42 MB**. The kept set is ~7.6 % of the original log.
- **The decisive datum**: the very next assistant message after the compaction marker (`id 019ebd10-6395-79ab…`) reports `usage.totalTokens = 55756`. The five turns after that read 56500 / 58257 / 63024 / 64084 / 68998. The provider clearly received a much smaller prompt; the trim is real and the model honored it. The compaction succeeded behaviorally.

### Code references

- `server/src/manager.ts:502–507` — `recordCompactionEvent` computes `tokensAfter` by calling `opened.session.buildContext()` and then `estimateContextTokens(messages).tokens`. This runs *immediately* after `runCompactionIfPending` returns, before any retry/next turn.
- `server/src/compaction.ts:300, 332, 651` — `succeeded` is set to `true` whenever `harness.compact()` doesn't throw AND `verifySessionLoadable` passes. **There is no post-condition check that `tokens_after < tokens_before` or `tokens_after < budget`.** A grep for `tokens_after|tokensAfter.*budget|reduction` in `server/src` returns only the field declaration/serialization sites and the unrelated load-verification log line — no guard exists.
- `node_modules/@earendil-works/pi-agent-core/dist/harness/compaction/compaction.js:97–122` — `estimateContextTokens(messages)` calls `getLastAssistantUsageInfo(messages)`, returns `usage.totalTokens` of that last assistant + character-heuristic estimates for any messages AFTER it. If no successful assistant message exists, it falls back to char/4 heuristic for everything.
- `node_modules/@earendil-works/pi-agent-core/dist/harness/session/session.js:40–55` — `buildSessionContext` on a compacted branch prepends a synthetic `compactionSummary` message, then iterates `pathEntries` from `firstKeptEntryId` forward and appends those. So the post-compact message stream looks like: `[compactionSummary, kept-msg-1, …, kept-msg-N]`. The last kept entry is the assistant whose `usage.totalTokens` was 538,041 (the message that triggered the proactive decision in the first place), so `estimateContextTokens` returns 538,041.
- `node_modules/@earendil-works/pi-agent-core/dist/harness/agent-harness.js:627–666` — pi's `harness.compact()` only calls `session.appendCompaction(...)` (one new entry) and emits `session_compact`. It never rewrites or truncates the JSONL. Logical trimming happens lazily inside every subsequent `buildSessionContext`.

### What the hypotheses got right / wrong

| Filer's hypothesis | Verdict |
|---|---|
| **(1)** "tokens_after is read at the wrong moment (before the kept-set rewrite is materialized)" | **Correct in spirit, wrong in mechanism.** Read at the wrong moment ✔; but there is no "kept-set rewrite" to wait for — pi's design is logical-only. The right model is: tokens_after is read before *any new provider turn* lays down a fresh `usage.totalTokens` reflecting the trimmed prompt. |
| **(2)** "firstKeptEntryId resolves to an entry near the beginning of the log" | **Wrong.** firstKeptEntryId=`019ebd03` is line 459 of 518 in the backup; only 11.6 % of entries are kept. The cut is aggressive and correct. |
| **(3)** "Summary is written but the leaf pointer or branch traversal still walks the pre-compaction entries" | **Wrong.** Leaf advances correctly: compaction entry `019ebd10` has parentId `019ebd0d-673a-7fab-b386-36231a024f01` (the prior assistant), and line 520's user entry has parentId `019ebd10`. Subsequent turns drop to ~56K tokens (see byte-budget proof above), proving the provider received the trimmed branch as intended. |

## Which hypothesis matched

**Hypothesis 1 matched in outcome but with a corrected mechanism**: it is a measurement-timing bug, but the thing we're waiting for is not a "kept-set rewrite" (which doesn't exist); we're effectively waiting for a fresh provider `usage` payload that `estimateContextTokens` can anchor on. Because `recordCompactionEvent` runs at end-of-compaction with the freshest `usage.totalTokens` in the kept set still being the very 538,041-token snapshot that triggered the decision, the function tautologically returns the same value as `tokens_before`.

## Is `succeeded: true` structurally wrong?

**Yes — it's a no-post-condition success flag.** `succeeded` only certifies that (a) `harness.compact()` returned without throwing and (b) the JSONL is still loadable. It says nothing about whether tokens actually came down or whether the kept-set fits under the budget. A summary call that produced a 3,109-token summary but accidentally cut at the wrong spot (or, hypothetically, a summary call that no-op'd because `firstKeptEntryId` resolved to the tail) would still report `succeeded: true`. In the present incident the trim genuinely worked, so the flag was accidentally honest; but as a contract it is checking the wrong thing.

The `tokens_after` field is also structurally wrong as a "did compaction reduce tokens?" indicator for this codepath — the value can only ever be trustworthy after the next provider turn writes a new `usage.totalTokens` into the session. Computed at end-of-compaction, the field is effectively guaranteed to read ≥ `tokens_before` (it can only differ by the heuristic estimate of messages that arrived after the anchor, which is usually ~0).

## Recommended fix shape

Two independent changes, both small:

1. **Replace the end-of-compaction measurement with a structural estimate**: in `recordCompactionEvent` (`server/src/manager.ts:502–507`), do not call `estimateContextTokens` on the post-compact `buildContext()` output. Instead derive a structural prediction — e.g. `summaryTokens + char/4 heuristic over the kept-entry messages, ignoring stale provider usage`, or accept the underlying limitation and report `tokens_after` as "unknown until next turn" (null / -1 sentinel) and have the dev-log/JSONL writer surface a separate `predicted_tokens_after` field. A second option is to defer the `tokens_after` write: stash the compaction record and flush it after the next successful assistant turn so `estimateContextTokens` has a fresh anchor. The first option is simpler; the second is more accurate.

2. **Gate `succeeded` on an actual post-condition**: change `succeeded` in `runCompactionIfPending` / `buildCompactionEvent` so it requires `tokens_after < budget` (or, given the measurement problem above, `firstKeptEntryId` resolves to an entry whose index in `pathEntries` is at least one past `prevCompactionIndex + 1` AND `kept-set heuristic estimate < budget`). Right now `succeeded: true` means only "didn't crash"; it should mean "didn't crash AND the next turn will fit." Until the measurement is fixed, the post-condition has to use a structural proxy rather than the broken `tokens_after`.

## Adjacent bugs noticed while reading

- **`computeReserveTokens` floor can produce a negative budget for small-context models.** `buildSettings` returns `reserveTokens = max(model.maxTokens + 16_384, 32_768)`. For a model with `contextWindow < 32_768` (rare but possible — pi-ai exposes tiny models too), `decideCompaction`'s `budget = contextWindow - reserveTokens` goes negative and `shouldCompact` will fire on every turn. The test-ergonomics note inside the compaction-marker's own summary text ("`contextWindow:4000` trips the `reserveTokens:32_768` floor → negative budget → use `contextWindow:40_000`") confirms the team already hit this. There is no clamp / validation.
- **`buildCompactionEvent` writes `keepRecentTokens: 20_000` as a hardcoded constant** (`server/src/compaction.ts:319`) instead of reading it back from the settings actually used. If `buildSettings` ever stops returning 20k, the JSONL record will silently lie. Low priority but a maintenance trap.
- **`tokensBefore` fallback ordering** (`server/src/compaction.ts:312–315`) is correct for the reactive path now (post-#71 fix using `pending.tokensBefore > 0 ?` rather than `??`), but the same bug class will recur if anyone "simplifies" it back to `??`. A unit test asserting reactive-with-0-pending falls through to `compactionEntry.tokensBefore` is the right defense (the fix-commit message indicates one was added; would be worth grepping `compaction.test.ts` to confirm it's still there).
- **`prepareCompaction` in pi-agent-core uses `estimateContextTokens(buildSessionContext(pathEntries).messages).tokens` to compute its own `tokensBefore`** (compaction.js, `prepareCompaction`). When that value flows back through ytsejam's `compactionEntry.tokensBefore`, the same staleness issue exists there too — but in that direction it's *correct by accident*, because at decision time the last assistant's `usage.totalTokens` legitimately is the prompt size. The asymmetry is worth noting: pi measures `tokensBefore` for free using a value that is genuinely current, then nothing can measure `tokensAfter` symmetrically because no new turn has run yet. This is a structural limitation of the `estimateContextTokens` design, not just a ytsejam bug.
- **No safety net for "compaction ran but didn't help."** Even with the `succeeded` gate fixed per the recommendation, there is no fallback for the (real-world likely) case of one giant tool result or pasted file dominating the kept-set window. Today such a session would loop: trigger proactive compaction → `succeeded: true` (or `false` after the gate fix) → next turn fires the same trigger again immediately. The surrender path is only wired into the *reactive* (error-driven) flow, not the *proactive* one. Worth a follow-up: if proactive compaction's post-condition fails twice in a row on the same session, surrender to the user.
