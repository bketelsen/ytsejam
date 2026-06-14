# Planning — Project Lessons

Rules learned from fix cycles. Cap: 30 entries — prune oldest if exceeded.

## Grep Live Source At Brief Time

Plan and brief enumerations of external sources of truth such as the installed skill set, filesystem layout, entity lists, and frontmatter schemas age fast, because the plan is often written hours or days before the brief that cites it and the live source has since moved. Always grep the live source when writing the brief and never copy from memory or from a design doc authored at brainstorm time. In this run the plan listed the retired `cog-memory-service` and omitted the installed `pkb-research`, and stale wiki frontmatter fields had to be corrected mid-implementation. Treat any literal reference to external state as a value to re-fetch, not a constant.

_Added: 2026-06-13 | Task: Task 2 plan correction — installed skill set divergen_

## Grep The Whole Repo Before Scoping Fixes

When a brief specifies a fix for a pattern bug, run `git grep '<bug pattern>'` across the entire repo before scoping it, and enumerate every site in the brief. Scoping only to where the symptom appeared misses symmetric copies in design docs, plan docs, examples, and code, so the same bug resurfaces in a forward-pointing file a few commits later. Do the grep before writing the fix scope, not after, so the brief names all the affected locations up front. Forward-pointing files are the most dangerous because the regression reappears once that file is acted on.

_Added: 2026-06-13 | Task: Task 1 plan correction — anchor convention symmetric _

## Quote The Target Heading For Every Forward Anchor

Forward-anchors in briefs must quote the heading they point to, never be composed from section numbers + topic words — a guessed anchor breaks silently and stays broken if the target heading is later written with different wording. The plan is the spec, so verify against its canonical heading text rather than approximating.

(seen in: brief composed `#3.3-forward-anchor-to-memory` from section number; target heading used different wording)

_Added: 2026-06-13 | Task: Task 3 quality fix — §3.3 forward-anchor to MEMORY §_

## Plan-Doc Shape And Scope Errors Hide Behind Correct Vocabulary

Plan-doc snippets go stale fast and the staleness is invisible because the vocabulary stays right while the shape underneath shifts — return types, dependency surfaces, namespace exports diverge silently. Worse, the plan may carry SCOPE errors where an architectural assumption is wrong: "migrate multiple call sites" when there's one, "extend the existing CLI" when no CLI exists. BRIEF-AUTHOR pre-check before every dispatch: `git show HEAD:<file>` + `grep -nE '<symbol>'` against every function/type the brief cites AND `grep -rE` for the load-bearing nouns of the plan ("CLI", "call sites of X", "existing reconciler"); diff shape and verify scope BEFORE trusting plan language. If a plan says "extend X" without HEAD evidence X exists, the brief must say "X does not exist yet; implementer should invent the smallest X that satisfies Y."

(seen in: PR #96 Tasks 3-8 — `mirrorToLtm` return shape, `recordObservation` namespace vs class, `LTM.retrieve` return shape; Task 5 "multiple call sites" was one; Task 8 "extend the CLI" had no CLI)

_Added: 2026-06-13 | Task: Tasks 3-8 of PR 1 of the cog-LTM bridge roadmap_

## Reviewer Time-Budget Protocol For Grep-Verifiable Tasks

For implementer tasks whose verification is largely structural (file presence, import paths, return types, argv routing) — i.e. resolvable via `git show`, `grep -nE`, `sed -n` rather than running test suites — give spec and quality reviewers a HARD wall-time budget (8 min is plenty) AND a grep-driven checklist that tells them which commands to run before reaching for vitest. Without the budget, opinionated reviewers (especially Opus-class) burn hours doing empirical mutation tests they invented themselves (Task 8's first reviewer ran 4.9h before cancel). Reserve full empirical runs for behaviorally complex tasks (concurrency, atomicity, lifecycle). The checklist should name the exact ONE-SHOT commands: `git show HEAD:server/src/cli/dispatch.ts | sed -n '40,60p'` not "verify dispatch routing".

_Added: 2026-06-13 | Task: Task 8 of PR 1 of the cog-LTM bridge roadmap_

## Pre-Flag Accepted Deviations To Spec Reviewers

When the implementer deviates from the plan for a known-good reason (e.g. plan said "encouraged not required" and the implementer chose required; plan named a type that needed adjustment), pre-flag those deviations to the spec reviewer as ACCEPTED in the review brief so the reviewer doesn't spuriously flag them as bugs. Task 6's reviewer flagged a merged lifecycle test as a deviation when it was a planned consolidation; Task 8's reviewer flagged a spy-type adjustment that was necessary for the mock interface. Format: "Implementer also did X (deviation from plan §Y) — accepted, do not flag." Saves a review round trip and keeps the reviewer focused on real issues.

_Added: 2026-06-13 | Task: Tasks 6, 8 of PR 1 of the cog-LTM bridge roadmap_
