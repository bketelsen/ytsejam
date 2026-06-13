# Testing — Project Lessons

Lessons learned from failures and fix cycles.
Auto-appended by the lessons skill.

## Assert Exact Token Constants In Tests

When writing test expectations and implementation in the same plan-doc, never let human-readable shorthand like "16k" stand in for a precise constant — it silently conflated decimal 16,000 with binary 16,384 here, forcing the implementer to recompute every expected value. The shipped formula in `computeReserveTokens` is `Math.max(model.maxTokens + 16_384, 32_768)`, so tests must assert the exact derived numbers (e.g. `80_384`, `144_384`, `33_384`, budget `919_616`) rather than rounded approximations (`80_000`, `144_000`, `920_000`). Derive test expectations directly from the named constants in the implementation, ideally by reusing or referencing those constants instead of hardcoding magic numbers that can drift. This matters most for boundary assertions like `decideCompaction` firing at `919_617` but not `919_616`, where an off-by-384 error makes the test wrong but plausible-looking. The discipline: define the constant once, compute expectations from it, and make any "16k"-style prose explicitly state whether it means 16,000 or 16,384.

_Added: 2026-06-12 | Task: Task 1: Pure-function policy module — calibration + dec_

## Match Existing Test Directory Conventions Before Writing Paths

Place new server tests in `server/test/<file>.test.ts`, not co-located in `server/src/`, because `server/vitest.config.ts` sets `include: ["test/**/*.test.ts"]` and silently skips co-located files — a passing `bash scripts/gate.sh` (exit 0) can mean your new test never ran. Before specifying test paths in a plan or implementation, read the existing convention (grep where current `*.test.ts` files live and check the vitest `include` glob) rather than assuming a co-location pattern. To prove a new test actually executes in the gate, run `bash scripts/gate.sh 2>&1 | tee /tmp/gate-output.txt` and confirm the test names appear (e.g., `grep -c "compaction" /tmp/gate-output.txt` returns non-zero); do not rely on direct `npx vitest run <file>` invocation, which bypasses the gate's discovery. Treat the implementer's `## Patterns Discovered` and `## Blockers` report sections as high-signal channels for tooling and test-infrastructure gaps, since reviewers examining code-as-written systematically miss what does or doesn't run in the gate.

_Added: 2026-06-12 | Task: Task 1: Pure-function policy module — calibration + dec_

## Verify Third Party Contracts Before Authoring

When integrating with a third-party library (e.g. pi-agent-core's JsonlSessionRepo), confirm its actual API surface and on-disk layout before writing helpers or plan docs against it — read the `.d.ts` and inspect the live data dir rather than assuming a shape. Pi writes sessions to `<dataDir>/sessions/--<cwd>--/<timestamp>_<sessionId>.jsonl` and exposes the canonical location via `JsonlSessionMetadata.path` (see manager.ts:128, :394), so pass that path through instead of reconstructing it or calling non-existent methods like `repo.load()`. Tests must use realistic fixtures created the way the real library would (e.g. via `JsonlSessionRepo.create` or by placing the file at the genuine `--chat--/<ts>_<id>.jsonl` path), never hand-built directories or mocks like `{ load: async () => ({}) }` that merely re-encode the helper's wrong assumption. The danger is mutual confirmation bias: a helper and its test can both pass while sharing the same incorrect model, which is exactly what slipped past the byte-level spec check twice in this PR (first `verifySessionLoadable`, then the snapshot/prune path helpers). Design diagrams and path models are part of the contract too — validate them against library reality so errors don't propagate faithfully from spec into implementation into tests.

_Added: 2026-06-12 | Task: Tasks 3+4: observability + writers + backup/verify_

## Extract Pure Helpers To Test Wiring

When the policy lives in a pure module (`compaction.ts`) but the bug lives in the wiring (`manager.ts` event handlers, idle hooks, surrender/record-writing), passing unit tests for the compute primitives give false confidence — they verify WHAT is computed, not WHEN cross-cutting state is read during an event lifecycle. The reactive-mislabel bug proved this: the orchestrator eager-cleared `pendingCompaction` before `harness.compact()`, and pi emits `session_compact` synchronously inside `compact()`, so the handler read null state — yet all 42 pure tests passed. Fix the testability gap by extracting pure helpers (e.g. `buildCompactionEvent(model, sessionFilePath, result, ...)`) from private methods so trigger-classification, retry/surrender branching, and observability labeling can be asserted against a faux model and stub harness without building the full `AgentManager`. Always add at least one wiring-level test that drives the real state machine (overflow→reactive-pending→agent_end→compact→retry) and asserts the written dev-log line's `trigger`, rather than deferring all integration coverage to an `it.todo` real-LLM path. The decisive signal: if a decision depends on the *moment* state is sampled within an async event, a primitive-level test cannot catch a mislabel — only a test exercising the handler can.

_Added: 2026-06-12 | Task: Task 5: orchestrator + main-session wiring_

## Verify Prescriptive Lessons Were Actually Implemented

When a prior lesson prescribes a specific artifact — here, docs/agents/testing.md mandated a wiring-level test driving the real state machine (overflow→reactive-pending→agent_end→compact→retry), not just extracted pure helpers — treat the prescription as unmet until you confirm the artifact exists. Do not trust "covered elsewhere" mitigation claims; verify them empirically with one grep (e.g., grepping manager.test.ts for compaction/overflow/surrender/reactive returned zero hits, exposing the spec reviewer's claim as false). Add the missing test at a real-execution layer: server/test/task-manager.test.ts already drives the real TaskManager through pi's faux provider, so queue faux responses (overflow stopReason:"error", compaction summary, retry) and assert on observable output like the dev-log "— reactive, Trigger: isContextOverflow." line that would have caught the original mislabel bug. Watch for environment gotchas that silently break such tests: harness.compact() needs auth even with a faux provider (register under provider:"openai" with a dummy OPENAI_API_KEY), the happy path needs three queued responses because compaction consumes one, and a too-small contextWindow trips the reserveTokens 32768 floor into a negative budget (use 40000). Lesson-honoring is a discipline: confirm the mandated thing was built, because partial application (helpers ✅, test ✗) looks done but leaves the exact failure mode untested.

_Added: 2026-06-12 | Task: Task 6: subagent wiring in task-manager.ts_

## Apply Lessons To All Symmetric Call Sites

When a prescriptive lesson (e.g. "wiring test for the compaction state machine") is triggered on one code path, audit for structurally symmetric call sites and apply the same fix to ALL of them — not just the one that surfaced it. In the context-compaction PR, the subagent path got wiring tests in server/test/task-manager.test.ts, but the symmetric main-session path in server/src/manager.ts was left with zero coverage (grep manager.test.ts for compaction/overflow/surrender returned 0 hits). Symmetric does not mean identical: manager.ts fires reactive compaction at agent_end (gated ~line 312) and surrenders by hand-building an AssistantMessage plus emitting message_start/message_end/turn_end bus events the web UI consumes — different, higher-risk code than the subagent's surrenderMessage flag. Add manager.test.ts wiring tests driving overflow→reactive→agent_end→compact→retry against the faux provider, and assert both the synthetic surrender diagnostic text and the exact bus-event sequence via toEqual; mutation-test them (drop a bus emit or no-op the retry prompt) to confirm they actually catch breakage.

_Added: 2026-06-12 | Task: Final review fixes: manager wiring test + diagnostics_

## Verify Content Block Types Against Real Source

When writing docstrings and tests that reference library-specific shapes (e.g.
content-block types in @earendil-works/pi-ai), verify the vocabulary empirically
against the actual TypeScript definitions (pi-ai/dist/types.d.ts) and real data
(session transcripts under ~/.ytsejam/data/sessions/) rather than relying on a
model's prior exposure to similar libraries. The real content-block types are
text, toolCall (camelCase, payload in .arguments), and thinking (text in
.thinking); tool_use and tool_result do not exist — a tool result is a top-level
message with role:"toolResult" whose .content is an array of text blocks. This
matters because estimateKeptSetTokens in server/src/compaction.ts counts only
message text, so it actually drops toolCall.arguments JSON and thinking.thinking
text while still counting toolResult message text — the opposite of what the
original docstring and the straw-man test 4 claimed. Avoid self-consistent
spec/test pairs that share the same wrong vocabulary; they validate each other
and pass by exercising shapes that can never appear in production. Always grep
the library types and a corpus of real transcripts before encoding any shape
into tests or docs.

_Added: 2026-06-12 | Task: Add estimateKeptSetTokens pure helper for issue #72 fix_

## Pin Documented Design Gaps Not Assumptions

When a test fails, check the plan/design doc before assuming an implementation bug — here `docs/plans/2026-06-13-compaction-pill.md` Open Question #1 (line 771) explicitly documented that a reactive retry-exhaust surrender emits no paired `compaction_end{status:"surrendered"}`, because the prior successful compaction already called `markCompactionEnd(opened, "succeeded")` and `handleCompactionTurnEnd` only calls `emitCompactionSurrender(opened)`. The plan author's own test contradicted that documented choice, so the fix was test-only in `server/test/compaction-events.test.ts` with zero changes to `server/src/manager.ts`. Write tests to pin documented behavior: assert NO `compaction_end{surrendered}` is emitted and that surrender is observable via the assistant diagnostic message instead. Avoid "fixing" server code to satisfy a test that conflicts with the design — and when a plan specifies an assertion that contradicts its own Open Questions, treat the design doc as authoritative and correct the test.

_Added: 2026-06-13 | Task: Task 5 of compaction-pill — server vitest tests_

## Mutation Test Pinned Design Gap Assertions

When reviewing whether test assertions are "strong enough" — especially pinned-design-gap tests like those in `server/test/compaction-events.test.ts` that assert the *absence* of an event (e.g. no `compaction_end{surrendered}` on the reactive retry-exhaust path) — don't rely on code-reading alone; apply mutation testing. Temporarily perturb the implementation (e.g. make `manager.ts:382` erroneously emit `compaction_end{surrendered}`, or suppress a `compaction_start` emit) and confirm each test fails at the expected line for the right reason, then restore the file and verify `git diff` is byte-clean. This catches the class of bug a pure inspection cannot: an assertion that always passes regardless of implementation state (e.g. a `toContain` on a stable string), which looks correct but gives zero regression protection. A guard like `expect(ends).toHaveLength(1)` is only proven to do real work once you've shown it flips to a failure when the gap it pins is "fixed." Bidirectional pins matter because they force a deliberate decision if someone later closes the gap.

_Added: 2026-06-13 | Task: Two-stage review of Task 5 compaction-pill tests_

## Detect Git Operations Via On-Disk State Files

In `server/src/memory/store/auto-commit.ts`, detect in-progress git operations
with synchronous `existsSync` checks against the actual state files
(`.git/MERGE_HEAD`, `.git/rebase-merge/`, `.git/rebase-apply/`,
`.git/CHERRY_PICK_HEAD`, `.git/REVERT_HEAD`, `.git/BISECT_LOG`) — never regex
`git status --porcelain=v2 --branch`, whose output contains none of those
markers, so the guard silently returns `false` and lets `git add -A`/`git
commit` finalize a conflicted, half-merged tree. For the cadence counter,
decrement with `pendingWrites -= n` inside a
`while (pendingWrites >= AUTO_COMMIT_EVERY)` drain loop instead of resetting to
`0`, otherwise concurrent `pendingWrites += 1` increments arriving during an
in-flight commit are discarded and the "at most N uncommitted writes"
crash-window guarantee breaks under concurrent bursts (measured: 31/50
increments dropped). Critically, write tests for every guard and mutex you
ship, not just counter arithmetic — pull forward a real merge-conflict
regression test (assert HEAD did not advance, `MERGE_HEAD` still exists, a
`/git operation in progress/` warning logged) and a 50-concurrent-call burst
(assert ≥4 cadence commits) so defects surface at TDD red-state rather than in
production. When a test needs scaffolding like a pre-commit hook to make
behavior observable, verify it isn't inflating results by running the OLD
buggy code with the same hook and confirming the old failure still reproduces.

_Added: 2026-06-13 | Task: D7 auto-commit cadence for server/src/memory/git/_

## Validate Parser Inputs Against SSOT Constraints

When writing a parser (e.g. `parseObservationLine` in `server/src/memory/bridge/ltm-observer.ts`), match its validation to the authoritative write validator rather than the prose spec — here the cog SSOT regex at `server/src/memory/store/append.ts:7` (`/^-\s+\d{4}-\d{2}-\d{2}\s+\[.+\]:\s*.+$/`) requires non-empty tags and a non-empty body, so the parser must reject empty/whitespace-only tags, not treat them as optional. Shape-only date regexes (`\d{4}-\d{2}-\d{2}`) are insufficient: round-trip-validate calendar correctness via `const d = new Date(\`${date}T00:00:00.000Z\`); if (Number.isNaN(d.getTime()) || d.toISOString().slice(0,10) !== date) return null;`, copying the existing sibling parser at `server/src/memory/consolidated/observations-parser.ts:11-12` instead of reinventing it. Skipping these checks lets semantically-invalid values (`2026-13-99`, `2026-02-30`, `tags: []`) flow downstream where `new Date(...).toISOString()` throws "Invalid time value" or the cog write is rejected, silently breaking the mirror so the reconciler retries forever — the exact failure the self-healing design exists to prevent. Before implementing, check for an existing parser/validator in the repo and reuse its logic, and add negative tests (untagged-fails, empty/whitespace-only tags, invalid-date, Feb-30, embedded-newline) so permissive parsing can't regress.

_Added: 2026-06-13 | Task: Task 1 of 9 for PR 1 of the cog-LTM bridge roadmap_

## Normalize Whitespace Before Content-Addressed Dedup

Content-addressed dedup (e.g. `cog:<path>#<sha256-12>` in `server/src/memory/bridge/ltm-observer.ts`) breaks silently on CRLF when the producer and consumer split on `\n` but not `\r?\n`: the inline `recordObservation` path sees `line` without `\r`, but a reconciler reading the same file from disk and splitting on `\n` keeps the trailing `\r`, hashes a different string, and either re-mirrors forever or overwrites the dedup record's origin with the `\r` variant — defeating dedup on BOTH paths permanently. ALWAYS normalize (`split(/\r?\n/)` + `.trim()`) BEFORE the line crosses the hash boundary, and mutation-test the dedup assertion: change `split("\n")` to `split(/\r?\n/)`, write a CRLF fixture, assert per-tick replay count stays at zero on a second run. Generalizes to ANY hashed identifier derived from text the OS / user may newline-mangle.

_Added: 2026-06-13 | Task: Task 6 of 9 for PR 1 of the cog-LTM bridge roadmap_

## toBeUndefined Is Mutant-Weak for OMIT Semantics

When the spec says "field X is OMITTED (not set to undefined)" — common for backward-compat extensions like `memory.health()`'s new `ltm` field — `expect(h.ltm).toBeUndefined()` passes BOTH for the correct OMIT path AND for a buggy `return {...base, ltm: undefined}` mutant. Pair every `toBeUndefined()` against an OMIT contract with `expect("ltm" in h).toBe(false)` (when no reconciler is attached) — that mutant-kills the explicit-undefined-set bug. Mutation-test the assertion locally before shipping: temporarily change the code to `return {...base, ltm: attached ? snap : undefined}` and verify the test now fails. Generalizes to TypeScript optional fields, JSON serialization fields, and HTTP response envelopes where presence matters.

_Added: 2026-06-13 | Task: Task 7 of 9 for PR 1 of the cog-LTM bridge roadmap_

## Mutation-Test Defensive Try/Catch Assertions

A test that says "we handle X gracefully" — typically a `try/catch` with a log line — may be asserting on a path that runs even WITHOUT the protection (e.g. the operation never threw in the first place because the input was benign). Before trusting any such test, temporarily REMOVE the catch (or change the log wording) and verify the test fails. For `LtmReconciler`'s tick-level error accounting (`consecutiveFailures++` on rejected mtime stat) we proved it by making the catch a no-op and watching the test still pass on the happy path — meaning the assertion's truth was structural, not protective. Apply the same mutant check to any "handles malformed input" / "logs warning on failure" / "tolerates X" test.

_Added: 2026-06-13 | Task: Task 6 of 9 for PR 1 of the cog-LTM bridge roadmap_

## Multi-Store Live Write Paths Must Preserve Atomicity

When migrating a call site from a single-store write to a multi-store write (e.g. cog observation → cog SSOT + best-effort LTM mirror in `server/src/tools/cog.ts`), the migration must preserve PER-INVOCATION atomicity: if the original `append("observations.md", text)` accepted multi-line `text` and committed as one append, the migrated path must PARSE all lines first, THEN write all lines through `recordObservation()` — never parse-then-write per line, which produces partial writes on the first parse error and leaves the cog SSOT inconsistent with what LTM sees. Tests must drive the multi-line case through the full migrated path, not just single-line happy paths. Generalizes to any "fanout from N writes to N×M sub-writes" refactor: the outer invariant (atomicity, dedup, ordering) must survive the fanout.

_Added: 2026-06-13 | Task: Task 5 of 9 for PR 1 of the cog-LTM bridge roadmap_
