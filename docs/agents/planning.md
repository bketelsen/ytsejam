# Planning — Project Lessons

Lessons learned from failures and fix cycles.
Auto-appended by the lessons skill.

## Grep Live Source At Brief Time

Plan and brief enumerations of external sources of truth such as the installed skill set, filesystem layout, entity lists, and frontmatter schemas age fast, because the plan is often written hours or days before the brief that cites it and the live source has since moved. Always grep the live source when writing the brief and never copy from memory or from a design doc authored at brainstorm time. In this run the plan listed the retired `cog-memory-service` and omitted the installed `pkb-research`, and stale wiki frontmatter fields had to be corrected mid-implementation. Treat any literal reference to external state as a value to re-fetch, not a constant.

_Added: 2026-06-13 | Task: Task 2 plan correction — installed skill set divergen_

## Grep The Whole Repo Before Scoping Fixes

When a brief specifies a fix for a pattern bug, run `git grep '<bug pattern>'` across the entire repo before scoping it, and enumerate every site in the brief. Scoping only to where the symptom appeared misses symmetric copies in design docs, plan docs, examples, and code, so the same bug resurfaces in a forward-pointing file a few commits later. Do the grep before writing the fix scope, not after, so the brief names all the affected locations up front. Forward-pointing files are the most dangerous because the regression reappears once that file is acted on.

_Added: 2026-06-13 | Task: Task 1 plan correction — anchor convention symmetric _

## Verify Forward Anchors Against Plan Headings

When a brief invents an anchor to a doc that does not exist yet, look up the section's anchor in the plan doc and cite the future heading's exact text, because neither the spec nor quality review can check a link whose target file is absent. Do not compose forward-anchors from section numbers plus topic words, since a guessed anchor breaks silently and stays broken if the target heading is later written with different wording. The plan is the spec, so verify against its canonical heading text rather than approximating. Every forward-anchor in a brief must quote the heading it points to.

_Added: 2026-06-13 | Task: Task 3 quality fix — §3.3 forward-anchor to MEMORY §_

## Plan-Doc Shape Errors Hide Behind Correct Vocabulary

Plan-doc snippets describing target function shapes go stale fast when the codebase evolves between brainstorm and dispatch — and the staleness is invisible because the vocabulary (function names, parameter names) stays right while the architectural shape underneath (return type, dependency surface, namespace structure) silently shifts. Tasks 3-8 of PR #96 every single one surfaced this: the plan-doc said `mirrorToLtm` returns `Promise<{ok}>` while the live shape was `Promise<{ok, error}>`; said `memory.recordObservation` is a class method while it's actually a namespace export; said `LTM.retrieve` returns `{episodic}` while it returns `{items, profile}`. BRIEF-AUTHOR pre-check: before every dispatch, `git show HEAD:<file>` + `grep -nE '<symbol>'` against each function/type the brief cites; diff the live shape vs the plan snippet; flag divergences INLINE in the brief so the implementer knows the plan is the spec but the SHAPE comes from HEAD. This rule should be in EVERY implementer brief explicitly, not assumed.

_Added: 2026-06-13 | Task: Tasks 3-8 of PR 1 of the cog-LTM bridge roadmap_

## Plan-Doc Scope Errors Are A Separate Category From Shape Errors

Beyond "the shape is stale" (the symbols still exist but with different signatures), plan-docs also carry SCOPE errors where an architectural assumption is wrong: Task 5's plan said "migrate multiple call sites of `append-to-observations.md`" but there was only ONE call site; Task 8's plan said "extend the existing CLI subcommand" but there was no CLI surface at all — the entire arg-interception layer had to be invented. These errors don't show up in a snippet-vs-HEAD diff because the snippet references files that simply aren't there yet (or are there but not what the plan assumed). Mitigation: in the BRIEF-AUTHOR pre-check, also `grep -rE` for the load-bearing nouns of the plan ("CLI", "call sites of cog_append", "existing reconciler") and verify presence + count BEFORE trusting the plan's scope language. If a plan says "extend X" without HEAD evidence X exists, the brief must say "X does not exist yet; implementer should invent the smallest X that satisfies Y."

_Added: 2026-06-13 | Task: Tasks 5, 8 of PR 1 of the cog-LTM bridge roadmap_

## Reviewer Time-Budget Protocol For Grep-Verifiable Tasks

For implementer tasks whose verification is largely structural (file presence, import paths, return types, argv routing) — i.e. resolvable via `git show`, `grep -nE`, `sed -n` rather than running test suites — give spec and quality reviewers a HARD wall-time budget (8 min is plenty) AND a grep-driven checklist that tells them which commands to run before reaching for vitest. Without the budget, opinionated reviewers (especially Opus-class) burn hours doing empirical mutation tests they invented themselves (Task 8's first reviewer ran 4.9h before cancel). Reserve full empirical runs for behaviorally complex tasks (concurrency, atomicity, lifecycle). The checklist should name the exact ONE-SHOT commands: `git show HEAD:server/src/cli/dispatch.ts | sed -n '40,60p'` not "verify dispatch routing".

_Added: 2026-06-13 | Task: Task 8 of PR 1 of the cog-LTM bridge roadmap_

## Pre-Flag Accepted Deviations To Spec Reviewers

When the implementer deviates from the plan for a known-good reason (e.g. plan said "encouraged not required" and the implementer chose required; plan named a type that needed adjustment), pre-flag those deviations to the spec reviewer as ACCEPTED in the review brief so the reviewer doesn't spuriously flag them as bugs. Task 6's reviewer flagged a merged lifecycle test as a deviation when it was a planned consolidation; Task 8's reviewer flagged a spy-type adjustment that was necessary for the mock interface. Format: "Implementer also did X (deviation from plan §Y) — accepted, do not flag." Saves a review round trip and keeps the reviewer focused on real issues.

_Added: 2026-06-13 | Task: Tasks 6, 8 of PR 1 of the cog-LTM bridge roadmap_
