---
name: ponytail-audit
description: Whole-repo audit for over-engineering. Like ponytail-review, but scans the entire codebase instead of a diff — a ranked list of what to delete, simplify, or replace with stdlib/native/dep equivalents. Use when the user says "audit this codebase", "audit for over-engineering", "what can I delete from this repo", "find bloat in this repo", "ponytail-audit", or "/ponytail-audit". One-shot report — does not apply fixes.
triggers: [ponytail-audit, audit for over-engineering, audit this codebase, what can I delete from this repo, find bloat in this repo, repo-wide bloat scan]
---

# ponytail-audit

`ponytail-review`, repo-wide. Scan the whole tree instead of a diff. Rank findings biggest
cut first. Adapted from [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) (MIT).

## Step 1 — Confirm scope

- **Root:** which directory? Default: the session working directory (`pwd`).
- **Focus:** all categories, or specific ones (just deps, just stdlib reinventions, etc.)?
- **Excludes:** generated files, vendored libs, `node_modules`, `dist`, `.git`. Default
  excludes apply unless the user overrides.

Confirm root + focus before dispatching the scan.

## Step 2 — Dispatch the scan

For any non-trivial repo (>20 source files), dispatch **one** read-only scan subagent via
`delegate`, model `github-copilot/claude-opus-4.8`. (Same triage rationale as `find-weeds`:
one judging model beats two overlapping fast ones on "is this really bloat vs. a deliberate
pattern".) Brief MUST: be read-only, forbid further delegation, include the conservative
stance below, demand the ranked findings table.

Brief template:

```
You are doing a READ-ONLY over-engineering audit of <PROJECT_NAME> at <PROJECT_CWD>
(<LANGUAGE/FRAMEWORK> — <brief layout>). cd there; run `git log --oneline -5` to confirm
the codebase. **Make NO changes. Read-only.** You cannot delegate further — do the scan
yourself.

## What to hunt (the ladder applied repo-wide)

- `delete:` — dead code, unused exports never imported, unreachable branches,
  assigned-never-read vars, dead feature flags, config nobody sets.
- `stdlib:` — hand-rolled things the language stdlib ships. Name the function.
- `native:` — dependencies or code doing what the platform (browser/Node/DB) already
  provides. Name the feature.
- `dep:` — code duplicating what an already-installed dependency provides. Name the dep.
- `yagni:` — single-implementation interfaces, factories with one product, wrappers
  that only delegate, files exporting one thing, abstraction layers with one caller.
- `shrink:` — verbose code with an obviously simpler equivalent (no behavior change).

Read package.json (or equivalent) FIRST so you know what's already installed — half the
"hand-rolled X" findings come from spotting a dep that's already there.

## BE CONSERVATIVE
Anything that would change an API, change observable behavior, or "fix" a deliberate
pattern (a `// ponytail:` comment naming its own ceiling, an intentional defensive
catch, a startup banner, library-imposed `any`) is **NOT bloat for this audit**.
Skip it. List such items separately under "NOT BLOAT (needs design pass)".

## Output

One line per finding, **ranked biggest cut first**:

`<tag> <what to cut>. <replacement>. [path:lines]`

End with: `net: -<N> lines, -<M> deps possible.`
If nothing to cut: `Lean already. Ship.`
Then the "NOT BLOAT (needs design)" list.
```

## Step 3 — Report

Inline the subagent's ranked table to the user. Lead with the top 5 cuts, then the full
list. End with the net + the "needs design" callouts.

## Red Flags

**Never:**
- File GH issues from this audit — that's `find-weeds`' job, and the bloat categories
  here often need a design pass before a fix (use `brainstorm`).
- Apply fixes. One-shot report; the user decides what to act on.
- Flag a `// ponytail:` simplification that already names its ceiling + upgrade path.
- Flag the ponytail-mandated single smoke-test / assert-based self-check as bloat.
- Confuse this with correctness/security review — those go through `review`.

## Integration

**Pairs with:** `ponytail-review` (diff-scoped version), `find-weeds` (hygiene, files
issues). **Feeds into:** `brainstorm` for the structural cuts, `pull-weeds`-style
follow-up for the trivial deletions. **Boundary:** the audit reports; the user routes.
