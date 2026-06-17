# Testing — Project Lessons

Rules learned from fix cycles. Each entry is a rule a reader can apply without
re-reading the originating commit. Cap: 30 entries — prune oldest if exceeded.

## Verify Third Party Contracts Before Authoring

When integrating with a third-party library (e.g. pi-agent-core's JsonlSessionRepo), confirm its actual API surface and on-disk layout before writing helpers or plan docs against it — read the `.d.ts` and inspect the live data dir rather than assuming a shape. Pi writes sessions to `<dataDir>/sessions/--<cwd>--/<timestamp>_<sessionId>.jsonl` and exposes the canonical location via `JsonlSessionMetadata.path` (see manager.ts:128, :394), so pass that path through instead of reconstructing it or calling non-existent methods like `repo.load()`. Tests must use realistic fixtures created the way the real library would (e.g. via `JsonlSessionRepo.create` or by placing the file at the genuine `--chat--/<ts>_<id>.jsonl` path), never hand-built directories or mocks like `{ load: async () => ({}) }` that merely re-encode the helper's wrong assumption. The danger is mutual confirmation bias: a helper and its test can both pass while sharing the same incorrect model, which is exactly what slipped past the byte-level spec check twice in this PR (first `verifySessionLoadable`, then the snapshot/prune path helpers). Design diagrams and path models are part of the contract too — validate them against library reality so errors don't propagate faithfully from spec into implementation into tests.

_Added: 2026-06-12 | Task: Tasks 3+4: observability + writers + backup/verify_

## Derive Test Expectations From Named Constants Not Magic Numbers

Tests must import or reference the same constants the implementation uses, never hardcode rounded approximations — boundary assertions become wrong-but-plausible (off-by-384 here) and "16k" prose silently conflates 16,000 with 16,384.

(seen in: server/test/compaction.test.ts — `decideCompaction` boundary off by 384)

_Added: 2026-06-12 | Task: Pure-function policy module — calibration + dec_

## Confirm New Tests Actually Ran In The Gate

Read `server/vitest.config.ts`'s `include` glob before placing a new test file — co-locating in `server/src/` silently skips it and the gate still exits 0. Run `bash scripts/gate.sh 2>&1 | tee /tmp/gate.txt` and grep for your test names to prove discovery; direct `npx vitest run <file>` bypasses the gate's globbing and isn't a substitute.

(seen in: server/test/ vs server/src/ — co-located test never executed in gate)

_Added: 2026-06-12 | Task: Pure-function policy module — calibration + dec_

## Unit-Test The Handler When State Sampling Is Async

If a decision depends on the moment cross-cutting state is sampled within an async event lifecycle (handler ordering, race-safety clears, synchronous emits inside awaits), pure-helper tests give false confidence — they verify what is computed, not when state is read. Extract a pure assembler if you can, but also add at least one wiring test that drives the real handler chain (e.g. overflow→reactive-pending→agent_end→compact→retry) and asserts the observable output.

(seen in: server/src/manager.ts — orchestrator cleared `pendingCompaction` before `harness.compact()`, pi emitted `session_compact` synchronously inside, handler read null; 42 pure tests passed)

_Added: 2026-06-12 | Task: Task 5: orchestrator + main-session wiring_

## Apply Lessons To All Symmetric Call Sites

When a fix lands on one path, grep for structurally symmetric call sites and apply the same fix everywhere — don't trust "covered elsewhere" claims without a grep. Symmetric does not mean identical: a sibling path may use different emit primitives or different surrender semantics, so the test must drive each path's real emit sequence.

(seen in: subagent path got wiring tests in server/test/task-manager.test.ts; symmetric server/src/manager.ts main-session path had zero coverage)

_Added: 2026-06-12 | Task: Final review fixes: manager wiring test + diagnostics_

## Pin Documented Design Gaps With Tests Not Patches

When a test fails, check the plan/design doc's Open Questions before assuming an implementation bug — the "bug" may be the documented choice. Write tests to pin the documented behavior (assert the gap is preserved); never "fix" server code to satisfy a test that contradicts its own design doc. If a plan specifies an assertion that conflicts with its Open Questions, the design doc is authoritative — correct the test.

(seen in: docs/plans/2026-06-13-compaction-pill.md Open Question #1 — reactive retry-exhaust emits no paired `compaction_end{surrendered}` by design; plan's own test contradicted it)

_Added: 2026-06-13 | Task: Task 5 of compaction-pill — server vitest tests_

## Match Parser Validation To The Authoritative Writer

When writing a parser, match its validation to the writer's regex / validator, not the prose spec — drift lets semantically-invalid values flow downstream where `new Date(...).toISOString()` throws or the round-trip rejects, breaking self-healing reconcilers forever. Round-trip-validate dates (`new Date(\`${d}T00:00:00.000Z\`).toISOString().slice(0,10) === d`) and reuse the existing sibling parser instead of reinventing it. Add negative tests (empty tags, Feb-30, embedded newline) so permissive parsing can't regress.

(seen in: server/src/memory/bridge/ltm-observer.ts `parseObservationLine` vs SSOT regex at server/src/memory/store/append.ts:7)

_Added: 2026-06-13 | Task: Task 1 of 9 for PR 1 of the cog-LTM bridge roadmap_

## Normalize Whitespace Before Content-Addressed Dedup

Content-addressed dedup (e.g. `cog:<path>#<sha256-12>` in `server/src/memory/bridge/ltm-observer.ts`) breaks silently on CRLF when the producer and consumer split on `\n` but not `\r?\n`: the inline `recordObservation` path sees `line` without `\r`, but a reconciler reading the same file from disk and splitting on `\n` keeps the trailing `\r`, hashes a different string, and either re-mirrors forever or overwrites the dedup record's origin with the `\r` variant — defeating dedup on BOTH paths permanently. ALWAYS normalize (`split(/\r?\n/)` + `.trim()`) BEFORE the line crosses the hash boundary, and mutation-test the dedup assertion: change `split("\n")` to `split(/\r?\n/)`, write a CRLF fixture, assert per-tick replay count stays at zero on a second run. Generalizes to ANY hashed identifier derived from text the OS / user may newline-mangle.

_Added: 2026-06-13 | Task: Task 6 of 9 for PR 1 of the cog-LTM bridge roadmap_

## toBeUndefined Is Mutant-Weak for OMIT Semantics

When the spec says "field X is OMITTED (not set to undefined)" — common for backward-compat extensions like `memory.health()`'s new `ltm` field — `expect(h.ltm).toBeUndefined()` passes BOTH for the correct OMIT path AND for a buggy `return {...base, ltm: undefined}` mutant. Pair every `toBeUndefined()` against an OMIT contract with `expect("ltm" in h).toBe(false)` (when no reconciler is attached) — that mutant-kills the explicit-undefined-set bug. Mutation-test the assertion locally before shipping: temporarily change the code to `return {...base, ltm: attached ? snap : undefined}` and verify the test now fails. Generalizes to TypeScript optional fields, JSON serialization fields, and HTTP response envelopes where presence matters.

_Added: 2026-06-13 | Task: Task 7 of 9 for PR 1 of the cog-LTM bridge roadmap_

## Mutation-Test Assertions Whose Truth Could Be Structural Not Protective

An assertion may pass regardless of the code's behavior — a `try/catch` whose protected operation never threw, an absence-of-event check that's trivially true, a `toHaveLength(1)` on a stable shape. Before trusting any such test, perturb the implementation (no-op the catch, emit the forbidden event, suppress the expected one) and confirm it fails for the right reason; restore and verify `git diff` is byte-clean. If a test can't be made to fail by breaking what it pins, it has zero regression value.

(seen in: server/test/compaction-events.test.ts absence-of-event tests; LtmReconciler `consecutiveFailures` try/catch passed on the happy path)

_Added: 2026-06-13 | Task: Mutation-test discipline (merged from 2 entries)_

## Preserve Per-Invocation Atomicity Across Fanout Refactors

When migrating a single-store write to a multi-store write (cog → cog SSOT + best-effort mirror), preserve per-invocation atomicity: parse ALL lines first, then write all lines, never parse-then-write per line — partial writes on the first parse error leave the stores inconsistent. Tests must drive the multi-line case through the full migrated path, not just single-line happy paths. Generalizes to any "fanout from N writes to N×M sub-writes" refactor — the outer invariant (atomicity, dedup, ordering) must survive the fanout.

(seen in: server/src/tools/cog.ts multi-line observation append → recordObservation per-line migration)

_Added: 2026-06-13 | Task: Task 5 of 9 for PR 1 of the cog-LTM bridge roadmap_

## Assert Timer Count In Coordinator Tests

When testing `ApprovalCoordinator` in `server/test/approval-coordinator.test.ts`, asserting the resolved value and `resolutions.length` is insufficient — the `if (this.pending.delete(id))` guard satisfies those assertions whether or not `clearTimeout(entry.timer)` actually ran, so timer leaks stay invisible. After any explicit `resolve()` or `cancelSession()`, add `expect(vi.getTimerCount()).toBe(0)` (with `vi.useFakeTimers()`) so removing the `clearTimeout` call fails the suite; mutation-test both directions to confirm the assertion bites. Also make `cancelSession` in `server/src/approval/coordinator.ts` defensive: wrap the trusted `onResolved(id, decision)` callback (not the internal `entry.resolve`) in try/catch so one throwing callback can't strand sibling pending approvals for the full 5-minute timeout, and cover it with a test that asserts no throw, both promises resolve to `"deny"`, and `list()` is empty.

_Added: 2026-06-14 | Task: Task 5 — ApprovalCoordinator (approval-mode)_

## Adversarially Probe Stubbed-Out Helper Bodies

A green harness that injects stubs for dangerous helpers proves only the orchestration surface, never the real bodies' quoting, upstream-output parsing, or process-substitution exit codes — exactly where injection, wrong-pass, and fail-open defects hide; drive those bodies with shadowed system commands and hostile inputs or treat them as review-only.

_Added: 2026-06-17 | Task: Task 4 — 6-point autonomous merge gate (phase_gate) | Direct-publish_
