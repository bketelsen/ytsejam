# advance:yolo auto-update-behind — Design

**Status:** approved (Brian, 2026-06-18)
**Branch:** `fix/phase-yolo-auto-update-behind`
**Scope:** `contrib/skills/bottega/scripts/{phase-lib.sh,bottega-api.sh}` + a bash regression test. Bash wrapper only — no server/web code.

## Problem

The Bottega phase orchestrator (`advance:yolo`, driven by `phase_gate` in `phase-lib.sh`) falsely parks
green, mergeable PRs and cannot carry a PR that is behind `main` to merge. Three distinct defects, one class
("treat a transient/recoverable state as a terminal park"):

1. **CI bucket mismatch.** `_phase_pr_meta_live` reads `.ciStatus.status`, which Bottega returns as the
   *past-tense rollup* `"passed"`. The gate at `phase-lib.sh:198` tests `[ "$ci" = "pass" ]`. `"passed"` ≠
   `"pass"` → every green PR parks as `park:ci-passed`. The stable field is the per-check
   `.ciStatus.checks[].bucket` (`'pass' | 'fail' | 'pending' | 'skipping' | ...`), confirmed in Bottega
   source `server/services/worktree.ts` (`CICheck.bucket`).

2. **No auto-update of behind branches.** `main` branch protection has `strict: true` (require branches up to
   date before merging; required check `gate`) — confirmed via
   `gh api repos/bketelsen/ytsejam/branches/main/protection`. GitHub therefore *refuses* to merge a PR that is
   `BEHIND`. Bottega's `merge-cleanup` is `gh pr merge --merge` (`worktree.ts:480`), so a behind PR fails the
   merge. The orchestrator has no step that brings a behind branch up to date; today this only works because a
   human clicks Bottega's "pull" then "push" buttons by hand (proven: the 6 weed PRs of 2026-06-17 each had to
   be synced manually before they would merge).

3. **`no-pr` is terminal.** `phase-lib.sh:184` parks `park:no-pr` the first time a task has no PR yet. But
   Bottega registers the PR a few seconds *after* task create, so a gate poll in that window parks a task that
   is moments from having a PR — and the park is terminal, so it never re-polls. (Confirmed as a state-tracking
   race in the 2026-06-17 run: 4 tasks parked `no-pr` then had clean PRs seconds later.)

## Decision: detect BEHIND with `gh` (read-only), fix it with Bottega's pull+push (mutating)

Bottega exposes a **pull/push pair**, read from source:

- **pull** = `POST /api/tasks/:id/sync` → `syncWithMain` (`worktree.ts:320`): `git fetch origin` +
  `git merge origin/<main>` into the worktree. Pull-only, no push.
- **push** = `POST /api/tasks/:id/push-changes` → `pushChanges` (`worktree.ts:597`): `git status --porcelain`;
  if dirty `git add -A` + `git commit -m <msg>`; then `git push origin <branch>`. Idempotent (treats
  "Everything up-to-date"/"nothing to commit" as success). `commitMessage` body field is optional.

Brian's two manual clicks = `sync` then `push-changes`, exactly.

**Detection problem:** Bottega's `/pull-request` does **not** expose `mergeStateStatus` (its
`PullRequestStatusResult` has only `success/exists/url/state/mergeable/ciStatus/error`; the underlying
`gh pr view` requests only `url,state,mergeable` — `worktree.ts:414`). So BEHIND cannot be detected from the
Bottega API. It must come from a direct `gh pr view <n> --json mergeStateStatus` against the repo (the
orchestrator container already has `gh` + auth — that is how `_phase_pr_branch_live` works).

**Chosen split (Option A):**
- **Detect** BEHIND via read-only `gh pr view --json mergeStateStatus` — no state change.
- **Fix** via Bottega `sync` → `push-changes` — keeps the worktree and the remote PR ref in lockstep, which
  matters because `merge-cleanup` merges from that same worktree.

**Rejected — Option B (`gh api PUT .../update-branch`):** merges base→head *on the remote only*, leaving
Bottega's worktree stale until `merge-cleanup` rebuilds it. Simpler (one tool) but re-introduces worktree/remote
divergence we deliberately removed by choosing Bottega's pair. `update-branch` would also need its own re-gate
under `strict:true` anyway, so it buys nothing over Option A.

## Behavior after the fix

In `phase_gate`, after green + mergeable checks pass:

```
mss = gh pr view <n> --json mergeStateStatus        # read-only
if mss == BEHIND:
    if attempts(tid) >= MAX_UPDATE_ATTEMPTS (3):
        park:stuck-behind                            # terminal; converged-or-give-up
    else:
        increment attempts(tid)
        POST /api/tasks/<tid>/sync                   # fetch + merge main into worktree
        POST /api/tasks/<tid>/push-changes           # push merge commit to PR branch
        park:behind-updating                         # NON-terminal: re-gates next tick
        # CI re-runs on the new head; next tick re-checks mss
elif mss in (CONFLICTING, DIRTY):
    park:merge-conflict                              # genuine human-needed conflict; terminal
# else (CLEAN/BLOCKED/UNKNOWN/HAS_HOOKS/etc) → proceed to existing stale-base + container gate + pass
```

`MAX_UPDATE_ATTEMPTS = 3` caps the converge loop: when several PRs in a batch merge sequentially, the trailing
ones go behind again and re-update, costing CI cycles. Three attempts bounds it; on exhaustion the task parks
terminally as `stuck-behind` rather than looping forever.

### CI bucket fix (defect 1)

`_phase_pr_meta_live` computes `ci` by rolling up the per-check buckets instead of reading `.status`:

```
ci = (.ciStatus.checks // []) as $c
   | if   ($c|length)==0           then "none"
     elif any($c[]; .bucket=="fail")    then "fail"
     elif any($c[]; .bucket=="pending") then "pending"
     elif all($c[]; .bucket=="pass")    then "pass"
     else "unknown" end
```

The existing `[ "$ci" = "pass" ]` at `phase-lib.sh:198` then works unchanged.

### no-pr backoff (defect 3)

`park:no-pr` becomes non-terminal with a bounded poll. Track a per-task `no-pr` attempt counter in the phase
state; re-poll up to `MAX_NOPR_ATTEMPTS = 3` ticks before parking terminally as `no-pr-timeout`. This closes the
create→PR-registration race without an unbounded wait.

## Attempt-counter storage

Attempts live in the phase state JSON (`$HOME/.bottega/phases/<phase>.json`) under a per-task map, e.g.
`tasks[tid].update_attempts` and `tasks[tid].nopr_attempts`. Reset to 0 when the task leaves the
behind/no-pr state (reaches `pass` or a terminal park). The phase tick already reads/writes this file, so the
counters travel with existing state I/O — no new persistence mechanism.

## Test strategy

Bash-only regression test (matching #251's existing `scripts/test/bottega-api.test.sh` harness), driven by
stubbing `gh`, `curl`, and the phase-state file. Assert:
- CI rollup: checks `[pass,pass]` → `ci=pass`; `[pass,fail]` → `ci=fail`; `[pass,pending]` → `pending`; `[]` → `none`.
- BEHIND path fires `sync` then `push-changes` (capture POST URLs) and parks `behind-updating`, increments the counter.
- BEHIND with counter at MAX → parks `stuck-behind`, fires neither POST.
- CONFLICTING → parks `merge-conflict`, fires neither POST.
- CLEAN → proceeds (no sync/push), reaches the existing downstream checks.
- no-pr first/second tick → `no-pr` (non-terminal) with counter bump; at MAX → `no-pr-timeout`.

The phase functions are already dependency-injectable via `PHASE_PR_META_FN` / `PHASE_STALE_BASE_FN` /
`PHASE_CONTAINER_GATE_FN` overrides — the test sets these plus a `PHASE_PR_BEHIND_FN` (new injection seam for
the `gh mergeStateStatus` read) so no real network/gh is touched.

## Out of scope

- GitHub merge queue (would obviate sequential re-behind churn but is a repo-settings change, not orchestrator code).
- Syncing the live runtime copy (`~/.ytsejam/data/skills/bottega/`) from the repo — done as a post-merge step,
  separately, and noted to also carry #251's already-merged `doc-set` byte-count fix (live copy currently lags).

## Rollback

Single squash PR; revert with `gh pr revert <n>`. The live runtime copy is only synced *after* merge, as a
deliberate manual step, so an unmerged or reverted PR never touches the running orchestrator.
