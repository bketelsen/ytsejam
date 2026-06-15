# pull-weeds — Fix Brief Reference

## Per-issue dispatch template

Basis for each `delegate` call (one per weed issue). Customize per issue.

```
delegate({
  label: "Pull weed #NNN",
  model: "github-copilot/gpt-5.5",
  task: """
Fix GitHub weed issue #NNN in the <project> repo. You are a careful engineer making a SMALL,
SAFE fix — no structural or behavioral change. You cannot delegate further; do the whole fix
yourself and report.

## Issue
<paste the issue title + body — enough context to work without re-fetching>

## Steps
1. Worktree off main:
   cd <repo-root>
   git worktree add /tmp/<branch-name> -b <branch-name>
   cd /tmp/<branch-name>
   ln -s <repo-root>/node_modules ./node_modules           # if Node project
   ln -s <repo-root>/web/node_modules ./web/node_modules    # if a web subpackage exists
2. <Specific work steps — read the issue body; be explicit. Keep it small + in-scope.>
3. Verify the change is complete (grep / diff / a quick check).
4. Run the gate: `bash scripts/gate.sh` (else the project's `quality gate:` command).
   The gate MUST exit 0. If a frontend build is part of it, allow several minutes.
   Do NOT open a PR on a failed or timed-out gate — fix and re-run until green.
5. Commit an early WIP checkpoint once it compiles, then the final commit (commit BEFORE you report):
   git add -A && git commit -m "<type>: <description>

   Closes #NNN

   Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
6. Push + PR:
   git push -u origin <branch-name>
   gh pr create --title "<type>: <description>" --body "Closes #NNN" --base main

## Rules
- Gate MUST pass before the PR. One PR, Closes #NNN.
- Do NOT touch files outside this issue's scope.
- If the fix turns out to require a structural/behavioral change, STOP and report that —
  it's not a weed; do not force it.

## Report
Lead with what you changed + the gate result + the PR URL. Then end with:
## Blockers
- <anything that stopped you, or "none">
"""
})
```

## Branch naming

| Issue type | Prefix |
|---|---|
| Bug fix | `fix/` |
| Docs | `docs/` |
| Chore / cleanup / refactor-in-the-small | `chore/` |
| Test addition | `test/` |

## Dependency serialization

Two issues touching the same files: dispatch the first; when its PR **merges**, dispatch the
second from fresh `origin/main` ("PR #NNN just merged — start from fresh main"). Never dispatch a
dependent before its dependency merges — worktrees diverge into rebase conflicts.

## Rebase-before-merge gate (Phase 2.5)

Every PR after the first in a multi-weed burst has a stale base the moment its predecessor merges.
The skill's Phase 2.5 is the iron law: rebase locally + re-run the local gate + force-push, then
wait for CI green. **`gh pr update-branch <N>` does not count** — it does a server-side rebase but
doesn't re-run the local gate against the new main, and a rebase can introduce silent conflicts
that compile but fail tests.

Sequence per stale-base PR:

```bash
cd /tmp/<branch>
git fetch origin main
git rebase origin/main
# resolve conflicts if any — non-trivial conflict = the fix crossed scope, stop and escalate
bash scripts/gate.sh
# DO NOT force-push if the local gate failed — fix it first
git push --force-with-lease
# wait for CI green on the force-push, then merge
```

Doc-only PRs (no code in the diff) MAY use `gh pr update-branch <N>` as a shortcut — no test
surface to invalidate. Anything else: local gate.

## CI polling

```bash
for i in $(seq 1 20); do
  state=$(gh pr view <N> --json statusCheckRollup --jq '[.statusCheckRollup[]|"\(.name):\(.conclusion)"]|join(", ")')
  echo "$(date +%H:%M:%S) #<N>: $state"
  echo "$state" | grep -q "SUCCESS\|FAILURE" && break
  sleep 30
done
```

## Common failure modes

| Error | Fix |
|---|---|
| `not mergeable: head branch not up to date` | Run Phase 2.5 (local rebase + re-gate + force-push) — NOT just `gh pr update-branch` |
| `base branch policy prohibits merge` | CI still running — wait for the gate checks to complete |
| `enablePullRequestAutoMerge` error | Drop `--auto`; merge directly once green |
| Gate fails on `node_modules not found` | Check the symlink: `ln -s <repo-root>/node_modules /tmp/<branch>/node_modules` |
| Subagent times out before the gate finishes | The gate includes a Vite build — it needs several minutes. With the 25-min task timeout this is usually fine; for a heavy issue, keep the fix small or split "do the work" and "gate + PR" into two dispatches. |
| Tests hang after extracting a module | If the suite uses per-test module isolation with mocks, only extract files with NO mocked imports and NO module-level state (pure helpers/constants/types). Files importing mocked deps must stay put. |
| `cannot delete branch used by worktree` after `gh pr merge --delete-branch` | The merge + remote-branch-delete still succeeded. After the PR is merged: `cd <repo-root> && git worktree remove /tmp/<branch> --force && git branch -D <branch>`. |
