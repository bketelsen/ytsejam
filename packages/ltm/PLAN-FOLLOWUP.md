# LTM — Plan Follow-up (post Phase 1-5)

Three small fixes surfaced during the second review of Claude Fable's Phase 1-5
work. Each is independent, ≤30 LOC, and should land as its own PR before Phase 6
(FOLD-GAP + workspace-package extraction). None blocks Phase 6 if scheduling
prefers to defer.

Discipline carried over from PLAN.md: per-task tests are mandatory, each task
ships as one PR with `[FOLLOWUP N]` commit prefix, gate is
`npm test && npm run check && npm run eval`. No threshold gets lowered to
make a task pass — when a measured number changes, re-baseline thresholds in
the same commit and explain the delta in the body.

---

## Task 1 — Apply `directiveFloor` on medium/long bands

**Where**
- `src/eval/harness.ts` (band configs)
- `README.md` (per-band table)

**Why**
Task 2.1 implemented per-kind floors (`{floor, identityFloor, directiveFloor}`).
The eval uses `identityFloor: 0.2` on medium/long to keep identity surfacing —
but never sets `directiveFloor`, so single-assertion directives at month 24+
fall to effective strength ~0.20 (below the default 0.3 floor) and silently
vanish from the profile. Measured directive recall at medium/long is currently
**0%** and the threshold is **0** — intellectually honest about the *number*,
but the *seam* Phase 2 built is half-applied.

The intent of Task 2.1 was that bands can tune what gets surfaced at long
horizons. Identity got the tuning; directives didn't.

**Decision required (call before coding)**
There are two defensible choices:

- **A. Lower `directiveFloor` to 0.2 on medium/long** to mirror identity, then
  re-baseline (likely lands medium directive recall in the 30-60% range, long
  in the 10-30% range). Tells the world: a single user directive should be
  honored years later, even after long disuse.
- **B. Leave it at default 0.3 and document explicitly** that single-assertion
  directives genuinely decay out — directives have to be *reasserted* across
  the horizon to survive. Tells the world: a stale directive is more dangerous
  than a missing one, so we let it retire.

Recommend **A**, because the user-facing contract of a "standing instruction"
is "you set it once, I remember it" — that's what the word *standing* means.
Decay model already discounts directives less aggressively (365d half-life,
matching identity) — finishing the seam keeps that intent intact at retrieval
time. If a user wants a directive forgotten, redaction is the right surface.

**Do**
1. Add `directiveFloor: 0.2` to the medium and long band `config.profile`
   blocks in `BANDS`.
2. Run `npm run eval` and capture the new measured medium / long directive
   recall numbers.
3. Re-baseline `directiveRecall` thresholds on medium / long to measured
   minus 5pp.
4. Run `npm run eval:sweep` — must still hit 60/60.
5. Update the README per-band table with the new numbers and a sentence noting
   that medium/long lower `directiveFloor` symmetrically with `identityFloor`.

**Done when**
- `npm run eval` passes with non-zero `directiveRecall` thresholds on medium /
  long.
- `npm run eval:sweep` hits 60/60.
- README per-band table reflects the new measured numbers.
- Commit body explains the choice (A vs B) and links this file.

---

## Task 2 — Stop sentence-opening conversational fillers from polluting `topEntities`

**Where**
- `src/semantic/extract.ts` (`CAP_STOPLIST`)
- `test/adversarial.test.ts` (one new scenario)

**Why**
`ltm profile` against a fresh synthetic corpus shows
`top entities: Happy(30), Good(28), ...` because the synthetic ASSISTANT_OPENERS
include "Happy to help with that." and "Good question, let's break it down." —
neither word is in `CAP_STOPLIST`. The leading-stoplist-strip fix from Task 3.1
(part of the Grafana fix) handles `The Grafana` correctly but doesn't help here
because `Happy` and `Good` aren't on the list.

Failure mode: doesn't fail any threshold (top-entities never asserted in
tests), but visibly degrades the human-facing CLI output and would similarly
pollute any real ytsejam session where the assistant uses these openers.

The adversarial test for "fact-free high-frequency entity" only asserts that
Grafana IS in topEntities, never asserts what's NOT there — so the same family
of bugs can recur silently.

**Do**
1. Audit ASSISTANT_OPENERS in `src/eval/synthetic.ts` for sentence-initial
   capitalized words that aren't proper nouns. At minimum: `Happy`, `Good`,
   `Here`, `Sure`, `That` (some already covered, verify).
2. Audit the same in real conversational data: `Absolutely`, `Definitely`,
   `Got`, `Sounds`, `Looks`, `Let`, `Let's`, `Welcome`, `Glad`, `Cool`,
   `Right`, `Awesome`, `Great`.
3. Extend `CAP_STOPLIST` with the audit results.
4. Add an adversarial test: ingest a corpus where the assistant says
   "Happy to help" / "Good question" / etc. N times each across multiple
   sessions, then assert `topEntities` does NOT contain any of those words.
   This is the negative-space assertion the current Grafana test is missing.
5. Re-run `npm run eval:sweep`. The change should not regress any band; if a
   threshold tightens because an entity that was being correctly picked up is
   now lost, that's a Task-2 bug to address before merge (the stoplist is
   precision-on-fillers, not blanket-on-common-words).

**Done when**
- Fresh `ltm profile` against the standard corpus shows no `Happy` / `Good` /
  similar filler-opener words in topEntities.
- New adversarial test asserts negative-space (filler openers NOT in
  topEntities) — fails before the stoplist extension, passes after.
- `npm run eval:sweep` still hits 60/60.

---

## Task 3 — Close the `EpisodicKind` type-soundness gap from slot-aware promotion

**Where**
- `src/types.ts` (`EpisodicKind` union)
- `src/retrieval/promote.ts` (synthetic record construction)
- Any `switch (r.kind)` or kind-narrowing site (grep first; episodic store,
  consolidate, doctor)

**Why**
`promote.ts` constructs synthetic `EpisodicRecord` values with `kind: "fact"`,
but `EpisodicKind = "turn" | "consolidated"` in `types.ts`. The code compiles
because the synthetic records flow through structural-typing paths that don't
exhaustively narrow on `kind` — but the next caller to write
`switch (r.kind) { case "turn": ... case "consolidated": ... }` will be
non-exhaustive at runtime and either crash or silently ignore promoted records.

This is the kind of latent gap that bites months later when someone adds a
codepath assuming the union is what `types.ts` says it is. It's also a
documentation defect: the union in `types.ts` is no longer the truth.

**Do**

Pick the right shape — there are three viable options, in increasing
invasiveness:

- **A. Extend the union.** `EpisodicKind = "turn" | "consolidated" | "fact"`.
  Audit every `switch (r.kind)` / kind narrowing in the codebase and add a
  `"fact"` arm or an exhaustiveness assertion. Promoted facts become
  first-class episodic records and survive store round-trips (today they're
  retrieval-only and never persist).
- **B. Keep promoted facts retrieval-only with a separate type.**
  `PromotedFact extends EpisodicRecordShape` but with its own `kind: "fact"`
  literal, NOT in `EpisodicKind`. Retrieval returns
  `RetrievedItem = { record: EpisodicRecord | PromotedFact; ... }`. Stronger
  separation between persisted and synthetic; the store layer stays oblivious
  to promotion.
- **C. Drop the `kind` field from promoted records entirely** and add a
  `_synthetic: true` discriminator on the wrapper. Cleanest separation but
  most edits.

**Recommend B**: promoted facts are conceptually retrieval-only (they're
re-derived from `facts.jsonl` every retrieval, never written to
`episodic.jsonl`), and option A would require the store to know how to
serialize them (which it shouldn't — facts already live in `facts.jsonl`,
that's the SSOT). Option C is more disruption than the problem warrants.

**Do (option B)**
1. Grep the codebase for `EpisodicKind`, `r.kind`, `record.kind`, `kind:` —
   list every site that narrows or reads the field.
2. Define `PromotedFact` in `src/types.ts` with its own `kind: "fact"`
   literal and a comment explaining it is NEVER persisted.
3. Widen the relevant retrieval-layer types so `RetrievedItem.record` is
   `EpisodicRecord | PromotedFact`. Narrow back to `EpisodicRecord` at every
   persist boundary (`episodic/store.ts` writes, doctor inspection, etc.) —
   add an `assertEpisodic(record)` guard if more than one site needs it.
4. Update `promote.ts` to construct `PromotedFact`, not `EpisodicRecord`.
5. Add a tsc-level test: a deliberately exhaustive `switch (r.kind)` over
   `EpisodicRecord` should compile (proving the union is closed and accurate).
   Vitest's `expectTypeOf` or a `// @ts-expect-error` on the missing-arm case
   is enough.
6. Re-run `npm test && npm run check && npm run eval && npm run eval:sweep`.
   No threshold should move.

**Done when**
- `EpisodicKind` in `types.ts` is the truth: every value with `kind: K` for
  `K in EpisodicKind` is an `EpisodicRecord`, and vice versa.
- Promoted facts have a distinct type and don't flow through persist paths.
- A type-level test proves the `EpisodicRecord` union is exhaustively
  narrowable.
- Functional behavior unchanged (paraphrase recall@5 at short stays at 75%).

---

## Ordering

Tasks 1, 2, 3 are independent (no shared files except all touch
`test/...`). Recommended order, smallest blast radius first:

1. Task 2 (stoplist + negative-space adversarial test) — pure additions,
   no public API change, lowest risk.
2. Task 1 (directiveFloor + threshold re-baseline) — config change with
   numeric impact, needs the sweep gate.
3. Task 3 (type-soundness) — touches the most files, but no runtime
   behavior change, so the eval is unaffected.

Each as its own PR with `[FOLLOWUP 1|2|3]` prefix. Phase 6 (FOLD-GAP +
workspace-package extraction) can start as soon as Task 3 lands — Tasks 1
and 2 don't block fold work.
