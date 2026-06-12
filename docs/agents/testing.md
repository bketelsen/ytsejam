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
