---
name: develop
description: Use when executing an implementation plan — delegates each task to a fresh implementer subagent with two-stage review (spec compliance, then code quality) after each.
triggers: [develop, execute plan, implement plan, run the plan, dev loop, task loop]
---

# Subagent-Driven Development

Execute a plan by delegating each task to a fresh implementer subagent, with a two-stage
review after each task: spec compliance first, then code quality.

**Core principle:** Fresh implementer delegation per task + two-stage review (spec then quality) = high quality, fast iteration.

**Announce at start:** "I'm using the develop skill to execute this plan."

## Delegation model (ytsejam)

- YOU (the main agent) orchestrate the whole loop by calling `delegate` repeatedly. There are
  NO named agents — each subagent's role is defined entirely by the prompt body (see the
  templates in this directory).
- **Subagents CANNOT delegate further.** The implementer never dispatches a reviewer; only you
  do. Spec review and quality review are separate `delegate` calls YOU make after the
  implementer reports.
- Pick the model per call via `model: "provider/modelId"`. Defaults for this suite:
  implementer/coding = `github-copilot/gpt-5.5`; reviewers = `github-copilot/claude-opus-4.8`
  (a different family from the implementer, by design). Override per task if needed.

## When to Use

- You have an implementation plan in the repo at `docs/plans/<YYYY-MM-DD-slug>.md`.
- Tasks are mostly independent.
- You're staying in this session.

If tasks are tightly coupled or you need human checkpoints between batches, run in a fresh
session per batch (this skill still applies).

## The Process

### Setup

1. Read the plan once from `docs/plans/<...>.md` — extract ALL tasks with their full text
   upfront. Do NOT make the implementer read the plan file; you paste each task's full text
   into its delegate prompt.
2. Note the worktree path + branch. Convention: an isolated worktree under `/tmp/<branch>`,
   branch off `main`. Create it: `git worktree add /tmp/<branch> -b <branch>` (and, for a Node
   project, symlink node_modules: `ln -s <repo-root>/node_modules /tmp/<branch>/node_modules`).
3. Record the spec location — it's the plan/design doc in `docs/plans/`; reviewers will read it.
4. Create a todo list of all tasks.

### Per-Task Loop

For each task:

```
1. BASE_SHA = `git -C /tmp/<branch> rev-parse HEAD`

1.5. PRIOR LESSONS PRELOAD (cheap, ≤10s):
     Identify the task's likely theme(s) from the task text — e.g. "test", "auth", "build",
     "deploy", "ltm", "memory" — and `grep -l "^## " docs/agents/*.md` to find which theme
     files exist. For each candidate theme, `cat docs/agents/<theme>.md` and extract any
     entry whose TITLE mentions a noun appearing in the task description (subagent
     parser, dedup hash, mutex, parser, etc.). Pass the matching entries verbatim into the
     implementer's `## Context` section under a `### Prior lessons that may apply` heading.
     If nothing matches, write `### Prior lessons that may apply: none found`. This is the
     READ-side of the lessons skill — without it, the WRITE side is sediment.

2. Delegate to a fresh implementer (you call `delegate`):
   → See implementer-prompt.md for the template.
   → Provide: full task text, scene-setting context (including the prior-lessons preload
     from step 1.5), the worktree path.
   → The implementer commits-before-report and ends its report with the structured tail
     (## Decisions / ## Patterns Discovered / ## Surprises / ## Blockers / ## Context for Continuation).
     Note: `## Surprises` replaces the old `## Lessons` — implementers report factual oddities,
     not pre-cooked advice. Synthesis into rules is the `lessons` skill's job, not the implementer's.

3. Implementer reports back. HEAD_SHA = `git -C /tmp/<branch> rev-parse HEAD`.
   Independently verify the branch actually advanced: `git -C /tmp/<branch> log BASE_SHA..HEAD_SHA --oneline`
   (a narrated change with no commit is NOT done — re-dispatch if empty).

4. Dispatch the SPEC COMPLIANCE reviewer (you call `delegate`):
   → See spec-reviewer-prompt.md. Pass BASE_SHA/HEAD_SHA, worktree, the spec path, the task text,
     and the implementer's report verbatim. Reviewer reads ACTUAL CODE, not the report.
   → ❌ Issues? Delegate a fix back to a fresh implementer with the specific issue list.
     Re-run the SAME spec reviewer. Repeat until ✅.
   → ✅ Spec compliant? Proceed to step 5.

5. Dispatch the CODE QUALITY reviewer (you call `delegate`):
   → See quality-reviewer-prompt.md. Same inputs.
   → ❌ Critical/Important issues? Delegate a fix, re-run the SAME quality reviewer. Repeat until ✅.
   → ✅ Approved? Mark task complete.

6. Gate (REQUIRED before declaring the task done):
   Run `bash scripts/gate.sh` from the repo root if it exists; else read
   `projects/<slug>/hot-memory.md` for a `quality gate:` line and run that.
   Must exit 0. If it fails: delegate a fix, re-run, repeat until green. If no gate exists, note the absence.

7. Mark the task complete in the todo list.

7.5 Blockers check:
    Read the implementer's report `## Blockers` section. If non-empty, surface each before the
    next task: "Resolve or acknowledge before continuing?" Options: (1) file as a GitHub issue
    (`gh issue create`) and continue, (2) note and continue, (3) stop and investigate.

8. Lesson capture (fix cycles only):
   If a fix cycle occurred this task — spec or quality reviewer ran more than once, OR the gate
   required a fix commit — invoke the `lessons` skill with: the reviewer feedback that triggered
   the fix, the fix diff, the task description. Wait for the user's yes/edit/skip before the next task.
   If no fix cycle occurred, skip this step.
```

**CRITICAL ORDER:** Spec compliance MUST pass before code quality review begins. Never reverse this.

### After All Tasks

1. Dispatch a final code reviewer across the entire implementation (all commits since branch start):
   `git -C /tmp/<branch> log main..HEAD --oneline` + `git diff main..HEAD`. Look for anything that
   slipped through per-task review.
2. If the final reviewer raises Critical issues: fix before proceeding.
3. Invoke the `ship` skill.

## Prompt Templates

The templates in this directory define what each role checks for — read the relevant one before
each `delegate` call; they're not just docs.
- `implementer-prompt.md` — dispatch a fresh implementer
- `spec-reviewer-prompt.md` — dispatch the spec compliance reviewer
- `quality-reviewer-prompt.md` — dispatch the code quality reviewer

## Example Workflow

```
[Read plan from docs/plans/ — extract all 4 tasks with full text]
[git worktree add /tmp/feat-config -b feat/config; symlink node_modules]
[Create todo list: Task 1, 2, 3, 4]

--- Task 1: Add config parser ---
BASE_SHA: a1b2c3d
[delegate → implementer with full task text + context + worktree path]
  implementer: "Before I begin — TOML or JSON?" → (it makes a reasonable assumption + notes it, since it's one-shot)
  implementer: [TDD, 6/6 tests pass, WIP commit then final commit, self-review, reports with structured tail]
HEAD_SHA: e4f5g6h   [verify: git log BASE..HEAD shows the commits]
[delegate → spec reviewer]  ✅ Spec compliant — all requirements met, nothing extra.
[delegate → quality reviewer]  Minor: magic string "config.toml" → suggest constant.
[delegate → fix]  implementer extracts constant, recommits.
[re-run same quality reviewer]  ✅ Approved.
[bash scripts/gate.sh → exit 0]
[Mark Task 1 complete]
--- Task 2: ... ---
```

## Red Flags

**Never:**
- Start implementation on main/master without explicit user consent (always a `/tmp/<branch>` worktree off main).
- Skip spec compliance review (even if the implementer seems confident).
- Skip code quality review.
- Start code quality review before spec compliance is ✅.
- Make the implementer read the plan file — paste full task text into the prompt.
- Tell the implementer subagent to dispatch a reviewer — it CANNOT delegate; only you do.
- Trust a report without verifying the branch advanced (`git log BASE..HEAD`).
- Proceed to the next task while either review has open issues.
- Let the implementer's self-review replace the actual review passes — both are needed.

**If the implementer reports questions/assumptions:** address them; if material, delegate a corrected task.
**If a reviewer finds issues:** delegate a fix; re-run the SAME reviewer; repeat until approved.
**If a task fails badly:** delegate a fresh fix with specific instructions — don't hand-patch (context pollution).

## Integration

**Requires:** `write-plan` (creates the plan this skill executes).
**Invokes:** `lessons` (after any task with a fix cycle), `ship` (after all tasks + final review pass).
