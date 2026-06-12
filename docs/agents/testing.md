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
