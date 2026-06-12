# Delegation (background subagents)

> Sub-doc of [`OVERVIEW.md`](OVERVIEW.md). Code: `server/src/task-manager.ts`, `server/src/tasks.ts`,
> `server/src/tools/delegation.ts`.

The assistant can hand long-running or multi-step work to a **background subagent** via the
`delegate` tool. The subagent runs in-process with its own JSONL session and its own `AgentHarness`,
concurrently with the chat. The assistant keeps talking to the user; when the subagent finishes (or
fails/times out), its final report is injected back into the parent session as a `[Task ...]`
message and the assistant takes a turn on it.

## The `delegate` tool

`createDelegationTools(getTaskManager, sessionId)` (`tools/delegation.ts`) returns three per-session
tools — `delegate`, `check_task`, `cancel_task`. `delegate` params:

- `task` — **complete, self-contained instructions.** The subagent **cannot see the conversation**;
  everything it needs must be in here.
- `label` — short UI label (3–6 words).
- `context` — optional extra background (appended to the task as `\n\nContext:\n<context>`).
- `model` — optional `provider/modelId` override (defaults to `YTSEJAM_SUBAGENT_MODEL`, which itself
  defaults to `YTSEJAM_DEFAULT_MODEL`). Bad model refs fail the tool call early, not the run.

The tool returns immediately with a task id. `TaskManager` is **late-bound** via a `() => taskManager`
getter because it's constructed after the `AgentManager` at boot (`server/src/index.ts`).

## Lifecycle (event-sourced; JSONL is SSOT)

`TaskStore` (`tasks.ts`) is an append-only log, **one `tasks/<task-id>.jsonl` per task**. Events:
`created` → `started` → (`completed` | `failed` | `cancelled` | `interrupted`). The current row is a
pure fold (`foldTaskEvents`) over those events; the sqlite `tasks` row and the bus `task` events are
**derived** from the fold (`TaskManager.record()` appends, folds, upserts the index, emits).

Flow inside `TaskManager`:

1. **`delegate()`** validates the model, appends `created`, pushes the id onto the in-memory `queue`,
   and calls `pump()`.
2. **`pump()`** starts tasks while `runningCount < concurrency` and the queue is non-empty.
3. **`run()`** creates a subagent session (repo cwd `"subagent"`, invisible to the chat sidebar),
   appends `started`, builds the worker harness, and `await`s `harness.prompt(task)`. On success it
   records `completed` with the report (capped at 16k for injection, 500 for the index summary); on
   timeout/abort/error it records `failed`.
4. **Notify parent.** Unless the task was cancelled, the outcome text is injected into the parent
   session via `notifyParent` → `manager.injectMessage` (which queues a follow-up if the parent is
   mid-run, else starts a fresh turn).

### Subagent working directory

The subagent's cwd-bearing tools (`bash`/file/search) are built against the **parent session's
resolved workdir** (`resolveParentWorkdir`), so its files land in the repo the user is discussing —
not the data dir. A per-task `NodeExecutionEnv` is rooted there too (so the harness's own filesystem
work, e.g. compaction reads, also resolves there) without mutating the shared session-repo env. The
worker system prompt (`composeWorkerPrompt`) names the bound workdir explicitly.

**Absolute-path requirement.** Because the subagent's *relative* paths resolve against the parent
workdir, any agent writing a `delegate` `task` must use **absolute paths** for files outside that
workdir. This is the single most common subagent footgun — see the worktree gotcha below.

### Mid-stream interruption retry

If the provider kills generation mid-stream (`stopReason === "error"`, e.g. a content-safety stop
while quoting sources) and the task wasn't cancelled, `run()` answers any dangling `toolCall`s with a
synthetic error `toolResult` (the Anthropic API rejects a context with a `tool_use` that has no
`tool_result`) and **retries once** with `RETRY_NUDGE` — a prompt telling the subagent its last reply
was cut off, to paraphrase sources instead of quoting, and to redo the interrupted tool call. (The
worker prompt also pre-warns about long verbatim quotes.) The accompanying patch
(`patches/@earendil-works+pi-ai+0.79.1.patch`) surfaces the raw provider `stop_reason` in the error
message so this path is diagnosable.

## Concurrency & timeout config

- **`YTSEJAM_TASK_CONCURRENCY`** (default 4) — max subagents running at once. Clamped to ≥1
  (`config.ts`) so a bad value can't stall the pump. Excess tasks wait in `queue`.
- **`YTSEJAM_TASK_TIMEOUT_MIN`** (default 15) — per-task timeout in minutes; clamped to ≥1. On expiry
  the harness is aborted and the task is recorded `failed` with a "timed out after Ns" summary.

## No nested delegation

**Subagents cannot delegate further.** This is enforced by *not wiring* the delegation tools into the
worker toolset: `TaskManager` builds subagent tools from `workerTools` (the cwd-independent globals —
web search/fetch) + `createSessionCwdTools(parentWorkdir)`. There is no `delegate`/`schedule`/`skill`
tool in that set, and the `delegate` tool's own description states the rule for the model. If you ever
add tools to subagents, do **not** add delegation/scheduling.

## Cancellation & crash recovery

- **`cancel()`** records `cancelled` **before** aborting the harness, so a cancel always wins: the
  abort is fire-and-forget (a tool mid-execution can hold `abort()` for minutes), and when the run
  eventually settles `run()` sees the `cancelled` status and skips the fail/notify. Cancelling a
  queued (not-yet-started) task just removes it from the queue.
- **`recoverInterrupted()`** runs on boot: any task left `pending`/`running` by a previous process is
  recorded `interrupted` and the parent is told the server restarted and to re-delegate if still
  needed. (A subagent's in-memory harness does not survive a restart.)
- **`rebuildIndex()`** repopulates the derived sqlite `tasks` table by folding every task's JSONL.

## Transcripts

`GET /api/tasks/:id/transcript` returns the subagent session's messages (the UI's `TaskCard` polls
it while running). The subagent session JSONL is real and persists under `sessions/` with repo cwd
`"subagent"`; it's just hidden from the chat sidebar.

## The subagent worktree gotcha (`NODE_ENV=production` install)

The harness shell that runs a subagent's `bash` tool inherits the prod environment, which includes
**`NODE_ENV=production`** (the systemd unit pins it). `npm install`/`npm ci` under
`NODE_ENV=production` **skips `devDependencies`** — which for this repo means no `vitest`, `vite`,
`typescript`, or `tsc`. So a subagent that clones/worktrees the repo and runs a bare `npm install`
then `bash scripts/gate.sh` will fail: the gate needs devDeps.

**Workaround pattern (use this in subagent task prompts that build/test the repo):**

- The quality gate already self-heals: `scripts/gate.sh` runs each step under `env -u NODE_ENV ...`,
  so it installs/builds with devDeps regardless of the inherited environment.
- For the **install** step the gate does *not* perform, clear `NODE_ENV` explicitly:
  `env -u NODE_ENV npm install` (or `npm ci --include=dev`). `deploy/deploy.sh` does exactly this
  (`env -u NODE_ENV npm ci --include=dev --ignore-scripts`), as does `deploy/dev.sh`.
- A common, cheaper alternative for an in-repo worktree: **symlink `node_modules`** from the main
  checkout into the worktree (root, `server/`, and `web/`). The `docs/agents` worktree this very doc
  was written in does this. The dev-workflow port (`docs/plans/2026-06-12-norma-skills-port.md`, D5)
  bakes "keep the node_modules symlink trick" into its implementer prompts.

Bottom line for a subagent prompt that touches the build: **either symlink node_modules from a known-good
checkout, or run installs with `env -u NODE_ENV`. Then run `bash scripts/gate.sh` (which clears
`NODE_ENV` itself).** Use absolute paths throughout.
