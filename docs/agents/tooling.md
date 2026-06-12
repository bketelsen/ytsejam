# Tooling — Project Lessons

Lessons learned from failures and fix cycles.
Auto-appended by the lessons skill.

## Document Wrapper Behavior Not Wrapped Internals

When wrapping third-party functions like pi-ai's `isContextOverflow` (see `classifyOverflow` in compaction.ts:74-81), write JSDoc that describes what YOUR wrapper actually does after its guards, not what the underlying library does internally — copying upstream source comments verbatim produced a docstring claiming z.ai/MiMo silent-overflow coverage that the `if (msg.stopReason !== "error") return false` guard makes structurally unreachable. Verify behavior claims empirically (the reviewer caught this by running both functions against a synthetic silent-overflow message and seeing the wrapper return `false` where the claim said `true`) rather than trusting plan-doc snippets. When a guard deliberately narrows behavior, the comment must say so explicitly and flag any inert arguments (like the forward-compat-only `model.contextWindow`), because a misleading docstring is worse than none: it lures a future maintainer into "fixing" the guard or trusting a false coverage claim. State the intended scope, name what is out of scope and why, and describe the correct way to widen it later (relax the guard with a usage-based check, never just delete it).

_Added: 2026-06-12 | Task: Task 2: Overflow classifier + customInstructions + sur_

## Hoist Imports To Top In Append Workflows

When a plan instructs you to "append" to an existing file like `server/test/compaction.test.ts`, treat import statements as an exception: always fold new imports into the existing top-of-file import block rather than adding a second block near your new code. In this case the appended tests created a mid-file import at lines 115-116 that redundantly re-imported `AssistantMessage` from `@earendil-works/pi-ai` when `Model` was already imported from that package on line 2 — consolidate by merging type imports into one `import type { Model, AssistantMessage }` line and hoisting `../src/compaction.ts` symbols into the single existing import. Since the only quality gate is `tsc --noEmit` (no ESLint), nothing flags this structural drift automatically, so verify manually with `grep -n '^import' <file>` and confirm all matches fall in the top block. This matters because incremental plan-driven tasks compound the problem — each subsequent task that appends its own imports deepens the drift, so fixing it immediately keeps the file idiomatic for the next implementer.

_Added: 2026-06-12 | Task: Task 2: Overflow classifier + customInstructions + sur_

## Preserve Plan Defensive Details In Briefs

When lifting plan-doc content into per-task implementer briefs, copy defensive
code and explanatory "why" comments verbatim — never silently simplify them. In
the #72 fix this recurred three times: Task 3 dropped the plan's 2-level
`summaryTokens ?? Math.ceil(String(summary ?? "").length / 4)` fallback
(collapsing it to `?? 0`, which would silently undercount on a surrender-path
or future-pi `compactionEntry` and corrupt the Task 4
`succeeded = tokensAfterEstimated < budget` gate) and dropped the 6-line
why-comment above `let tokensAfterEstimated = 0;` in both
`server/src/manager.ts` and `server/src/task-manager.ts`, inviting a future
reader to "restore" the exact `?? tokensAfter` fallback that was the #72 bug.
Avoid omitting anything the plan specifies, and avoid adding anything the plan
omits, without explicitly recording the divergence and its rationale in the
brief. Because these helpers live at symmetric call sites, apply identical text
at every site for grep-discoverability (verified via
`grep -n "tokensAfterEstimated = 0"`). If a brief must diverge from the plan,
flag it loudly so reviewers and `git blame` readers see the reasoning instead
of an unexplained simplification.

_Added: 2026-06-12 | Task: Use estimateKeptSetTokens for tokens_after_estimated (#72)_
