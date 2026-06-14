# Tooling — Project Lessons

Rules learned from fix cycles. Each entry is a rule a reader can apply without
re-reading the originating commit. Cap: 30 entries — prune oldest if exceeded.

## Document Wrapper Behavior After Guards Not The Wrapped Library

When wrapping a third-party function, JSDoc must describe what YOUR wrapper does after its guards — not what the upstream does internally. Copying upstream comments verbatim produces a docstring whose claims the wrapper's guards make structurally unreachable, luring a future maintainer into "fixing" the guard or trusting a false coverage claim. State the intended scope, name what's out of scope and why, and describe how to widen later (relax the guard, not delete it).

(seen in: server/src/compaction.ts `classifyOverflow` — guard `if (msg.stopReason !== "error") return false` made the upstream-copied silent-overflow claim unreachable)

_Added: 2026-06-12 | Task: Task 2: Overflow classifier + customInstructions + sur_

## Re-Grep HEAD Before Writing Implementation Plans

When authoring a plan, always re-grep the actual files at HEAD for real function signatures, test framework, and all call sites — never write from a stale mental model. Wrong assumptions about framework (node:test vs vitest), missed call sites, and stale parameter orders break typecheck and inflate the gate's error count past the planned number. Before adding a required positional parameter, inspect the full signature and remove dead/defaulted params; hoist repeated literal unions into a named type.

(seen in: docs/plans/ for `buildCompactionEvent` — plan assumed node:test, real tests use Vitest, 8 call sites broke typecheck)

_Added: 2026-06-13 | Task: Add `entryPoint` to `CompactionEvent` (type-level)_

## Trust File State Over Edit Success

Parallel `edit` calls to the same file in one tool-call block can silently no-op while still reporting success; in this run two edits to one file were issued together, only one landed, and both returned `Edited`. After any multi-edit block touching a single file, grep-verify that each intended change actually landed, since `git diff --stat` shows the file changed but not which individual edits applied. Trust the resulting file state, not the tool's success message, whenever multiple writes hit one file. As a habit, run `git diff` immediately after such a block to confirm every edit took.

_Added: 2026-06-13 | Task: Task 6 quality fix — non-verb title corrections in §2_

## Intercept CLI In The Arg Layer You Own

When adding a CLI surface to a binary that runs on a third-party harness (here pi-agent-core's `serve()`), intercept argv in the arg layer YOU own BEFORE calling the harness's entry point — never patch the read-only dep, never ship a separate binary that duplicates server boot. Bridge 1's `node server/src/index.ts ltm replay` works because `server/src/index.ts` line 34 does `const cliExit = await runCli(argv); if (cliExit !== null) process.exit(cliExit);` BEFORE `loadConfig()` / `serve()`. `runCli(argv)` returns `null` for non-CLI argv, falling through to normal boot. No `bin` field needed (a `npm run ltm -- ...` script wraps the invocation ergonomically). This matches the cog-meta pattern "Don't fight a framework that owns the process: intercept in the arg layer you own BEFORE serve/run and exit there." Generalizes to any "add CLI mode to existing daemon" task.

_Added: 2026-06-13 | Task: Task 8 of PR 1 of the cog-LTM bridge roadmap_

## Close Every Opened Resource On The Throw Path

A try/catch around boot wiring MUST close every successfully-opened resource on the throw path, or the resource leaks and subsequent restarts collide with the dead handle. Walk "what if the next line throws?" through each step of boot; any acquisition that happens inside a constructor (file lock, process-static registration, db handle) counts. The fix is usually ~2 LOC: `try { resource.close() } catch {}` in the catch block.

(seen in: MemorySystem.open() acquires a file lock + registers in a process-static `openDirs` set inside its ctor)

_Added: 2026-06-13 | Task: Task 7 of PR 1 of the cog-LTM bridge roadmap_

## Long-Lived Worktrees Belong In Persistent Dirs Not /tmp

A worktree at `/tmp/cog-ltm-bridge-1` was wiped mid-development on 2026-06-13 — likely by systemd-tmpfiles-clean or an aggressive subagent `rm -rf /tmp/cli-*` glob — and 4 uncommitted polish edits died with it. The git BRANCH survived because all commits live in the main repo's object store (shared across worktrees), but anything uncommitted is gone. Going forward: long-lived worktrees BELONG in `~/projects/.worktrees/<name>` or `~/work/wt-<name>` (persistent, user-owned, no cleaner targets them). Also: WIP-commit polish work BEFORE any verification step that could hang or be cancelled — `git add -A && git commit -m wip --no-verify` takes 2 seconds and is amend-able after. Apply this rule to every multi-edit task: `commit before run`, not `run then commit`.

_Added: 2026-06-13 | Task: Task 8 worktree wipe recovery_

## Never `--ignore-scripts` To Bypass A Load-Bearing Postinstall

If `npm install` fails at postinstall because `patch-package` isn't yet on PATH, the instinct to add `--ignore-scripts` ships node_modules without the load-bearing patch and the failure surfaces later as an unrelated-looking test break. Correct workflow: `npm install --include=dev --ignore-scripts` THEN run `./node_modules/.bin/patch-package` directly (now resolvable). Verify the patch landed by greping the patched file in node_modules.

(seen in: this repo's postinstall applies a `rawStopReason` patch to @earendil-works/pi-ai; `pi-ai-stop-reason` test fails silently if skipped)

_Added: 2026-06-13 | Task: Bridge 1 ship gate recovery after fresh install_

## Lessons Skill APPEND Discipline Never Heredoc-Rewrite

When the lessons skill (or any append-only doc workflow) updates `docs/agents/<theme>.md`, ALWAYS use `cat >> file << 'EOF'` (append) — NEVER `cat > file << 'EOF'` (overwrite) or `write` tools that replace the whole file. Heredoc-rewrite clobbers every prior lesson and the loss is silent until someone notices the file shrank. Pattern variants: `printf '%s\n' "..." >> file` (single-line append), `git show HEAD~1:<path> > <path>; cat >> <path>` (recovery + append after an accidental rewrite). The lessons skill's Step 4 prose says "append the lesson section" — the implementation must match. This rule generalizes to any cumulative project doc (CHANGELOG, dev-log, lessons files).

_Added: 2026-06-13 | Task: Bridge 1 lessons batching (no clobber)_
