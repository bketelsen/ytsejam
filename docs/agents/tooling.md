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

## Permissive Helpers Must Survive Permissive Inputs

When a helper's type is deliberately widened to swallow generic inputs (e.g. `deriveApprovalMode` in `server/src/approval/session-entry.ts` typed as `ReadonlyArray<{ type: string; mode?: unknown }>` to accept pi-agent-core's `SessionTreeEntry[]` without casts), never trust that signature with a non-null assertion like `entries[i]!`; a permissive type cannot exclude sparse arrays, so index access on a `null`/`undefined` hole throws `TypeError: Cannot read properties of null`. Instead read into a local and guard with optional chaining: `const entry = entries[i]; if (entry?.type === "set_approval_mode" && ...)`. Also test the real contract you claimed to support, not just convenient object literals: add a case feeding actual `import("@earendil-works/pi-agent-core").SessionTreeEntry[]` so a future dependency bump that breaks assignability fails the build, and a case with trailing `null`/`undefined` elements to lock in the no-throw behavior. The rule: if a type is intentionally loose to accept "anything," the implementation and its tests must actually handle that "anything."

_Added: 2026-06-14 | Task: Task 2 — JSONL session entry `set_approval_mode`_

## Count List Members Not String Emptiness

When a shell guard infers "was anything found?" from a captured list, test the element count (e.g. jq `[…]|length`), never the emptiness of the joined string, because `$(...)` strips the trailing newline and a lone empty-string member collapses to "" — silently passing the check it should fail. (seen in: contrib/skills/bottega/scripts/phase-lib.sh:16 — empty-string task key slips past guard)

_Added: 2026-06-17 | Task: Task 1 phase-file parse — key-shape guard | Direct-publish_

## Guard A Failed Read Before Its Empty Output Flows Onward

In a shell pipeline without `set -o pipefail`, a failed `cat`/read (rc≠0, empty stdout) feeds the next tool empty input — `jq` on empty stdin emits nothing at rc=0 — so the pipeline "succeeds" and a writer downstream fabricates empty/garbage state. Capture the read on its own line and guard its rc (`x="$(read)" || return $?`; a combined `local x="$(...)"` masks rc behind `local`'s zero exit) and/or have the writer refuse empty/null. (seen in: phase-lib.sh:phase_task_set — missing slug fabricates 0-byte state file at rc=0)

_Added: 2026-06-17 | Task: Task 2 state file — missing-slug fix | Direct-publish_

## A Captured Status Token Is Poisoned By A Child's Stdout

When you capture a function's stdout as a status token (`v="$(fn)"; [ "$v" = "ok" ]`), any stdout an inner command writes without redirection is inherited and prepended to your token — exact-equality then silently fails (and a substring match silently passes). Match the operative LAST line (`"${v##*$'\n'}"`) and have the producer capture/redirect its children; never trust `[ "$v" = … ]` on a multi-source capture. Silent test stubs mask this — every double must exercise the chatty path.

_Added: 2026-06-17 | Task: Task 5 — phase_advance_prs verdict (chatty container-gate stdout false-parked every autonomous merge) | Direct-publish_

## Always Set GIT_EDITOR=true On Git Ops That Might Open An Editor

The harness has no `$EDITOR`, so any git operation that would open one blocks silently and the shell call hangs until timeout — `rebase --continue`/`--edit-todo`, `merge --no-ff` without `-m`, `commit --amend` without `-m`, `commit` with no message. Always prefix git invocations with `GIT_EDITOR=true GIT_MERGE_AUTOEDIT=no` so the editor step auto-accepts. The failure presents as a stalled command with no output, not an error, so it is easy to misread as a slow operation.

(seen in: gate runs and merges across the ytsejam repo — `scripts/gate.sh` wraps merges with these env vars for exactly this reason)

_Added: 2026-06-18 | Task: relocate harness bash quirks out of cog patterns into canonical tooling docs_

## Split A Fork-And-Tail Into Two Shell Calls

A single shell invocation that BOTH forks a long-lived process (`setsid`, `nohup … &`) AND then tails that process's log in the same call wedges — the call never returns because the tail follows a stream the forked child keeps open. Split it into two calls: one that starts the background process and returns, and a separate later call that reads or tails the log. Foreground polling is only safe for sub-30-second waits; longer waits belong in a background subagent, not a blocking loop.

(seen in: background process management in this harness — a combined start+tail call hangs the tool turn)

_Added: 2026-06-18 | Task: relocate harness bash quirks out of cog patterns into canonical tooling docs_

## A Fresh Worktree Omits devDependencies — Verify A PR's Gate In CI Or The Main Checkout

`npm install` in a freshly-created `git worktree` does NOT populate workspace devDependencies, because the harness inherits `NODE_ENV=production` from systemd and npm then silently omits dev deps. The install "succeeds" but the gate dies with `Cannot find module 'vitest'` across EVERY test file — including ones the PR never touched, which is the tell that the failure is infrastructural, not the diff. The symptom is roughly 100 fewer `node_modules` entries than `main`. `--ignore-scripts` does not fix it, and it also skips the load-bearing `postinstall: patch-package` step (`patches/@earendil-works+pi-ai+*.patch`). Two correct ways to verify a PR's gate: (a) trust CI green — authoritative, since CI does a real `npm ci` with `env -u NODE_ENV` and applies the patch; or (b) run the gate in the MAIN checkout `/home/bjk/projects/ytsejam`, which has a complete working install (a branch switch there is safe — it is NOT the live release at `~/.ytsejam/current`). If you must install in a detached worktree, use `NODE_ENV=development npm install`. Do not burn time re-installing a detached worktree to chase a `vitest`-missing gate failure.

(seen in: PR gate verification on fresh `git worktree add` checkouts — every test file fails to import vitest)

_Added: 2026-06-18 | Task: relocate harness bash quirks out of cog patterns into canonical tooling docs_

## "Agent Doesn't See The Tool" Has Three Distinct Causes — Check Each

When an expected tool is missing from the agent's surface, the cause is one of three independent things, and they need different fixes: the tool is unregistered (never added to the catalog), the catalog cache is stale (registered but not reloaded), or the tool is registered-but-failing (its init threw, so it silently dropped out). Diagnose them separately rather than assuming registration — a registered tool whose constructor throws looks identical to an unregistered one from the agent's side.

(seen in: tool-catalog debugging in this harness)

_Added: 2026-06-18 | Task: relocate harness bash quirks out of cog patterns into canonical tooling docs_

## Rewrite Comma-Operator-In-Ternary Guards As Plain If Statements

The pattern `cond ? (sideEffectThatThrows(), realValue) : fallback` smuggles a guard into an expression — the side-effect call (e.g. `c.resolveFile(domain, file)` throwing on a missing file) runs for its throw, and the comma operator discards its result so `realValue` is what the ternary yields. This obscures the guard: a future edit to `realValue` carries the throwing guard along silently, and a reader scanning for control flow never sees it. Rewrite to plain `if` statements so the guard is visible. Find every site with `grep -E '\?\s*\([a-zA-Z_.]+\([^)]*\)\s*,'`.

(seen in: `server/src/memory/consolidated/entity-audit.ts` and `cluster-check.ts` — the only two sites at the time)

_Added: 2026-06-18 | Task: relocate harness bash quirks out of cog patterns into canonical tooling docs_

## Verify A List-Removal Diff By Grepping Every Mention And Reading The Diff

When a change claims to "remove X from a list" in a doc or config, the failure mode is a half-edit that rewrites the prose AROUND the item but leaves the item itself physically present — often relocated under an "out of scope", "deferred", or "future" header rather than deleted. A dropped line count looks like success but the item still exists. Verify by grepping every mention of the id (`grep -n <id>`) and reading the actual `git diff` of the file, not just confirming the line count changed.

(seen in: doc edits that "remove" an item but leave it under a deferred-scope header)

_Added: 2026-06-18 | Task: relocate harness bash quirks out of cog patterns into canonical tooling docs_
