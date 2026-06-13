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
