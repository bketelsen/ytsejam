---
name: bottega
description: Majordomo for Bottega — offload a self-contained dev task to the running Bottega orchestrator (github.com/vdaubry/bottega) and shepherd it to a green PR. Authors the task doc, creates + kicks off the task via Bottega's HTTP API, watches the loop in a background subagent (never blocks the chat), verifies the resulting diff against intent, and surfaces the PR. Use when the user says "have Bottega do X", "offload this to Bottega", "kick off a Bottega task", "run it through Bottega", or wants a coding task done by the Bottega agent loop instead of in this chat.
triggers: [bottega, offload to bottega, majordomo, kick off a task, run it through bottega, bottega task, agent loop]
---

# Bottega Majordomo

Drive Bottega's multi-agent loop as an API client. You author the task and shepherd it;
Bottega plans/implements/reviews/PRs in its own worktrees; **the user always merges.**

**Announce at start:** "I'm using the bottega skill to offload this to the Bottega loop."

## Division of labor (do not blur)

- **You (majordomo):** author the task doc · create + kick off the task · poll flags + runs ·
  triage blocks · **verify the resulting diff against the plan** · surface the PR. NL interface.
- **Bottega:** planning / implementation / review / (refinement) / PR-agent in worktrees.
- **User:** approves the plan (Bottega gates there) · **merges the PR.** Never you.

## Hard rules

- **Read-only by default. The only writes you make are `POST /tasks` (create) and
  `POST .../agent-runs` (kickoff)** — and only on an explicit go from the user.
- **Never merge, deploy, restart, or run deploy/*.sh.** Merge is the user's call, always —
  hand them the exact `gh pr merge` command, do not run it.
- **If the target repo is ytsejam itself:** the task is fine (it terminates at an open PR
  against a worktree + GitHub), but you must NOT merge/deploy/restart — that cutover kills the
  live session and is the user's deliberate step. See the self-modification guard.
- Task scope must terminate at "open a PR only." Bake that ceiling into the task doc.

## Setup (once)

- **API base:** `http://localhost:3001` (Bottega's Express API; client UI is `:5173`).
- **Auth:** `Authorization: Bearer <ccui_ key>`. The key is the user's account API key, minted
  in their logged-in UI (`POST /api/account/api-key`). Persist it to a user-designated path
  (default `~/.ytsejam/data/secrets/bottega-api-key`, mode 600) — never echo it back.
- The bundled `scripts/bottega-api.sh` wraps auth + jq parsing. Source it or call it directly:
  `bash scripts/bottega-api.sh <cmd>`. Run `bash scripts/bottega-api.sh check` first — it
  confirms `/health` 200 + that the key authenticates (`GET /api/auth/user`).

## The loop (flag semantics — this IS the orchestrator's state machine)

Bottega is a DB-driven dumb orchestrator: agents flip booleans; the orchestrator chains on them.
A task carries: `status`, `workflow_run_count`, and the flags
`planification_complete`, `workflow_complete`, `workflow_blocked`, `refinement_complete`,
`pr_agent_complete`. Agent runs have `agent_type` ∈
{planification, implementation, review, refinement, pr, yolo} and a `status` (running/completed).

Healthy trajectory (confirmed live 2026-06-17):
```
planification  → (HUMAN GATE: user approves plan; planification_complete=1)
implementation → review
review approves → workflow_complete=1 → refinement (if enabled) → pr
pr agent       → pr_agent_complete=1 → PR opened, CI runs
```
- `workflow_blocked=1` → the loop is stuck; surface it, do not retry blindly (triage below).
- `workflow_complete=1` is set by **review**, not implementation. Implementation finishing
  just chains to review.
- **Refinement edits the reviewer-approved diff with sub-agents re-enabled, runs no tests, and
  is NOT re-reviewed before PR.** It is currently UNCONDITIONAL in Bottega (no off switch).
  Treat any `refinement` run as "the PR contains changes no reviewer saw" — the gate is the
  only backstop. Flag this when you verify the diff.
- `MAX_WORKFLOW_RUNS = 25` is the only loop backstop. A `workflow_run_count` climbing past
  ~6–8 on a small task means thrashing — surface it.

## Workflow

### 1. Author the task doc
Write a complete, self-contained task (the agents can't see this chat). Include: repo + branch
(off main), file scope, the concrete change, **the open-PR-only ceiling**, and `Done = green
gate` (`bash scripts/gate.sh`, fallback `npm run typecheck && npm run build`). If line numbers
matter, tell the agent to **find the symbol by name, not trust coordinates** (codebases drift).
Leave one judgment call in if you want the review stage to have substance.

### 2. Create + kick off (writes — needs explicit go)
```
bash scripts/bottega-api.sh create <projectId> "<title>" "<task-markdown-or-@file>"   # POST .../tasks → taskId
bash scripts/bottega-api.sh kickoff <taskId>                                          # POST .../agent-runs (planification)
```
`projectId` from `bash scripts/bottega-api.sh projects`. After kickoff, planning runs, then
**Bottega waits for the user to approve the plan in the UI** — tell them to.

### 3. Watch — ALWAYS via `delegate`, NEVER in the foreground
The loop takes minutes (planification→implementation→review→refinement→PR). Watching it
**in this chat blocks the user** and defeats the entire point of offloading. So you do NOT
run the poll loop here. Hand the watch to a background subagent and keep the chat free:

> `delegate(label: "Watch Bottega task <id> to PR", task: "<read-only watcher instructions>")`

The subagent's job is read-only: poll `task <id>` / `runs <id>`, stop at a terminal state
(`pr=1` PR opened · `blocked=1` · `failed` · `workflow_run_count`>8 thrash), and report the
**PR number + URL + head branch** (or the blocker text). It must NOT merge, push, deploy,
restart, or kick off runs. The helper's `watch` subcommand is fine to use *inside* that
subagent, but it is a **foreground blocking call — never invoke it directly in this chat.**

Tell the user the watcher is backgrounded; surface its `[Task …]` result when it lands.
Only a sub-30s wait may be polled inline. For anything longer: delegate.

Mid-loop, to inspect without blocking: pull the shared scratchpad
`bash scripts/bottega-api.sh doc <taskId>` or per-run detail `bash scripts/bottega-api.sh runs <taskId>` (single calls, not loops).

### 4. Triage a block (`workflow_blocked=1`)
Read `doc <taskId>` (the agents write the blocker there) and the last run. Then either:
relay the question to the user, or — if it's a missing-context/scope issue — propose an
amended task. Do NOT just re-kick a blocked task; fix the cause.

### 5. Verify the diff (REQUIRED before you call it done)
A green gate proves it builds + tests pass; it does **not** prove the diff matches intent.
```
bash scripts/bottega-api.sh pr <taskId>        # → {url, state, mergeable, ciStatus}
```
Then read the actual diff and check it against your task doc, point by point:
```
gh pr diff <N>                                 # the authoritative source — read it
gh pr view <N> --json additions,deletions,changedFiles,files
```
- Confirm each required change landed and nothing out of scope was touched.
- If a `refinement` run happened, scrutinize harder — those edits were never reviewed.
- A surprising deletion count is usually reflow, not lost code — verify
  (`it()`/`test()` block count base vs head) before alarming. A real loss is a real finding.

### 6. Surface
Report: PR URL, state/mergeable, CI result, and your diff-vs-intent verdict (matches /
deviates / refinement-touched). Hand the user the merge command — **do not run it:**
```
gh pr merge <N> --squash --delete-branch     # USER runs this
```
(If the branch is checked out in a Bottega worktree, the local `--delete-branch` may fail
harmlessly — Bottega's own merge-cleanup tears the worktree down.)

## API reference (all `/api`-prefixed, JWT/key-gated unless noted)

- **Auth/account:** `GET /api/auth/user` · `GET /api/auth/status` · `POST /api/account/api-key` (mint key).
- **Projects:** `GET /api/projects` · `GET /api/projects/:id`.
- **Tasks:** `GET /api/tasks` · `GET /api/tasks/:id` · `POST /api/projects/:projectId/tasks` (create) ·
  `GET|PUT /api/tasks/:id/documentation` (shared scratchpad) · `GET /api/tasks/:id/pull-request` ·
  `POST /api/tasks/:id/resume` · `PUT /api/tasks/:id/workflow-complete`.
- **Agent runs (loop):** `POST /api/tasks/:taskId/agent-runs` (kickoff) · `GET /api/tasks/:taskId/agent-runs` ·
  `GET /api/agent-runs/:id`.
- **Copilot provider:** `GET /api/copilot-auth/status` · `GET /api/copilot-auth/models`.

## Red flags

**Never:** merge/deploy/restart · create or kick off a task without an explicit go · trust the
gate as proof of intent (read the diff) · re-kick a blocked task without fixing the cause ·
echo the API key · author a task without the open-PR-only ceiling · treat a `refinement` run
as reviewed.

## Phase sequences (multi-task dependency runner)

Use `bottega-api.sh phase ...` when a larger effort can be split into independently mergeable PRs with explicit dependencies.

Phase file shape:
```yaml
phase: "Short phase name"
project: 1
autonomous: false   # true enables auto-merge through the gate
tasks:
  - key: schema
    title: "Add DB schema"
    brief: "Implement the schema change and open a PR only."
    after: []
  - key: api
    title: "Wire API"
    brief: "Build on the merged schema PR and open a PR only."
    after: [schema]
```
(`tasks:` entries use `key`, `title`, `brief`, and optional `after`; keys must be safe slugs.)

Commands:
- `bash scripts/bottega-api.sh phase run <file.yaml>` derives the slug from the file basename, registers the scheduling seam, initializes phase state, runs one immediate tick, and prints status.
- `bash scripts/bottega-api.sh phase tick <slug>` runs one reconcile/advance/launch tick and prints status.
- `bash scripts/bottega-api.sh phase status <slug>` prints the local phase state.
- `bash scripts/bottega-api.sh phase cancel <slug>` emits the cancel directive for the recorded schedule and clears it from state.

Modes:
- Default (`autonomous: false`): launches tasks whose dependencies are merged, but parks at PR barriers for human/user merge.
- Autonomous (`autonomous: true`): after a task reaches `pr_open`, the shepherd may merge it only if the full gate passes.

Autonomous gate (fail-closed):
1. Resolve the PR head branch.
2. Read PR metadata and task blocked status.
3. Require CI status `pass`.
4. Require GitHub mergeability `MERGEABLE`.
5. Run stale-base overlap protection so a PR is parked if `origin/main` changed the same files since its merge-base.
6. Run the Bottega container gate (`incus exec ... bash scripts/gate.sh`). This is the final protection, including the stale-base lesson from the #230 incident.

Scheduling is agent-owned. The bash helper cannot call the assistant's `schedule` tool, so `_phase_schedule_register` writes `PENDING-AGENT-SCHEDULE`. After `phase run`, the agent MUST register a real schedule: cron `*/5 * * * *`, target `new_session`, prompt to run `bottega-api.sh phase tick <slug>` and report COMPLETE/parked. Then write the real schedule id into the phase state. On COMPLETE, cancel the schedule; `phase cancel` emits the cancel directive if manual cleanup is needed.

Limit: v1 seeds new task briefs from the task title in live phase creation; richer per-task `brief:`/`@file` threading is a follow-up. For rich briefs today, create a normal single Bottega task with the full task document.

Escape hatch: when the chain is tightly coupled (later steps need earlier steps' code in the same branch), use ONE big Bottega task with a 'do A then B then C' brief instead — the shepherd is for independently-mergeable PRs.
