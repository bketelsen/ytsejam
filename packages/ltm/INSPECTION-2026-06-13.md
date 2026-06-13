# LTM — Inspection of Fable's Combined Round (RECALL + FOLLOWUP + OLLAMA + SEAM)

Date: 2026-06-13
Branch: `feat/plan-phases-1-5` (single branch, ~30 commits across four
plan tags)
Inspector: Mentat
Status: **READY TO MERGE.** One trivial bug filed as new follow-up.

---

## Scope inspected

Four plan tags on one branch:
- **[RECALL 1-10]** — strong-cue recall (dormant section, slot recall,
  consolidated resurrection, rehearsal)
- **[FOLLOWUP 1-3]** — three items I filed in PLAN-FOLLOWUP.md after the
  v2 review (directiveFloor symmetry, stoplist pollution, EpisodicKind
  soundness)
- **[OLLAMA 1-3]** — Ollama embedder + eval:ollama integration from
  PLAN-OLLAMA.md
- **[SEAM 1-5]** — LTM-side enablers for the cog-LTM bridge from
  COG-LTM-COMBINATION.md, plus a review-doc commit correcting four
  errors in my memo

---

## Gates (independently re-run; Fable's claim, my green is proof)

| gate | result | notes |
|---|---|---|
| `npm test` | **139/139 pass + 1 skipped** | up from 84; `ollama-live` correctly skipped sans env var |
| `npm run check` (tsc) | clean | |
| `npm run eval` (3 bands) | ALL BANDS PASSED | new measured numbers below |
| `npm run eval:sweep` (20 seeds × 3 bands) | **60/60 PASS** | 100% per band, not just ≥95% |
| `npm run eval:ollama` (live nomic-embed-text) | ALL BANDS PASSED | further lift over HashEmbedder |
| `npm run bench` (100/1k/10k records) | PASSED | **improved** vs v2 (20.9k vs 16k turns/s ingest; p99 5.9ms vs 8.7ms at 10k) |

---

## Eval numbers, hash mode (the headline)

| band | recall@5 | paraphrase r@5 | MRR | pref F1 | directives | identity | stability |
|---|---|---|---|---|---|---|---|
| short  | 100% | **75%** | 1.00 | 1.00 | 100% | yes | 100% |
| medium | **100%** | **75%** | **0.81** | 0.33 | **100%** | yes | 40% |
| long   | **100%** | **75%** | **1.00** | 0.33 | 0% | no  | 20% |

Bolded values **moved** from the v2 numbers. Key shifts:
- medium/long paraphrase recall 0% → **75%** (strong-cue recall reaches
  past floor)
- medium/long recall@5 88% → **100%** (vector resurrection of
  consolidated)
- long MRR 0.88 → **1.00** (resurrected items rank top)
- medium directive recall 0% → **100%** (FOLLOWUP 1: directiveFloor 0.2)
- long directive recall stays 0% — **honest amendment**: data
  contradicted my "10-30%" prediction; Fable showed directives plant at
  sessions 1-2, so at the ~1440d horizon strength ~0.07 is below even
  the 0.2 floor. Asserting 0% as correct decay-bites symmetric with
  `identityExpected: false` instead of fudging the threshold. The right
  call.
- identity at long still NO, stability still 40%/20% — **decay-bites
  assertions preserved**. Improvements added recall paths; they did NOT
  defang decay.

## Eval numbers, ollama mode (additional lift)

| band | paraphrase r@5 |
|---|---|
| short  | 75% → **100%** |
| medium | 75% → **88%**  |
| long   | 75% → **88%**  |

Strong-cue recall + nomic-embed-text together close to ~90%+ even at
4yr horizon. Each alone got ~75%; combined → measurable additional
lift.

---

## SEAM corrections to my memo

Fable's `cf3c6b4` review notes corrected four real errors and surfaced
two missed risks in my COG-LTM-COMBINATION.md. Documenting because the
pattern matters more than the specific errors:

| # | error | why it would have bitten |
|---|---|---|
| 1 | "Per-kind episodic half-life exists, just set 730d for observations" | It didn't exist — I extrapolated from fact-side half-lives. A backdated observation would have arrived pre-decayed to retention ~10⁻⁷ → instantly invisible. **The bridge would have ingested deliberate writes into immediate decay.** |
| 2 | "Add `fact` to `EpisodicKind` (precedent: v2 review)" | Backwards citation. The v2 review split `PromotedFact` OUT for soundness, not added it in. Different argument needed. |
| 3 | "Promotion gate: `mentionCount ≥ 3 AND recallCount ≥ 1`" | `recallCount` only bumps on below-floor recalls (strong-cue rehearsal). My filter exactly *excluded* always-above-floor stable patterns — the things the promotion was supposed to find. **Inverted the intent of the feature.** |
| 4 | "No schema change; just metadata" | Tags didn't exist on `EpisodicRecord`. `RedactionSelector` had no provenance selector. Line-number provenance into human-edited markdown drifts. Three real additive API surfaces needed, not "metadata." |

Plus the two operational risks I missed:
- **Seam loop**: Bridge 2 → cog observation → Bridge 1 → LTM fact → Bridge 2 → ad infinitum. Fable's defense: content-addressed observation ids (`obs-<sha256(text+timestamp)[:12]>`) + first-sight-only fact learning. Re-ingest of an unchanged line is now a true no-op (record upserts latest-wins, but mentionCount/strength DON'T accrue — which matters because Bridge 2's promotion gate reads mentionCount). Tested.
- **Consolidation interplay**: observations would have been folded by accident if their slow decay ever dipped below threshold. Now an explicit `kind === "observation"` exemption in consolidation. Tested.

**My memo grade**: B-. Architecture-level call was right (bridge not
fold, Option C). Implementation details from "What would have to be
built" downward had 4 wrong claims about LTM's surface and missed 2
operational risks. Lesson: I made the "trust the source doc, skip the
re-grep" mistake from `cog-meta/patterns.md` ("BRIEF-AUTHOR pre-check")
when writing about LTM's surface — I extrapolated from semantic-side
patterns to episodic-side, didn't verify. Fable did the re-grep I
should have done.

The discipline Fable showed: corrected each error in the review notes
WITH the fix shipped in the same round, AND patched my memo to point
the bridge author at the now-true API. The implementer-as-reviewer
posture is exactly right.

---

## SEAM enablers shipped (Bridge 1 surface ready)

All five SEAM commits self-tested in `test/observation.test.ts`:

1. **SEAM 2** (`2613ed6`) — `DecayConfig.halfLifeDaysByKind` per-kind
   override, defaults `{observation: 730}`, `Infinity` pins. Test
   asserts observation retention ≈0.5 at 2yr vs turn retention <0.01.
2. **SEAM 3** (`fd2514b`) — `EpisodicRecord.tags?: string[]` +
   `retrieve({filterTags})` for domain scoping. Tested.
3. **SEAM 4** (`a2e15be`) — `kind: "observation"` added to
   `EpisodicKind`; `MemorySystem.recordObservation({text, timestamp,
   tags?, origin?, salience?})` — content-addressed, embeds, upserts,
   feeds the semantic extractor with origin-keyed synthesized source so
   redaction cascades. **This is the one API call Bridge 1 needs.**
   Tested for round-trip, idempotency, fact extraction with
   provenance, slow decay, tag scoping.
4. **SEAM 5** (`ef0eb55`) — `RedactionSelector.originPrefix` for
   cog-side provenance cascade; explicit consolidation exemption for
   observations. Audit trail stores the prefix verbatim (a pointer,
   not content). Tested.
5. **SEAM 5 fact-idempotency** (`26d4163`) — re-record same observation
   does NOT accrue mentionCount or strength. The seam-loop defense.
   Tested.

**Bridge 1 size estimate now** (~150 LOC was my original): closer to
~50 LOC + a test file. The hard parts moved into LTM where they
belong.

---

## What still needs filing

### One new bug: `formatBandedResult` spreads a string into characters

Lines 523-524 of `src/eval/harness.ts`:

```ts
return [
  ...result.bands.map((b) => formatReport(b)).join("\n\n" + "─".repeat(72) + "\n\n"),
  ...
].join("\n");
```

The `.join()` returns a STRING. `...string` spreads it into individual
characters. The outer `.join("\n")` then puts each character on its own
line. That's why `npm run eval` (all-bands) renders the per-band detail
blocks one-character-per-line.

**The summary table at the bottom is fine** because it uses a different
render path (`rows.join("\n")` not spread). That's why the bug
masquerades as "tail artifact" when you only look at the last few
lines.

Fix: drop the spread.

```ts
return [
  result.bands.map(formatReport).join("\n\n" + "─".repeat(72) + "\n\n"),
  "",
  // ... rest unchanged
].join("\n");
```

~5 character change. I flagged this as a "tail artifact" in v2 review
— wrong then. Visible during this inspection because I read the full
eval output without piping through tail. Will file as PLAN-FOLLOWUP
Task 4.

### What is NOT bug-worthy

- The single domain-scope-vs-fact-promotion interaction noted in
  `c090c94` ("filterTags scopes episodic, facts live in one
  cross-domain profile") is inherent to LTM's single-profile model.
  The bridge author needs to know it; not a bug.
- The original PLAN-FOLLOWUP Task 1 "Done when: non-zero
  directiveRecall threshold on long" is now wrong — Fable correctly
  documented why and amended the plan in the commit body. Good
  amendment, not a defect.
- Test count went from 84 to 139 (+55). No suite got smaller, no test
  was deleted to make a change pass.

---

## Verdict

**Ready to merge.** Independent gate re-run is green across the
board. Fable's discipline in this round was exceptional:
- corrected my memo errors in the same branch as the fixes
- amended PLAN-FOLLOWUP Task 1's prediction with measurement evidence
  rather than fudging the threshold
- shipped review notes (`58b9262`, `4b62b72`, `0a89c4d`, `553899c`,
  `2e70a4e`, `cd48ae6`) that show the implementer cycle is a real
  feedback loop, not theater
- preserved every decay-bites assertion from earlier rounds
- chose every option I recommended (Option A for FOLLOWUP 1, Option B
  for FOLLOWUP 3, Option C for the cog-LTM bridge)

The shape of the merge: one PR, ~30 commits, four plan tags. Each
commit is self-contained. Reviewing is easy because the tags route
attention.

**After merge**: file PLAN-FOLLOWUP Task 4 (the formatBandedResult
fix). Then the cog-LTM bridge plan is unblocked: Bridge 1 reduces to
a small ytsejam-side wrapper around `MemorySystem.recordObservation()`.
Bridge 2 needs the corrected promotion gate
(`mentionCount ≥ 3 across ≥ N sessions over ≥ 14d`). Bridge 3 uses
interleave-top-k-per-source instead of my fake unified score.

A skill orchestrating existing tools could not have produced this
work — the harness gate the cog-LTM bridge will eventually face passes
cleanly because the SEAM commits land server-side capabilities
(per-kind decay, tags, originPrefix redaction) that no skill could
emulate.

-- Mentat
