# Bottega Sequence Shepherd — Design

Date: 2026-06-17
Status: Approved (brainstorm complete) → write-plan next
Branch (intended): `bottega-sequence-shepherd`

## Problem

Bottega has **no native inter-task dependencies** (schema-confirmed: the `tasks` table has no
`depends_on`/`parent_id`/`order`/`epic`/`phase`; no edge/join table; create accepts only
`{title?, description?, yolo_mode?}`). It models only **intra-task** phase sequencing
(planification → implementation ↔ review → refinement → pr) and gives each task an isolated worktree
on a branch **cut from the default branch** (`worktree.ts`: base via `origin/HEAD` → fallback `main`).
Task B therefore **cannot see task A's unmerged changes** — B's branch is frozen at B's creation time.

We want to fire off a multi-task "phase" (several PR-sized tasks in dependency order), optionally
before bed, and have the work walk to completion with the right ordering — including, when explicitly
opted in per run, auto-merging PRs that clear a hard safety gate.

## Boundary (one sentence)

A **client-side DAG runner over Bottega**: Bottega stays the per-task execution engine; the ordering
between tasks lives entirely in a phase file + an idempotent tick loop in the existing `bottega` skill.
**Zero Bottega changes.** The shepherd creates and launches tasks, watches them to open PRs, and —
only when the run is opted into autonomous mode — merges the ones that clear a hard safety gate;
everything else parks for the user.

### Alternatives considered
- **Wait for native Bottega dependencies** — rejected: no schema for it, no roadmap signal; blocks indefinitely.
- **Collapse a phase into one big Bottega task** with a "do A then B then C" brief — this is the *right*
  tool when steps are tightly coupled (one branch, later steps see earlier ones). The shepherd documents
  this as the escape hatch and tells the user to do it instead when the chain is tight.
- **Client-side DAG** — chosen: the only option that yields independently reviewable/mergeable PRs in
  dependency order, which is the whole point of splitting a phase.

## The load-bearing constraint

`after:` means **"after the dependency's PR is MERGED to main,"** not "after its PR opened" — because B's
branch is cut from main at B's creation time and can't see A until A is on main. **The merge is the
synchronization barrier**, and the merge is the user's call (a standing rule). A fully-autonomous
phase-runner therefore cannot exist by default; what exists is a **sequence shepherd** with a per-run
autonomy opt-in.

## Phase file (user authors this)

`~/.bottega/phases/<slug>.yaml` (or any path passed to `phase run`):

```yaml
phase: "Add rate limiting"
project: 1                      # Bottega project id
autonomous: false              # DEFAULT ONLY. Real autonomy is chosen at LAUNCH, per run (never a stored default).
tasks:
  - key: schema                # stable handle for edges (the Bottega task id does not exist yet)
    title: "Add rate_limit columns + migration"
    brief: @briefs/schema.md   # @file → goes through the doc-verify guard
  - key: middleware
    title: "Rate-limit middleware reading the new columns"
    brief: @briefs/middleware.md
    after: [schema]            # waits until schema's PR is MERGED to main
  - key: docs
    title: "Document rate-limit config"
    brief: @briefs/docs.md
    after: [schema]            # also waits on schema → runs PARALLEL to middleware
```

Deliberate choices:
- **`key`, not task-id** — the Bottega task doesn't exist until the shepherd creates it; edges reference
  stable keys; the shepherd maps key → real id as it creates them.
- **`autonomous:` is only a default of `false`** — never a per-task flag (that is the stale-config trap,
  explicitly rejected). The decision is made at launch.
- **`after:` = after MERGED** (the merge barrier, encoded).

YAGNI (v1): only `key`, `title`, `brief`, `after`. No priorities, retries, per-task timeouts, or
conditional/dynamic edges until a real phase needs them.

## The tick (self-scheduling, idempotent, over a state file)

The shepherd is NOT a long-running process. It is one idempotent **tick** that the `schedule` tool
re-fires (~5 min) into a **new session**, reading a persisted state file each time. A crash loses one
tick, not the phase. Harness-native (`schedule` + `target:new_session`).

### State file — SSOT — `~/.bottega/phases/<slug>.json`
```json
{
  "phase": "Add rate limiting",
  "project": 1,
  "autonomous": false,
  "scheduleId": "<cron id, so the final tick cancels itself>",
  "tasks": {
    "schema":     { "key":"schema", "taskId": 6, "state": "merged",   "pr": 231, "after": [] },
    "middleware": { "key":"middleware", "taskId": 7, "state": "pr_open", "pr": 232, "after": ["schema"] },
    "docs":       { "key":"docs", "taskId": null, "state": "pending",  "pr": null, "after": ["schema"] }
  },
  "log": ["...append-only audit of every create/merge/park..."]
}
```
Per-task `state` ∈ `pending → created → running → pr_open → {merged | parked | failed}`.

### One tick, in order (every step safe to run twice)
1. **Reconcile** — for each non-terminal task, GET real Bottega status + PR status; write truth to state.
2. **Advance PRs** — for each `pr_open`: run the safety gate (below). Autonomous + passes → merge, mark
   `merged`. Fails / not autonomous → leave `pr_open` or mark `parked` with a reason.
3. **Launch ready** — ready set = `pending` tasks whose every `after:` dep is `merged`. For each:
   `create` (with doc-verify guard) → `kickoff` → mark `running`.
4. **Write state + continue/stop** — any task non-terminal → schedule keeps firing. All terminal →
   cancel the schedule (via stored `scheduleId`) and send the final report.

**Idempotency is the safety story** (the user is asleep; a double-fire must be harmless): every mutating
step is guarded by the state file — has a `taskId`? don't re-create. Already `merged`? don't re-merge.
Cadence ~5 min. **Polling, not webhooks** — Bottega has no merge-completion webhook (its webhooks only
trigger PR-comment agent runs).

## Launch modes + autonomous safety gate

Two launch verbs (autonomy chosen here, per run — never stored):
- **`phase run <file>`** — DEFAULT. Walks the DAG, runs every ready task to an **open PR**, parks at
  every merge barrier. No machine merges. Dependents launch on the next tick after the user merges.
- **`phase run <file> --autonomous`** — bedtime mode. Same walk, but at each `pr_open` the shepherd may
  auto-merge if the gate passes, advancing the whole DAG unattended.

### Autonomous merge gate — ALL must pass, or PARK (never merge on doubt)
1. **Gate green** — run `scripts/gate.sh` on the PR branch *ourselves* in a worktree (don't trust CI's word
   alone). **Runs IN THE CONTAINER** (`incus exec bottega -- su - code -c ...`), where the ytsejam checkout,
   the gate, and the per-task worktrees already live — not on the host. The tick shells into the container to
   fetch the PR branch into a throwaway worktree, run the gate, read the exit code, and remove the worktree.
2. **CI passed** — GitHub checks green.
3. **MERGEABLE** — no conflicts.
4. **Clean termination** — not `workflow_blocked`, not run-count thrash.
5. **Intent match** — our judgment: the diff does what the brief/title intended. (Decision: judgment only, no allowlist.)
6. **Stale-base / sibling-revert check (mechanical, the backstop #5 can't be):** compute the files this
   PR changed ∩ the files main gained since this task's branch forked (`git merge-base` → diff). **Non-empty
   intersection → the PR may revert a sibling's commit → PARK, never auto-merge.**

> Gate #6 exists because of a live incident (2026-06-17, PR #230): a refinement-stage "rename for
> clarity" on a branch forked before a sibling commit would have silently reverted that commit on merge.
> Intent-match (#5) *passed* it — the rename looked clean. Only the mechanical merge-base check catches it.

On any fail → **park that task** (PR stays open, reason logged), **keep advancing everything else**. One
stuck PR never halts the phase.

Safety floor (both modes): never merge a task whose dep isn't merged; never force-push; never delete
anything but a merged PR's own branch (`gh pr merge --squash --delete-branch`); never touch a
user-opened PR.

## Failure, parking, notification

**Park, don't halt.** Any blocked task (gate fail, conflict, stale-base, `workflow_blocked`, thrash, or a
UI-only `AskUserQuestion` stall) → `parked` + one-line reason; other work continues.

| Terminal state | Autonomous run | Default run |
|---|---|---|
| `merged`   | gate passed → squash-merged, branch deleted | n/a |
| `pr_open`  | gate failed/doubt → left open, reason logged | normal end — user merges |
| `parked`   | blocked/stalled/conflict → open, reason logged | same |
| `failed`   | a run errored → reason + run id logged | same |

**UI-question stall** (mid-plan `AskUserQuestion` is invisible to REST — confirmed on tasks 3 & 4): tick
detects "run non-running but task not complete/blocked, no progress ~3 ticks" → `parked: awaiting UI
answer at :5173`, stops re-launching that branch (dependents stay `pending`). User answers in the UI;
next tick resumes. Never spins.

**Notification (no spam):**
1. Phase complete OR fully stalled → one summary message (this session, or `new_session` if set at
   launch): table of every task → final state, PR #/URL, merged-or-park-reason, plus wall-clock elapsed +
   tick count (heartbeat). The "what happened overnight" read.
2. Mid-run only on a hard stop (entire phase parked before completion) → report early rather than ticking
   pointlessly. Routine per-task parks while other work continues do NOT ping — they are in the summary.

State file always inspectable: `phase status <slug>` prints the live table from the JSON — no need to ask
"is it stuck."

## What gets built (added to the existing `bottega` skill — not a new system)

- `bottega-api.sh phase` subcommands: `run <file> [--autonomous]`, `status <slug>`,
  `tick <slug>` (the idempotent pass the scheduler calls), `cancel <slug>` (stop, leave PRs as-is).
- A tiny YAML→JSON step (`yq` if present, else a ~15-line parser). The phase file is the only YAML; state
  is JSON + `jq`.
- The tick logic (reconcile / advance-PRs / launch-ready / write-state), all guarded by the state file;
  the 6-gate (incl. the `git merge-base` stale-base check) lives here.
- `SKILL.md` section: phase-file shape, two launch modes, the gate, and the "use one big task when the
  chain is tight" escape hatch.
- Self-scheduling: `phase run` writes state, fires the first `tick`, registers a `schedule` cron (~5 min);
  the final tick cancels it via the stored `scheduleId`.

### YAGNI line — NOT built in v1 (so absence reads as intent)
- ❌ No "branch task B off task A's branch" — Bottega can't (branch-off-main hardcoded). The merge barrier
  IS the dependency primitive; don't fake it.
- ❌ No priorities, retry-counts, per-task timeouts, conditional/dynamic edges, sub-phases.
- ❌ No web UI/dashboard — `status` table + JSON file suffice.
- ❌ No auto-rebase of a stale-base PR — gate #6 detects + parks; resolving it is the user's call (the
  exact judgment that bit #230). v1 protects, doesn't auto-fix.
- ❌ No persistence beyond one JSON file per phase — survives restarts because the scheduled tick re-reads it.

## Effort / blast radius

Low-blast, reversible: a self-contained addition to a script + a skill doc + a cron registration. Touches
no Bottega code, no ytsejam server code, no `main` behavior. Worst case it mis-sequences and parks
everything — safe-by-construction because the gate refuses to merge on any doubt. The single risky
surface is the auto-merge gate function; it is the part to test hardest.

## First-use recommendation (not part of the build)

The first autonomous run should be low-stakes (a couple of test-add tasks, like the `previewOf` task) so
the gate is observed on real PRs before it is trusted with anything touching server logic.

## Grounding facts (confirmed this session)

- **DECISION (2026-06-17): gate #1 runs in the `bottega` container**, not the host — the container holds
  `/home/code/projects/ytsejam` (a real checkout @ `bade808`, with `scripts/gate.sh` + AGENTS.md gate
  breadcrumb) and is where Bottega cuts each task's worktree, so verifying there matches the execution
  surface. The shepherd skill itself runs on the host; only the gate step shells in via `incus exec`.

- No native task dependencies; `tasks` schema + `init.sql` have no edge/order/parent columns; create =
  `{title?, description?, yolo_mode?}`.
- Worktree base is the default branch (`worktree.ts`); task B does not branch off task A.
- Concurrency is per-task only (`agent-runs.ts` 409 "An agent is already running for this task"); no global
  lock → tasks run in parallel.
- `POST /tasks/:id/merge-cleanup` exists (Bottega *can* merge via API) — but merge stays the user's call;
  the shepherd uses `gh pr merge` only under an autonomous run.
- No merge-completion webhook (`routes/webhooks.ts` only triggers PR-comment agent runs) → poll.
- Prompts are read-per-run and overridable at `~/.bottega/prompts/<name>.md` via
  `GET/PUT/DELETE /api/settings/prompts/:name` (used this session to make refinement run the test suite).
- Create-brief field is `description` (written to `task-<id>.md`); `documentation` is silently dropped →
  the doc-verify guard reads the brief back after create.
- AskUserQuestion mid-plan is UI-only (invisible to REST); only the user at `:5173` can answer.
- Live incident motivating gate #6: PR #230 (forked at `023635f`, before guard commit `bade808` touching
  the same file) would have reverted the guard on merge; salvaged the test into `36d8cee`, closed #230.
