---
name: ponytail-review
description: Code review focused exclusively on over-engineering. Finds what to delete — reinvented standard library, unneeded dependencies, speculative abstractions, dead flexibility. One line per finding — location, what to cut, what replaces it. Use when the user says "review for over-engineering", "what can we delete", "is this over-engineered", "simplify review", or invokes /ponytail-review. Complements correctness-focused review — this one only hunts complexity.
triggers: [ponytail-review, review for over-engineering, what can we delete, is this over-engineered, simplify review, hunt complexity, find bloat in this diff]
---

# ponytail-review

Review a diff for unnecessary complexity. **One line per finding.** The diff's best outcome
is getting shorter. Adapted from [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) (MIT).

Complements the existing `review` skill (which checks spec compliance + code quality). This
one *only* hunts deletable bloat — never raise it as a substitute for correctness review.

## Step 1 — Gather the diff

```bash
# Default: HEAD vs main. Ask the user if they want a different range.
BASE_SHA=$(git merge-base HEAD origin/main)
HEAD_SHA=$(git rev-parse HEAD)
git diff --stat $BASE_SHA..$HEAD_SHA
```

If the diff is large (>20 files / >500 LOC changed), confirm scope with the user before
proceeding — they may want it scoped to a subdirectory or to staged changes only
(`git diff --staged`).

## Step 2 — Scan the diff with the ladder lens

For each non-trivial addition, walk the ladder from `ponytail`:

1. Does this need to exist? (`delete:`)
2. Does the stdlib do it? (`stdlib:`)
3. Does the platform/native do it? (`native:`)
4. Does an installed dep do it? (`dep:`)
5. Can it be one line? (`shrink:`)
6. Is the abstraction speculative? (`yagni:`)

Optional dispatch: for a large diff, delegate the scan to a subagent
(`github-copilot/claude-opus-4.8`) with this prompt and the diff text, asking for the
findings table below. For a small diff (< ~200 LOC), do it inline.

## Step 3 — Format

One line per finding:

```
<file>:L<line>: <tag> <what>. <replacement>.
```

Tags:

- `delete:` — dead code, unused flexibility, speculative feature. Replacement: nothing.
- `stdlib:` — hand-rolled thing the standard library ships. Name the function.
- `native:` — dependency or code doing what the platform already does. Name the feature.
- `dep:` — code duplicating what an already-installed dependency provides. Name the dep + function.
- `yagni:` — abstraction with one implementation; config nobody sets; layer with one caller.
- `shrink:` — same logic, fewer lines. Show the shorter form.

## Examples

❌ "This EmailValidator class might be more complex than necessary; have you considered
whether all these validation rules are needed at this stage?"

✅ `validate.ts:L12-38: stdlib: 27-line validator class. "@" in email, 1 line — real validation is the confirmation mail.`

✅ `format.ts:L4: native: moment.js imported for one format call. Intl.DateTimeFormat, 0 deps.`

✅ `repo.ts:L88: yagni: AbstractRepository with one implementation. Inline it until a second one exists.`

✅ `retry.ts:L52-71: delete: retry wrapper around an idempotent local call. Nothing replaces it.`

✅ `build.ts:L30-44: shrink: manual loop builds dict. Object.fromEntries(keys.map((k,i) => [k, values[i]])), 1 line.`

✅ `debounce.ts:L1-22: dep: hand-rolled debounce. lodash-es is in deps — import { debounce }.`

## Step 4 — Score and stop

End with the only metric that matters:

```
net: -<N> lines possible, -<M> deps possible.
```

If there is nothing to cut: `Lean already. Ship.` — and stop.

## Red Flags

**Never:**
- Flag a correctness bug, security hole, or performance regression here — those go to the
  normal `review` skill, not this one.
- Flag the ponytail-mandated single smoke-test / `assert`-based self-check as bloat — that's
  the floor, not the ceiling.
- Apply the fixes. This skill lists; it does not patch. The user (or a follow-up
  implementer dispatch) applies what they accept.
- Re-flag a `// ponytail:` comment that already names its ceiling and upgrade path —
  that's a deliberate, marked simplification.

## Integration

**Pairs with:** `review` (correctness/quality) and `ponytail-audit` (repo-wide version).
**Independent of:** `find-weeds` (which targets small hygiene issues and files GH issues;
ponytail-review reports inline and never files).
