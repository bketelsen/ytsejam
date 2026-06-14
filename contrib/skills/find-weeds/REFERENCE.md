# find-weeds — Reference

## Scan subagent prompt

One read-only `delegate` dispatch, model `github-copilot/claude-opus-4.8`. Fill the bracketed
parts. The two things the port learned to bake in: **(a)** the already-filed `weed` titles so it
doesn't re-suggest them, and **(b)** an explicit conservative stance so behavioral/structural
items are fenced off as NOT weeds (not filed as one).

```
delegate({
  label: "Weed scan",
  model: "github-copilot/claude-opus-4.8",
  task: """
You are doing a READ-ONLY code gardening scan of <PROJECT_NAME> at <PROJECT_CWD>
(<LANGUAGE/FRAMEWORK> — <brief layout>). cd there; run `git log --oneline -5` to confirm the
codebase. **Make NO changes. Read-only.** You cannot delegate further — do the scan yourself.

## Already filed — do NOT re-suggest any of these
<paste the open `weed` issue titles, one per line; "none" if empty>

Find WEEDS — small, safe, OBVIOUS improvements only. Categories:

MISSING TESTS — existing behavior/functions with no coverage where a test framework exists
DUPLICATION — the same block of logic copy-pasted in 2+ places that should be extracted
LINT / STYLE-RULE — violations of a rule the project already enforces (run the linter if present)
TYPE GAPS — `as any` narrowable to a real type; `err:any`/`catch(e:any)` → `unknown`+guard; missing return types on exported fns
DEAD CODE — unused exports never imported outside their file; unreachable branches; assigned-never-read vars
SIMPLIFIABLE — verbose code with an obviously simpler equivalent (NO behavior change)
LOGGING — console.* in server/daemon code that should use a structured logger IF ONE EXISTS
TODOS / FIXMES — every TODO/FIXME/HACK/XXX with file:line + text
STALE DOCS — wrong version numbers, removed-field/API refs, env-table entries not matching config, missing shipped-feature entries

## BE CONSERVATIVE (this is the important part)
This workflow files SMALL SAFE fixes only. If an item would change an API, behavior, or
architecture — or "fixing" it means altering a deliberate/commented pattern (e.g. an
intentional React effect or ref-write, a startup banner, a library-imposed `any`) — it is
**NOT a weed**. Do not flag it as one. List such items separately under
"NOT WEEDS (needs design)". When in doubt, it is NOT a weed.

**Specifically: any `// ponytail:` (or `# ponytail:`, `<!-- ponytail:` etc.) comment marks
an INTENTIONAL simplification.** The comment often names the ceiling and upgrade trigger
(e.g. `// ponytail: O(n²), swap for index when n > 1k`). Do NOT flag the simplification
itself — that's contracted, not a weed. If you can VERIFY the named upgrade trigger has
fired (the n is demonstrably > 1k, the throughput IS the bottleneck), list it under
"NOT WEEDS (needs design)" as a ponytail-promise-came-due, not as a weed. `grep -rn
"ponytail:"` is the cheap pre-scan to see what intentional shortcuts already exist.

Explore systematically; use grep/glob. Read package.json scripts, tsconfig, config, and the
linter config to GROUND each finding (don't guess that a lint rule fires — confirm it).

**Output:** a prioritized table grouped by category — impact (high/med/low) | file | line range |
one-sentence description | suggested small fix. Be concrete with file:line; favor precision over
volume — only real, verifiable, SAFE weeds. End with the "NOT WEEDS (needs design)" list.
"""
})
```

## Categories (quick list)

| Category | Flag |
|---|---|
| Missing tests | Existing behavior with no coverage |
| Duplication | Same block in 2+ places → extract |
| Lint / style | Violations of an enforced rule (confirm via the linter) |
| Type gaps | `as any`, `err:any`, missing return types |
| Dead code | Unused exports, unreachable branches, dead vars |
| Simplifiable | Verbose code with a simpler equivalent (no behavior change) |
| Logging | console.* in server code → structured logger (only if one exists) |
| TODOs/FIXMEs | All TODO/FIXME/HACK/XXX |
| Stale docs | Wrong versions, removed-field refs, missing shipped-feature entries |

**Not weeds (never file as one):** API/behavior changes, new features, architecture/refactor
decisions, performance work, "fixing" deliberate commented patterns. → flag separately for a
`brainstorm` pass.

## Model

`github-copilot/claude-opus-4.8` — single strong model chosen for JUDGMENT, not speed. The port
ran a dual gpt-5.5 + opus scan once (2026-06-11): they overlapped on real weeds (no added
coverage), but the faster model mis-filed 6 deliberate React-hooks patterns as weeds while opus
correctly fenced them off. For "small safe fixes" the cost of a bad judgment (sending pull-weeds
to break working code) outweighs the latency cost — so: one model, opus, conservative prompt.

## The cap (counted against the `weed` label)

```bash
gh label list --repo <owner/repo> | grep -q '^weed' || gh label create weed --description "Small safe gardening fix" --color 3a7d44
OPEN=$(gh issue list --repo <owner/repo> --label weed --state open --json number -q 'length')
# OPEN >= 5 → stop (bed full). else BUDGET = 5 - OPEN.
```

## Issue body template

```
## Weed
[what the small, safe issue is]

Location:
- `src/path/to/file.ts` lines ~N–M — [description]

## Fix
[the small fix]

_Found by find-weeds (claude-opus-4.8) YYYY-MM-DD_
```
