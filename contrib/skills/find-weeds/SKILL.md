---
name: find-weeds
description: Pull weeds — scan a codebase for small, safe gardening fixes (missing tests, duplicated blocks, lint issues, simplifiable code, dead code, type gaps, TODOs, stale docs) and file up to 5 GitHub issues for the clear ones. NO structural/behavioral changes. Use for code hygiene, a maintenance pass, or "find things to clean up".
triggers: [find weeds, weeds, code hygiene, gardening pass, find things to clean up, tidy up the code]
---

# find-weeds

Gardening, not landscaping. Walk the codebase, spot **weeds** — small, safe, obvious
improvements — and file GitHub issues for the clear ones. You don't pull them here (that's
`pull-weeds`); you find and file. Capped so the weed bed never overgrows.

**A weed is small and safe:** a missing test for existing behavior, a duplicated block that
should be extracted, a lint/style-rule violation, an `as any` that could be narrowed, dead
code, a stray `console.log` in server code, a TODO/FIXME, a stale doc line, something trivially
simplifiable.

**NOT a weed (do NOT file as one):** anything structural or behavioral — API changes, new
features, architecture/refactor decisions, performance work, or anything that needs a design
discussion. If you spot one of those, note it separately for the user; it goes through
`brainstorm`, not the weed bed.

## Step 0 — Cap check (BEFORE anything else)

The weed bed holds at most **5 open issues**. Pull before you plant more.

```bash
# ensure the label exists (idempotent)
gh label list --repo <owner/repo> | grep -q '^weed' || gh label create weed --description "Small safe gardening fix" --color 3a7d44
OPEN=$(gh issue list --repo <owner/repo> --label weed --state open --json number -q 'length')
```

- If `OPEN >= 5`: **stop.** Tell the user: "Weed bed is full ($OPEN open weed issues). Run
  `pull-weeds` to clear some before finding more." Do not scan, do not file.
- Else: `BUDGET = 5 - OPEN`. You may file **at most BUDGET** issues this run. Pick the
  highest-value weeds if the scan finds more.

## Step 1 — Confirm scope + gather what's already filed

- **Root:** which directory to scan? Default: the session working directory (`pwd`).
- **Focus:** all categories, or specific ones (e.g. tests only, lint only)?
- **Already-filed weeds** (so the scan doesn't re-surface them): grab the open `weed` issue
  titles (and optionally open PR titles) to pass into the scan prompt:
  ```bash
  gh issue list --repo <owner/repo> --label weed --state open --json title -q '.[].title'
  ```

(The harness auto-loads `AGENTS.md`/`CLAUDE.md` into the scan subagent's context, so it already
knows the codebase conventions — no need to point it at a CONTEXT.md.)

## Step 2 — Dispatch the scan subagent

Dispatch **one** read-only scan subagent via `delegate`, model `github-copilot/claude-opus-4.8`.
(A single strong model that JUDGES well beats two models that merely overlap on coverage —
observed 2026-06-11: a faster model found the same real weeds but mis-filed deliberate
behavioral patterns as weeds; opus correctly fenced those off. For "small safe fixes," good
triage matters more than speed.) Prompt template: see [REFERENCE.md](REFERENCE.md). The brief
MUST: be read-only, forbid further delegation, include the already-filed `weed` titles with a
"do NOT re-suggest these" block, demand a "be conservative — anything structural/behavioral is
NOT a weed, list it separately" stance, and ask for a prioritized findings table.

## Step 3 — Triage the findings

When the report arrives (inline), keep only real weeds:
- ✅ A small, safe, clearly-valid fix (real dead code, a factually wrong doc line, an actual
  missing test, a true duplication, a narrowable `as any`) → candidate.
- ⚠️ Opinion/style with no enforced standard → skip unless high-impact.
- ❌ **Structural or behavioral** (changes an API, behavior, architecture; "fixing" a deliberate
  commented pattern) → **NOT a weed.** Skip; note separately for the user (it goes to `brainstorm`).
- Drop anything already in the open-`weed` list you passed in (belt-and-suspenders — the prompt
  should have prevented it).

Rank survivors by value. Keep at most **BUDGET** (from Step 0).

## Step 4 — File issues (≤ BUDGET)

For each kept weed, `gh issue create` with `--label weed` (+ `mobile`/`documentation` if apt).
Body template:

```
## Weed
[one-paragraph: what the small/safe issue is]

Location:
- `path/to/file.ts` lines ~N–M — [description]

## Fix
[one-paragraph: the small fix]

_Found by find-weeds (claude-opus-4.8) YYYY-MM-DD_
```

Never exceed BUDGET. If the scan found more good weeds than BUDGET allowed, list the extras in
the report (not filed) so they're not lost.

## Step 5 — Report

- How many weeds found; how many issues filed (with #numbers); how many skipped + why.
- Any NON-weed (structural/behavioral) items, flagged separately as "needs a design pass, not filed."
- Current weed-bed count: "<N>/5 open. Run pull-weeds to clear."

## Red Flags

**Never:**
- File a structural/behavioral change as a weed (that's `brainstorm` territory).
- Exceed 5 open weed issues (Step 0 cap is hard).
- Make any code change here — find-weeds is read-only + file issues. Pulling is `pull-weeds`.
- Guess label names — the cap counts `weed`-labeled open issues specifically.

## Integration

**Pairs with:** `pull-weeds` (find files them → pull resolves them). **Independent of** the brainstorm→ship dev loop.
