---
name: review
description: Use to run a two-pass code review — spec compliance first, then code quality. Called by the develop skill after each task; can also be invoked manually before merging.
triggers: [review, code review, spec review, two-stage review, quality review]
---

# Requesting Code Review

Dispatch two sequential review subagents to catch issues before they cascade. The MAIN agent
makes the `delegate` calls (subagents cannot delegate further).

**Core principle:** Review early, review often. Spec compliance before code quality — always.

## When to Use

**Mandatory (called by the `develop` skill):**
- After each task in subagent-driven development
- Order is enforced: spec compliance ✅ before code quality begins

**Optional but valuable:**
- Before merging to main (final sanity check)
- When stuck — fresh perspective
- After fixing a complex bug

## How to Run

### Step 1: Gather Context

```bash
# Get the commit range (run against the /tmp worktree)
BASE_SHA=$(git -C /tmp/<branch> rev-parse HEAD~1)   # or the SHA before the task started
HEAD_SHA=$(git -C /tmp/<branch> rev-parse HEAD)
```

You need:
- What was implemented (from the implementer's report)
- The task requirements (from the plan)
- The spec — it lives in the repo at `docs/plans/<...>.md` (the plan/design doc); reviewers read it
- BASE_SHA and HEAD_SHA

### Step 2: Spec Compliance Review

Dispatch using the template at `develop/spec-reviewer-prompt.md` (a `delegate` call with the
reviewer role in the prompt body; model `github-copilot/claude-opus-4.8`).

Fill in:
- Full task requirements text
- The implementer's report (verbatim)
- Working directory (the `/tmp/<branch>` worktree path)
- BASE_SHA / HEAD_SHA
- The spec path in `docs/plans/`

**Act on results:**
- ✅ Spec compliant → proceed to Step 3
- ❌ Issues found → delegate fixes to a fresh implementer with the specific issue list → re-dispatch the SAME spec reviewer → repeat until ✅

### Step 3: Code Quality Review

**Only after Step 2 returns ✅.**

Dispatch using the template at `develop/quality-reviewer-prompt.md` (model `github-copilot/claude-opus-4.8`).

Fill in:
- What was implemented
- Task requirements (for intent context)
- Working directory
- BASE_SHA / HEAD_SHA

**Act on results:**
- ✅ Approved → task is complete
- ❌ Critical issues → delegate fixes → re-dispatch the SAME quality reviewer → repeat until ✅
- ❌ Important issues → delegate fixes → re-dispatch → repeat until ✅
- Minor issues → note them, continue (fix at convenience)

## Issue Severity

| Severity | Action |
|---|---|
| Critical | Fix immediately. Block all progress. |
| Important | Fix before next task. Re-review. |
| Minor | Note. Continue. Fix when convenient. |

## Example

```
[Task 2 complete. Implementer reports: "Added verify/repair functions, 8/8 tests passing."]

BASE_SHA: a7981ec
HEAD_SHA: 3df7661

[Dispatch spec compliance reviewer]
Spec reviewer: ❌ Issues:
  - Missing: progress reporting every 100 items (spec requires it)
  - Extra: added --json flag (not in spec)

[Delegate a fix to a fresh implementer: remove --json, add progress reporting]
  implementer: [fixes, recommits]
HEAD_SHA: 9k2m3n4

[Dispatch the SAME spec compliance reviewer again]
Spec reviewer: ✅ Spec compliant.

[Dispatch quality reviewer]
Quality reviewer:
  Strengths: clean separation, real tests
  Issues (Important): magic number 100 — extract as PROGRESS_INTERVAL constant

[Delegate a fix: extract constant]
  implementer: [fixes, recommits]

[Dispatch the SAME quality reviewer again]
Quality reviewer: ✅ Approved.

[Task 2 complete.]
```

## Red Flags

**Never:**
- Start code quality review before spec compliance is ✅
- Skip review because "it's a simple task"
- Ignore Critical issues
- Proceed to the next task with unresolved Important issues
- Use a different reviewer for re-review — same reviewer (a fresh `delegate` call with the same prompt + context), so it judges its own prior feedback

**If a reviewer seems wrong:**
- Push back with specific code references
- Ask for clarification on the concern
- If the reviewer was wrong, acknowledge and move on

## Integration

**Called by:** `develop` (per-task, after the implementer reports). **Shares assets with:** `develop` (the two reviewer prompt templates live there). **Can be invoked manually** before a merge.
