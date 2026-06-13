# Memory Store Auto-Commit Cadence — Design

> Status: approved (path B, baked-in assumptions). No /brainstorm round held;
> design fixed by Mentat with user approval 2026-06-13.

## Problem

The memory store accretes append-only writes from every session, but nothing
forces a `git commit` between sessions. Dirty working trees grow until the
weekly housekeeping notices and squashes a backlog (4 files on 2026-06-07,
75 files on 2026-06-12). Between housekeeping passes, a process kill or
disk failure loses every uncommitted observation.

The original prescription (D7 of the cogmemory fold plan) targeted the
retired Go daemon. The fold left the in-process TS memory module with
primitive `git` wrappers only — no cadence layer. D7 was deferred because
the fold body was already large.

## Goal

A write-hook layer inside `server/src/memory/store/` that triggers
`git commit` automatically after writes, so:

1. The memory store is never more than N writes behind committed history.
2. A crash loses at most N uncommitted writes.
3. No skill or operator has to remember to commit.
4. Auto-commits are visually distinguishable from human/skill commits in
   `git log`, so housekeeping can squash them if it wants to.

## Out of scope

- Time-based cadence (knob (b) from improvements.md).
- Session-end signal (knob (c) from improvements.md). Ytsejam has no
  documented "session end" hook today; adding one couples this PR to
  session-lifecycle work that is not on the table.
- Backfilling the existing dirty tree — housekeeping owns that.
- Rewriting historical commit messages.

## Non-goals (deliberate)

- Configurability via runtime API. The cadence is a constant for now;
  we can promote it to settings once we know the right number.
- Auto-push to a remote. The memory store has no remote in normal
  operation; this is purely local commit cadence.

## Design

### Trigger: every N writes (knob (a) only)

A counter in the store module, bumped each time `write`, `append`,
`patch`, or `move` mutates a file. When the counter reaches `N`, the
hook invokes `git add -A && git commit -m "<auto-commit message>"`
and resets the counter.

**N = 10.** Justification: dense days produce ~50-100 writes; N=10 gives
5-10 auto-commits/day, small enough to keep blast radius low, large
enough that `git log` isn't dominated by auto-commits. Easy to tune
later — it's one constant.

**Counter is in-process.** Survives nothing across restarts. That is fine:
on restart the next write will commit if the tree is dirty (see "startup
flush" below); the counter just resets to 0. We do not persist counter
state — the source of truth is "is the working tree dirty?", not "how
many writes since last commit?"

### Startup flush

On first write after process start, if `git status --porcelain` is
non-empty, commit immediately with message `auto: startup flush (uncommitted
from previous session)` BEFORE applying the new write. This catches the
case where a previous process died with uncommitted writes — instead of
piling onto an already-dirty tree, we close the previous chapter first,
then start counting toward the next auto-commit.

If the tree is dirty but `git status` shows ONLY rebase/merge conflict
markers (not just unstaged files), we skip the flush and warn — that's
not our mess to clean up.

### Hook placement

A single function `maybeAutoCommit()` exported from a new file
`server/src/memory/store/auto-commit.ts`. Called by `write`, `append`,
`patch`, and `move` AFTER the file mutation succeeds (so failed writes
don't bump the counter). Order is "mutate, then commit" — the write
itself is durable on disk even if the commit later fails.

### Failure isolation

If the commit fails for ANY reason (not a git repo, lock file, detached
HEAD, merge in progress, network outage if remote were configured), the
auto-commit silently logs at WARNING via `console.warn` and the write
call returns success. Memory writes MUST NOT fail because of commit
problems — that's a worse failure mode than the dirty-tree problem we
are trying to solve.

The warning shape: `ytsejam memory auto-commit: <reason>` — one line,
so the operator can grep for it. The counter does NOT reset on failure
(we keep trying on the next write so we don't lose more than N writes
to a recoverable problem like a stuck `.git/index.lock`).

### Concurrency

Multiple subagents can call `write`/`append`/`patch`/`move` simultaneously.
A single module-level Promise mutex serializes the auto-commit attempts:
only one `git add && git commit` runs at a time, queued attempts coalesce
(if a commit just ran and the counter is back to 0, the next holder
re-checks and exits without committing). The mutex does NOT serialize
the actual file mutations — those keep their existing `atomicWrite`
semantics and run in parallel.

### Commit message format

```
auto: N memory writes
```

Where N is the count that triggered this commit (typically 10, but the
startup-flush variant uses `auto: startup flush (uncommitted from
previous session)`). Prefix `auto:` makes them grep-distinguishable from
human/skill commits in `git log --oneline`. No author override — uses
whatever git identity the memory store's repo is configured with (the
existing `git.ts` already assumes one exists).

### Test surface

Vitest in `server/test/memory/`. The existing `store.test.ts` already
does `git init` in a tmp dir for its `health and git operations` test —
the same scaffolding works for auto-commit tests.

A new file `auto-commit.test.ts` covers:

1. After N-1 writes, no commit yet.
2. The Nth write triggers a commit with the expected message.
3. Counter resets — the next N-1 writes don't commit.
4. `append` and `patch` and `move` all bump the counter too.
5. Startup flush: pre-existing dirty file + first write → two commits
   in log (the flush, then nothing yet because counter is 1).
6. Commit failure (no git repo at all) → write still succeeds, warning
   logged, next write tries again.
7. Concurrent burst of N writes → exactly one commit (mutex coalesces).

## Knob and constant placement

- `AUTO_COMMIT_EVERY = 10` — exported const in `auto-commit.ts`, easy to
  edit when we tune. No env-var override yet; YAGNI.
- All other behavior is constants in the same file.

## Rollout

One PR, gated, merged on green. No feature flag — the write surface
already exists; adding a commit cadence to it is observable through
`git log` but is otherwise invisible to callers.

## Telemetry / observability

- `git log --oneline | grep '^[0-9a-f]\+ auto:'` shows the cadence
- Warnings go to ytsejam's stderr (operator-visible via journalctl on
  the prod service).
- No dedicated metric — the existing `health` RPC's `last_commit` already
  shows when the last commit happened.

## Risks accepted

- **In-process counter is per-process.** Restarting ytsejam during a
  burst loses up to N-1 uncommitted writes from THIS session before the
  startup flush runs. Mitigated by N=10 small + startup flush.
- **No idle-time cadence.** A long session with <N writes between
  housekeeping passes still has a small dirty tree. Acceptable — N=10
  is small, and the next housekeeping pass cleans it.
- **Commit storms during bulk reflect/housekeeping.** A consolidation
  that does 100 patches would emit 10 auto-commits. Fine — they all
  prefix with `auto:` and housekeeping can interactive-rebase if it
  cares.
