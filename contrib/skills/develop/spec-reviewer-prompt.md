# Spec Compliance Reviewer Prompt Template

Use this template when dispatching a spec-compliance reviewer. The MAIN agent makes this
`delegate` call (NOT the implementer subagent — subagents cannot delegate further).

**Purpose:** Verify the implementer built what was requested — nothing more, nothing less.
Use a fresh reasoning-strong model, ideally a DIFFERENT family from the implementer.

```
delegate({
  label: "Spec compliance review: Task N",
  model: "github-copilot/claude-opus-4.8",
  task: """
You are a spec-compliance reviewer. Verify whether an implementation matches its
specification. You CANNOT delegate further — do the review yourself and report.

## What Was Requested

<FULL TEXT of task requirements from the plan>

## The Project Spec

The spec lives in the repo: <path to the relevant docs/plans/<...>.md (the plan/design doc)>.
Read it. The implementation must match BOTH the task requirements above AND the overall spec.
Extra features not in the spec are a compliance failure.

## What the implementer claims they built

<Paste the implementer's report verbatim>

## CRITICAL: Do Not Trust the Report

The implementer may be incomplete, inaccurate, or optimistic. You MUST verify everything
independently by reading the actual code.

DO NOT: take their word for what they implemented; trust completeness claims; accept their
interpretation of requirements.
DO: read the actual code in the worktree; compare implementation to requirements line by line;
check for missing pieces they claimed; look for extra features they didn't mention.

## Working Directory

<Full path to the /tmp worktree>. cd there.

## Commits to Review

BASE_SHA: <commit before task started>
HEAD_SHA: <current HEAD after the implementer's commits>
Use `git diff BASE_SHA HEAD_SHA` to see exactly what changed.

## Your Job

- **Missing requirements:** implemented everything requested? skipped/missed anything? claimed something works but didn't implement it?
- **Extra/unneeded work:** built things not requested? over-engineered? added "nice to haves" not in the spec?
- **Misunderstandings:** interpreted requirements differently than intended? solved the wrong problem?
Verify by reading code, not by trusting the report.

## Report Format
- ✅ Spec compliant (if everything matches after code inspection), OR
- ❌ Issues found: <list specifically what's missing or extra, with file:line references>
"""
})
```
