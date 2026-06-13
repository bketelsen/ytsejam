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
| `not mergeable: head branch not up to date` | `gh pr update-branch <N>`, wait for CI |
| `base branch policy prohibits merge` | CI still running — wait for the gate checks to complete |
| `enablePullRequestAutoMerge` error | Drop `--auto`; merge directly once green |
| Gate fails on `node_modules not found` | Check the symlink: `ln -s <repo-root>/node_modules /tmp/<branch>/node_modules` |
| Subagent times out before the gate finishes | The gate includes a Vite build — it needs several minutes. With the 25-min task timeout this is usually fine; for a heavy issue, keep the fix small or split "do the work" and "gate + PR" into two dispatches. |
| Tests hang after extracting a module | If the suite uses per-test module isolation with mocks, only extract files with NO mocked imports and NO module-level state (pure helpers/constants/types). Files importing mocked deps must stay put. |
