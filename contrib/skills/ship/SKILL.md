---
name: ship
description: Use when implementation is complete and all tasks are done — verifies the gate, routes the per-task report tails to memory, presents merge/PR/keep/discard options, cleans up the worktree, updates CHANGELOG + the project's cog wiki/dev-log.
triggers: [ship, ship it, finish branch, complete, wrap up, finish the work]
---

# Finishing a Development Branch

Guide completion of development work: verify the gate → route the per-task report tails →
present options → execute choice → clean up → record what shipped.

**Core principle:** Verify gate → Route consequences → Present options → Execute → Clean up → Record.

**Announce at start:** "I'm using the ship skill to complete this work."

## Step 1: Run the Gate

Run the project's gate before presenting any options.

Run `bash scripts/gate.sh` from the repo root if it exists. If there's no `scripts/gate.sh`,
read `projects/<slug>/hot-memory.md` for a `quality gate:` line and run that; if neither
exists, run whatever quality checks make sense and document what you ran.

**If the gate fails:**
```
Gate failed. Must fix before shipping:

[output]

Cannot proceed until the gate passes.
```
Stop. Do not proceed to Step 2 until the gate passes.

**If the gate passes:** Continue.

## Step 2: Route the Per-Task Consequences

In this suite, each task's consequences arrive as the structured TAIL of that task's
implementer report (`## Decisions / ## Patterns Discovered / ## Lessons / ## Blockers /
## Context for Continuation`) — the `develop` skill collected these across the per-task loop.
There are no on-disk manifest files. Gather the tails you collected during `develop` (or, if
shipping a branch you didn't just develop, ask the user for them / reconstruct from `git log`).

### Collect scope:global decisions first

Scan all the `## Decisions` tails for `scope: global` entries. If any exist, present them as a
single numbered review list and ask for per-entry confirmation BEFORE any writes:

```text
scope:global decisions found — these will be written to cog-meta/patterns.md (the always-loaded
tier). Review each:

  1. "Pattern text here"
  2. "Another pattern"

Write all? Or specify numbers to skip (e.g. "skip 2"):
```

Complete this before presenting ship options.

### Route each section (per the storage model)

**Decisions:**
- `scope: project` → durable project narrative: `cog_append`/`cog_write` to the cog wiki at
  `wiki/projects/<slug>/decisions.md` (a `- YYYY-MM-DD: <decision>` line).
- `scope: global` → confirmed entries → `cog_patch("cog-meta/patterns.md", ...)` (in-place; keep
  the 70-line / 5.5KB cap in mind — patterns.md is injected every turn).
- `scope: session` or absent → `cog_append("projects/<slug>/observations.md", "- YYYY-MM-DD [insight]: ...")`.

**Patterns Discovered:** all → `cog_append("projects/<slug>/observations.md", "- YYYY-MM-DD [insight]: ...")`.

**Lessons:** collect all lesson entries across all tails into one list. If non-empty, ask:
`Lessons collected. Invoke the lessons skill for these? [yes/skip]`. On yes, invoke the
`lessons` skill with the collected lessons as input.

**Blockers:**
- `scope: project` → display, ask per-blocker `File as GitHub issue? [yes/skip]`; on yes
  `gh issue create --title "<blocker>" --body "Surfaced via a ship consequence tail"`.
- Other → `cog_append("projects/<slug>/observations.md", "...")`.

**Context for Continuation:** collect all such entries, synthesize a brief 3–5 sentence summary
(use `delegate` for synthesis if substantial), and write it as a **rewrite** of
`projects/<slug>/hot-memory.md` (hot-memory is rewrite-only, capped <50 lines).

### Write a session-summary line into the hot-memory rewrite

```text
- YYYY-MM-DD [work, milestone]: Shipped branch <branch>. Tasks: <N>.
  Key decisions: <scope:project decision titles>. Blockers: <unresolved, or "none">.
```

(If the project isn't yet a registered cog domain, tell the user to run `/cog` to add it first,
then do the cog writes — don't silently skip.)

## Step 3: Determine Base Branch

```bash
git -C /tmp/<branch> merge-base HEAD main 2>/dev/null || git -C /tmp/<branch> merge-base HEAD master 2>/dev/null
```
Or ask: "This branch split from main — correct?"

## Step 4: Present Options

Present exactly these 4 options (no extra explanation):

```
Implementation complete. Gate passing.

What would you like to do?

1. Merge back to <base-branch> locally
2. Push and create a Pull Request
3. Keep the branch as-is (I'll handle it later)
4. Discard this work

Which option?
```

## Step 5: Execute Choice

### Option 1: Merge Locally
```bash
git checkout <base-branch> && git pull
git merge <feature-branch>
bash scripts/gate.sh        # re-verify the gate on the merged result
git branch -d <feature-branch>   # only if the gate passed
```
Then: Cleanup (Step 6), CHANGELOG (Step 7), Record (Step 8).

### Option 2: Push and Create PR
```bash
git push -u origin <feature-branch>
gh pr create --title "<feature title>" --body "$(cat <<'EOF'
## Summary
- <what changed>
- <what changed>

## Spec
<link to the repo plan/design doc: docs/plans/<...>.md>

## Test Plan
- [ ] <verification step>
EOF
)"
```
Report the PR URL. Then: Cleanup (Step 6), CHANGELOG (Step 7), Record (Step 8).

### Option 3: Keep As-Is
Report: "Keeping branch `<name>`. Worktree preserved at `/tmp/<branch>`." Do NOT cleanup. Skip to Step 8.

### Option 4: Discard
Require explicit typed confirmation:
```
This will permanently delete:
  Branch: <name>
  Commits: <list commit subjects>
  Worktree: /tmp/<branch>

Type 'discard' to confirm.
```
Wait for the exact word `discard`; anything else aborts. If confirmed:
```bash
git checkout <base-branch> && git branch -D <feature-branch>
```
Then: Cleanup (Step 6). Skip Step 7/8 (nothing shipped).

## Step 6: Cleanup Worktree

**Options 1, 2, 4 only** (not 3):
```bash
git worktree remove /tmp/<branch>
```
(No `_manifests` dir to remove — this suite uses report tails, not manifest files.)

## Step 7: Update CHANGELOG

**Options 1, 2, 3** (not 4): if `CHANGELOG.md` exists at the repo root, add an entry under the
unreleased/current section (match the file's format; group under Added/Fixed/Changed).
- Option 2 (PR): commit the CHANGELOG to the feature branch BEFORE pushing so it's in the PR.
- Option 1 (local merge): add it on the base branch after merging, then commit.
If `CHANGELOG.md` does not exist, skip silently (do not create one).

## Step 8: Record what shipped

**Options 1, 2, 3** (not 4):
- `cog_append("projects/<slug>/dev-log.md", "- YYYY-MM-DD: <feature> — <one sentence>. PR #N / merged to <branch>.")`
- Optionally also add a one-line shipped note to the cog wiki project page (`wiki/projects/<slug>/index.md`) if you maintain one.

## Quick Reference

| Option | Merge | Push | Keep Worktree | Cleanup | CHANGELOG | Record (dev-log) |
|---|---|---|---|---|---|---|
| 1. Merge locally | ✓ | — | — | Step 6 | Step 7 | Step 8 |
| 2. Create PR | — | ✓ | — | Step 6 | Step 7 | Step 8 |
| 3. Keep as-is | — | — | ✓ | — | Step 7 | Step 8 |
| 4. Discard | — | — | — | Step 6 | — | — |

## Red Flags

**Never:**
- Present options before the gate passes
- Merge without re-verifying the gate on the merged result
- Delete work without typed "discard" confirmation
- Force-push without explicit user request
- Write `scope: global` decisions to `cog-meta/patterns.md` without per-entry confirmation
- Skip recording what shipped (Options 1, 2, 3)

**Always:**
- Run the gate before options
- Present exactly 4 options
- Get typed "discard" for Option 4
- Cleanup the worktree for Options 1, 2, 4 only
- Update CHANGELOG.md if it exists (Options 1, 2, 3)

## Integration

**Called by:** `develop` (after all tasks + final review pass).
**Pairs with:** `write-plan` (cleans up the worktree it created).
**Invokes (conditionally):** `lessons` (if lesson tails were collected in Step 2).
**Uses:** `gh` CLI, git.
