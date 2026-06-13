# Tooling — Project Lessons

Lessons learned from failures and fix cycles.
Auto-appended by the lessons skill.

## Document Wrapper Behavior Not Wrapped Internals

When wrapping third-party functions like pi-ai's `isContextOverflow` (see `classifyOverflow` in compaction.ts:74-81), write JSDoc that describes what YOUR wrapper actually does after its guards, not what the underlying library does internally — copying upstream source comments verbatim produced a docstring claiming z.ai/MiMo silent-overflow coverage that the `if (msg.stopReason !== "error") return false` guard makes structurally unreachable. Verify behavior claims empirically (the reviewer caught this by running both functions against a synthetic silent-overflow message and seeing the wrapper return `false` where the claim said `true`) rather than trusting plan-doc snippets. When a guard deliberately narrows behavior, the comment must say so explicitly and flag any inert arguments (like the forward-compat-only `model.contextWindow`), because a misleading docstring is worse than none: it lures a future maintainer into "fixing" the guard or trusting a false coverage claim. State the intended scope, name what is out of scope and why, and describe the correct way to widen it later (relax the guard with a usage-based check, never just delete it).

_Added: 2026-06-12 | Task: Task 2: Overflow classifier + customInstructions + sur_

## Hoist Imports To Top In Append Workflows

When a plan instructs you to "append" to an existing file like `server/test/compaction.test.ts`, treat import statements as an exception: always fold new imports into the existing top-of-file import block rather than adding a second block near your new code. In this case the appended tests created a mid-file import at lines 115-116 that redundantly re-imported `AssistantMessage` from `@earendil-works/pi-ai` when `Model` was already imported from that package on line 2 — consolidate by merging type imports into one `import type { Model, AssistantMessage }` line and hoisting `../src/compaction.ts` symbols into the single existing import. Since the only quality gate is `tsc --noEmit` (no ESLint), nothing flags this structural drift automatically, so verify manually with `grep -n '^import' <file>` and confirm all matches fall in the top block. This matters because incremental plan-driven tasks compound the problem — each subsequent task that appends its own imports deepens the drift, so fixing it immediately keeps the file idiomatic for the next implementer.

_Added: 2026-06-12 | Task: Task 2: Overflow classifier + customInstructions + sur_

## Preserve Plan Defensive Details In Briefs

When lifting plan-doc content into per-task implementer briefs, copy defensive
code and explanatory "why" comments verbatim — never silently simplify them. In
the #72 fix this recurred three times: Task 3 dropped the plan's 2-level
`summaryTokens ?? Math.ceil(String(summary ?? "").length / 4)` fallback
(collapsing it to `?? 0`, which would silently undercount on a surrender-path
or future-pi `compactionEntry` and corrupt the Task 4
`succeeded = tokensAfterEstimated < budget` gate) and dropped the 6-line
why-comment above `let tokensAfterEstimated = 0;` in both
`server/src/manager.ts` and `server/src/task-manager.ts`, inviting a future
reader to "restore" the exact `?? tokensAfter` fallback that was the #72 bug.
Avoid omitting anything the plan specifies, and avoid adding anything the plan
omits, without explicitly recording the divergence and its rationale in the
brief. Because these helpers live at symmetric call sites, apply identical text
at every site for grep-discoverability (verified via
`grep -n "tokensAfterEstimated = 0"`). If a brief must diverge from the plan,
flag it loudly so reviewers and `git blame` readers see the reasoning instead
of an unexplained simplification.

_Added: 2026-06-12 | Task: Use estimateKeptSetTokens for tokens_after_estimated (#72)_

## Re-Grep HEAD Before Writing Implementation Plans

When authoring an implementation plan (e.g. via the write-plan skill), always re-grep the actual files at HEAD for the real function signature, test framework, and all call sites before prescribing changes — never write from a stale mental model. In ytsejam, a plan for `buildCompactionEvent` in `server/src/compaction.ts` wrongly assumed `node:test`/`node:assert` when the test file uses Vitest (`describe`/`it`/`expect`), and missed that 8 existing calls in the `describe("buildCompactionEvent")` block would break typecheck, so `npm run check` exited 2 with 10 errors instead of the planned 2 and broke the gate. The plan also bolted a new required `entryPoint` arg on as the last positional without inspecting the existing signature, which still carried a dead `_devLogPath` param and a now-pointless `compactionEntry = {}` default. Before adding a required positional parameter, inspect the full signature and remove dead/defaulted params, and hoist repeated literal unions (like `"idle" | "inner_loop" | "reactive_path"`) into a named type (`CompactionEntryPoint`). Accurate expected-failure analysis depends on counting every real call site in scope, so the gate's error count matches the plan.

_Added: 2026-06-13 | Task: Add `entryPoint` to `CompactionEvent` (type-level)_

## Trust File State Over Edit Success

Parallel `edit` calls to the same file in one tool-call block can silently no-op while still reporting success; in this run two edits to one file were issued together, only one landed, and both returned `Edited`. After any multi-edit block touching a single file, grep-verify that each intended change actually landed, since `git diff --stat` shows the file changed but not which individual edits applied. Trust the resulting file state, not the tool's success message, whenever multiple writes hit one file. As a habit, run `git diff` immediately after such a block to confirm every edit took.

_Added: 2026-06-13 | Task: Task 6 quality fix — non-verb title corrections in §2_

## Intercept CLI In The Arg Layer You Own

When adding a CLI surface to a binary that runs on a third-party harness (here pi-agent-core's `serve()`), intercept argv in the arg layer YOU own BEFORE calling the harness's entry point — never patch the read-only dep, never ship a separate binary that duplicates server boot. Bridge 1's `node server/src/index.ts ltm replay` works because `server/src/index.ts` line 34 does `const cliExit = await runCli(argv); if (cliExit !== null) process.exit(cliExit);` BEFORE `loadConfig()` / `serve()`. `runCli(argv)` returns `null` for non-CLI argv, falling through to normal boot. No `bin` field needed (a `npm run ltm -- ...` script wraps the invocation ergonomically). This matches the cog-meta pattern "Don't fight a framework that owns the process: intercept in the arg layer you own BEFORE serve/run and exit there." Generalizes to any "add CLI mode to existing daemon" task.

_Added: 2026-06-13 | Task: Task 8 of PR 1 of the cog-LTM bridge roadmap_

## Latent Partial-Init Leaks In Try/Catch Boot Wiring

Resource acquisition that happens INSIDE a constructor (e.g. `MemorySystem.open()` acquires a file lock + registers in a process-static `openDirs` set inside its ctor) means a try/catch around the boot sequence MUST close every successfully-opened resource on the throw path, or else the resource leaks and subsequent restarts collide with the dead handle. Today's leak may be unreachable (only post-open work is pure assignment) but the fix is cheap (~2 LOC: `try { ltm.close() } catch {} ` in the catch block) and one PR change away from being real. Apply this to ANY boot wiring that opens stateful resources between the open call and the success path — verify by mentally walking "what if the next line throws?" through each step.

_Added: 2026-06-13 | Task: Task 7 of PR 1 of the cog-LTM bridge roadmap_

## Long-Lived Worktrees Belong In Persistent Dirs Not /tmp

A worktree at `/tmp/cog-ltm-bridge-1` was wiped mid-development on 2026-06-13 — likely by systemd-tmpfiles-clean or an aggressive subagent `rm -rf /tmp/cli-*` glob — and 4 uncommitted polish edits died with it. The git BRANCH survived because all commits live in the main repo's object store (shared across worktrees), but anything uncommitted is gone. Going forward: long-lived worktrees BELONG in `~/projects/.worktrees/<name>` or `~/work/wt-<name>` (persistent, user-owned, no cleaner targets them). Also: WIP-commit polish work BEFORE any verification step that could hang or be cancelled — `git add -A && git commit -m wip --no-verify` takes 2 seconds and is amend-able after. Apply this rule to every multi-edit task: `commit before run`, not `run then commit`.

_Added: 2026-06-13 | Task: Task 8 worktree wipe recovery_

## npm install --ignore-scripts Skips Load-Bearing Patches

This repo's `postinstall` runs `patch-package`, which APPLIES a load-bearing patch to `@earendil-works/pi-ai@0.79.1` (adds `rawStopReason` propagation). On a fresh worktree, `npm install` fails at postinstall because `patch-package` isn't yet on PATH. The instinct is to add `--ignore-scripts` to bypass it — but that ships node_modules WITHOUT the patch, and one specific test (`pi-ai-stop-reason`) fails empirically while the unrelated symptom (`vitest types not found` etc.) misleads. Correct workflow: `npm install` first; on `patch-package: not found` failure, `npm install --include=dev --ignore-scripts` THEN `./node_modules/.bin/patch-package` (now resolvable). Verify: `grep -E "rawStopReason" node_modules/@earendil-works/pi-ai/dist/*.js` should match. Add a comment to docs/agents/deployment.md if this hits a friend.

_Added: 2026-06-13 | Task: Bridge 1 ship gate recovery after fresh install_

## Lessons Skill APPEND Discipline Never Heredoc-Rewrite

When the lessons skill (or any append-only doc workflow) updates `docs/agents/<theme>.md`, ALWAYS use `cat >> file << 'EOF'` (append) — NEVER `cat > file << 'EOF'` (overwrite) or `write` tools that replace the whole file. Heredoc-rewrite clobbers every prior lesson and the loss is silent until someone notices the file shrank. Pattern variants: `printf '%s\n' "..." >> file` (single-line append), `git show HEAD~1:<path> > <path>; cat >> <path>` (recovery + append after an accidental rewrite). The lessons skill's Step 4 prose says "append the lesson section" — the implementation must match. This rule generalizes to any cumulative project doc (CHANGELOG, dev-log, lessons files).

_Added: 2026-06-13 | Task: Bridge 1 lessons batching (no clobber)_
