# Plan — Make ltm Something I'd Be Proud To Use

Mentat, 2026-06-12. From an evaluation of Claude Fable's one-shot
implementation (see `ARCHITECTURE.md` for the design; this plan is the gap
list from a structured review + adversarial eval).

The one-shot is genuinely good. Shape is right (JSONL-as-truth, derived
indexes, redaction-as-graph-walk, profile-first composition). Eval passes
41/41 + green at default seeds and at 5 unseen seeds. What's missing is the
discipline that separates "research artifact" from "thing I'd run in
production behind ytsejam": the eval must measure the regime where decay
bites, the retriever must survive paraphrase, and the silent latent bugs
must come out.

## Anti-goals (do NOT do in this plan)

- No premature "fold into ytsejam" yet — that comes after the proof-of-concept
  earns its trust. Fold is a separate plan, not a task here.
- No swap-in of API embedders/LLM extractors as the default. The seams are
  already there; the swap belongs in the fold plan with a real key + cost
  budget conversation. This plan adds OPTIONAL adapters and tests them, but
  the default stays deterministic + offline so the eval stays reproducible.
- No new top-level features (no thematic consolidation, no multi-tenant,
  no streaming retrieval). All called out as `## Known limits` in the
  architecture doc; deferred to a successor plan.
- No structural rewrites. Every task here is a targeted fix or an additive
  measurement; the architecture survives untouched.

## Gates (every task must pass before commit)

```
npm test         # 41+ passing, no skips, no .only
npm run check    # tsc --noEmit clean
npm run eval     # PASSED at default thresholds + every new threshold this
                 # plan introduces
```

A task is "done" when:
1. The gate above is green from a clean checkout.
2. The commit is on the task's branch and pushed.
3. The PR exists and links the relevant section of this plan.
4. (For tasks that change eval thresholds): the new thresholds are
   committed in the same change as the code that makes them pass — no
   "threshold lowered to pass" debt.

## Phasing

Six phases. Each phase is one PR per task; within a phase tasks ship
serially (no stacking). Phases CAN be reordered if a task in a later phase
is blocked, but the eval-realism phase (Phase 1) must ship first because
every subsequent claim depends on a trustworthy eval.

---

## Phase 1 — Make the eval honest

Headline finding from the review: the eval passes at 100% across every
metric only because the synthetic corpus, the probes, the horizon, and the
decay constants are mutually calibrated to be inside the regime where
nothing decays and every probe is a lexical near-duplicate of its plant.
The eval must measure the regime where the system is actually challenged
before any later "improvement" can be credibly evaluated.

### Task 1.1 — Long-horizon eval band

Add an explicit `long-horizon` eval mode to `src/eval/harness.ts` that runs
the same persona across THREE horizons:

- `short` — current default (12 sessions × 14d interval ≈ 6mo)
- `medium` — 24 sessions × 30d interval ≈ 24mo (preferences fully decayed
  from last assertion, identity still alive)
- `long` — 24 sessions × 60d interval ≈ 48mo (identity decayed below
  profile floor with current constants — this is the failing case)

`npm run eval` runs all three bands and reports per-band metrics. Thresholds
ARE PER BAND (because expecting 100% at long-horizon would just mean
disabling decay):

| band   | recall@5 | MRR | preference F1 | directive recall | identity | stability |
|--------|----------|-----|---------------|------------------|----------|-----------|
| short  | 0.95     | 0.85| 1.0           | 1.0              | yes      | 1.0       |
| medium | 0.85     | 0.6 | 0.75          | 1.0              | yes      | 0.85      |
| long   | 0.70     | 0.4 | 0.40          | 0.5              | (best-effort, see Task 1.3) | 0.40 |

Defaults reflect the current code's actual behavior — these are not
aspirational. The eval should FAIL on Task 1.1's first run and the
remaining Phase 1 tasks fix it band-by-band.

NEW assertion in the eval-harness test: every band must run; current code
should pass `short`, fail `medium` and `long`. The test asserts the failure
modes so they're visible in CI.

### Task 1.2 — Paraphrase probe band

Add a `paraphrase` probe set to `DEFAULT_PERSONA` (or a sibling): each
planted fact gets a second `paraphraseProbe` string that intentionally
shares NO content words with the plant. Examples:

| fact key      | original probe                  | paraphrase probe                               |
|---------------|----------------------------------|------------------------------------------------|
| sister-name   | "What is my sister's name?"     | "Tell me about my sibling."                    |
| dog-name      | "What's my dog called?"         | "What is my canine companion's name?"          |
| employer      | "Where do I work?"              | "Where am I currently employed?"               |
| allergy       | "What food am I allergic to?"   | "What food can't I safely eat?"                |

The eval reports recall@5 and MRR for BOTH probe sets per band. The
`short` band's paraphrase recall@5 threshold is initially `0.20` (current
empirical result is ~20% from the review's out-of-band probes — `employer`
is the only one that hit, via the profile slot). This forces the
embedder-swap conversation in Phase 4 to be a real numerical conversation,
not "we should probably swap embedders someday".

### Task 1.3 — Decay-bites assertion

Add an `eval-harness` test that EXPLICITLY asserts the failure modes the
review surfaced, so a future "improvement" that silently re-calibrates them
away is caught:

```ts
it("identity name decays below profile floor at 4yr horizon", async () => {
  const report = await runEval({ workDir, seed: 42, band: "long" });
  expect(report.identityCorrect).toBe(false); // decay IS doing its job
});
```

This task INVERTS the usual "make tests pass" pressure: the decay model is
correct as designed; the eval must acknowledge the regime. If you find
yourself tempted to disable decay to "fix" the long-horizon test, stop —
the right answer is in Phase 2 (profile-floor calibration) and Phase 4
(real embedder swap), not in defanging the decay model.

### Task 1.4 — Adversarial-seed sweep

`npm run eval:sweep` runs the eval across 20 seeds (a deterministic seed
set: 1, 7, 11, 23, 42, 99, 271, 314, 1337, 31337, 65521, 99991, …) and
reports per-band per-seed pass rate. Fails CI if any band's pass rate falls
below 95% across the sweep. Catches "the seed I picked happens to put the
preference statement on session 5 but seed 99 puts it on session 11 where
the contradiction lands first" silent dependencies.

---

## Phase 2 — Fix the silent bugs the review surfaced

Six issues, six small PRs, no behavior change to the public surface beyond
what's needed.

### Task 2.1 — Profile-floor calibration is configurable

`profile()` uses `minStrength = 0.3` hardcoded. Lift to `LtmConfig.profile`
with `{floor, identityFloor, directiveFloor}` so the long-horizon band can
keep identity surfacing past 4y if the user accepts a higher false-positive
rate on noisy attributes. Default stays 0.3 / 0.3 / 0.3 — this is a
config seam, not a default change.

Eval assertion: the `medium` band keeps identity correct with default
floors AFTER Task 4.x's real embedder is plugged in (otherwise it's
papering over the wrong layer).

### Task 2.2 — Score-channel normalization audit

`retrieval/retriever.ts` divides BM25 by `maxLexical` so the top hit's
lexical channel is always 1.0, while the vector channel is raw cosine
(typically 0.1–0.7). The documented weights (`0.30·cos + 0.40·bm25 + …`)
overstate vector's effective contribution.

Fix: normalize the vector channel to its own max within the candidate
pool (same shape as the lexical normalization), so weights mean what the
doc says they mean. Add a unit test asserting that for a corpus where
vector and lexical agree on the top doc, the doc's `breakdown.vector`
equals `breakdown.lexical` (both 1.0).

If the fix changes any eval band's metrics — surface it in the PR
description with the before/after numbers, don't bury it.

### Task 2.3 — Consolidation id-collision close

`consolidate.ts` summary id: `con-${sessionId}-${group[0].id.split("#")[0].split("/")[1] ?? "0"}`.
If consolidation runs twice on a session (partial-redaction-rebuild edge case
exists already in `MemorySystem.redact`; future cross-session
re-consolidation would reopen it), the second one replaces the first via
latest-wins.

Fix: include a stable disambiguator — the SHA-256 prefix of the sorted
`sourceIds`, or a monotonic per-session counter persisted in
`ingest-state.json` under `consolidationsBySession[id]`. Either is fine;
the PR should justify the choice in one sentence.

Add a test: consolidate a session, redact one of the children to trigger
rebuild, then run consolidate again — assert THREE distinct summary
records exist (original, rebuilt-from-redaction-survivors, second-run) and
none are silently overwriting earlier ones.

### Task 2.4 — Entity extraction case-sensitivity audit

`extract.ts` lowercase-tech fallback works "correctly by accident":
relies on the case-sensitive `add()` always writing under the lowercased
key. Fix: make the contract explicit. Refactor `EntityCandidate` to carry
both `name` (display form) and `key` (normalized lowercase id), and have
`add()` index by `key` only. The behavior should be identical but the
contract should stop relying on regex-execution-order coincidence.

Test: a turn containing both "TypeScript" (capitalized) and "typescript"
(lowercase) produces ONE entity candidate with display name "TypeScript"
and is `tech`-kinded, regardless of which appears first in the text.

### Task 2.5 — "X over Y" preference drops the negative

`extractFacts` for "I prefer X over Y" learns `+X` but never `-Y`. Plausibly
correct (the user prefers X to Y in some context, not that they dislike Y
in general), but the test asserts only the positive case, hiding the
choice.

Decision needed in the PR's design notes:

- **Option A (current behavior, document):** "Comparison preferences learn
  only the preferred side. Dislike must be stated independently." Add a
  test asserting `-Y` is NOT learned and a code comment explaining.
- **Option B (extract both, weaker negative):** Learn `+X strength 0.6,
  -Y strength 0.4`. Add a test for both sides.

I lean A: comparisons in conversation are context-bound ("over plain
JavaScript for new services" — the "for" qualifies the comparison) and
storing the negative would generate false dislikes. Either way, pick and
document.

### Task 2.6 — `bumpAccess` log-growth bound

`EpisodicStore.bumpAccess` appends a full record snapshot per surfaced
item per retrieval. Log growth is `O(K × queries)`; only opportunistic
`JsonlLog.compact()` keeps it bounded, and nothing currently calls
compact() on the access path.

Fix: rate-limit access-count persistence. Keep accessCount updates in
memory and flush to the log either (a) on every Nth bump per record, or
(b) on a debounced timer (1s after last bump). Approach (a) is simpler;
the bump-debounce is the access count itself.

Eval thresholds unchanged. Add a stress test: 1000 retrievals against the
same corpus; assert `episodic.jsonl` byte size is bounded by some constant
× record count, not unbounded.

### Task 2.7 — Reader handles parentSession (subagent forks)

`SessionHeader.parentSession` is in the type but not used anywhere. ytsejam
subagents fork sessions; the parent linkage is meaningful for
ingest provenance. The ingest pipeline should walk forks so that a
subagent session's facts attribute to the parent user's profile, not to a
phantom "subagent user".

Add a test using a two-session fixture (parent + forked subagent) and
assert that a fact stated in the subagent's session ends up associated
with the parent session's user.

This is the first task that touches "ytsejam-realism" rather than just
internal hygiene — it's here in Phase 2 because the fix is small, and a
fold-into-ytsejam plan that didn't handle subagents would be a flop.

---

## Phase 3 — Tests that try to break it

The existing 41 tests confirm the design. None try to break it. This phase
adds adversarial tests in the spirit of the review — silent regressions
should fall here, not in production.

### Task 3.1 — Adversarial corpus generator

`src/eval/adversarial.ts` — a corpus generator that plants:

- Two preferences with overlapping object phrases ("dark roast coffee" and
  "dark roast", or "vim" and "vim keybindings"). Eval asserts both are
  learned distinctly, not collapsed.
- A preference and a contradicting directive ("I love emojis" + "Please
  never use emojis"). Eval asserts the directive wins for behavior
  questions, the preference is still in the profile, no silent merge.
- A fact stated in one session, contradicted in the next, RE-STATED in a
  later session. Eval asserts the latest assertion wins (re-statement
  revives), per the `supersededBy: undefined` reset in `assertFact`.
- An entity mentioned 50 times across sessions with no fact attached.
  Eval asserts it surfaces in `topEntities` but does NOT pollute the
  preference profile.
- A near-empty turn ("ok") followed by a high-salience fact. Asserts
  chunking + salience + retrieval still surface the fact.

### Task 3.2 — Malformed-session fuzz

`session/reader.ts` is tolerant by design. The current corruption test
asserts ONE malformed line. Add a fuzzer (deterministic per seed) that
generates session files with N% of lines corrupted (truncated JSON,
missing required fields, wrong types) and asserts:

- The reader never throws (except on header-line corruption — that's the
  ONE intentional throw).
- Recovered turns are a strict subset of intact ones.
- Warnings count matches corrupted line count.

### Task 3.3 — Reopen-after-redact-after-reopen

End-to-end test: ingest → retrieve → redact entity → reopen → ingest the
SAME sessions again → retrieve. Assert the redacted entity stays gone
(the architecture doc promises this; verify the ingest-state.json
already-processed gate + the redacted-fact's `state` survive the round
trip).

### Task 3.4 — Concurrent-write corruption check

If two processes (or the same process with two `MemorySystem.open`
handles) ingest at once, what happens? Probably nothing good. Either:

- Document the single-writer constraint in the README + add a `.lock`
  file check on `open()` that throws on stale-pid lock, OR
- Add a basic advisory lock (`flock(2)` via Node's `fs.constants` or a
  `lock.pid` file).

Pick the cheap right answer (lock file with stale-pid takeover) and test
that a second `open()` while the first is alive throws with a clear
message.

### Task 3.5 — Eval-failure-output is actionable

Right now `formatReport` lists failures but doesn't say "WHICH preferences
were spurious" with enough context to debug. Improve the failure output:

- Spurious learned preferences should print the EXAMPLE TURN that triggered
  the extraction (the first source ref's session/entry).
- Missed planted preferences should print "expected polarity X at object
  Y, observed: <closest learned fact or NONE>".
- Recall misses should print the planted answer + the top 3 actually-
  retrieved record texts.

This is the difference between "the eval fails, good luck" and "the eval
fails, here's where to look first." Crucial for the implementer of Phase 4.

---

## Phase 4 — Make paraphrase actually work

Phase 1.2 will surface that paraphrase recall is ~20% with HashEmbedder.
This phase fixes it WITHOUT moving the default to a paid API embedder
(which would break the offline-eval principle).

### Task 4.1 — Cached embedding adapter

Add `src/embedding/cached-embedder.ts`: wraps any `Embedder` with a
SHA-256-keyed on-disk cache (`<storeDir>/embed-cache/<hash>.json`). With
this in place, swapping in a real embedder for the eval becomes
near-free on re-runs — the first run pays the API cost, subsequent runs
hit the cache.

Test: same `embed("text")` call twice → second is a cache hit (assertable
via the underlying adapter's call count being 1).

### Task 4.2 — Local sentence-transformer embedder (OPTIONAL, behind a flag)

Add `src/embedding/local-embedder.ts` using one of:

- a small ONNX-runtime sentence-transformers model (all-MiniLM-L6-v2,
  ~80MB, 384-dim, runs on CPU), or
- a quantized GGUF model via llama.cpp bindings,

with a `LOCAL_EMBEDDER_MODEL=/path/to/model` env var. Default
HashEmbedder still ships and the eval defaults to it. But a new eval mode
`npm run eval:semantic` uses LocalEmbedder + cache and adds a paraphrase
recall threshold of `0.80` to the medium band.

The dependency is heavy (ONNX runtime is 30-50MB). It must be an OPTIONAL
peerDep, not in default `dependencies`. The README should explicitly say
"semantic eval mode requires ~100MB of model + runtime; skip if you don't
need it."

If ONNX/GGUF integration is too much friction (this is the project's only
non-trivial dependency), document the seam and stub a test that asserts
the adapter SHAPE is right, and leave the actual model swap to the fold-
into-ytsejam plan where it can use ytsejam's existing pi-ai catalog.

### Task 4.3 — Profile-fact promotion as paraphrase fallback

Independent of embedder choice: a planted preference / directive /
identity that landed in the SEMANTIC profile is already a paraphrase win
(the slot-aware retrieval surfaces it). Make this explicit: when
retrieval finds NO episodic match for a query but the query touches a
semantic-profile predicate (via a small predicate-keyword map: "name" →
identity, "employer/work/job" → works_at, "allergic/allergy/can't eat" →
attribute), surface the profile fact directly as a synthetic memory item.

This recovers `allergy` and `home-city` from the paraphrase probes
without any embedder change.

### Task 4.4 — Re-baseline thresholds with semantic eval

Once Tasks 4.1–4.3 land, re-run `npm run eval:sweep` with `:semantic` mode
across all 20 seeds and 3 bands. Raise the paraphrase recall threshold in
Task 1.2 to whatever the actual achieved number is, MINUS 5 percentage
points for headroom. Commit the new thresholds in the same PR as the
re-baselining; this freezes the bar at what the system actually does, not
what we hoped.

---

## Phase 5 — Operational fitness

What separates a research artifact from a thing I'd run.

### Task 5.1 — A `ltm` CLI

`bin/ltm` with subcommands:

- `ltm ingest <sessions-dir>` — incremental ingest, prints report.
- `ltm retrieve <query>` — runs retrieval, prints ranked items + profile.
- `ltm explain <query>` — `explain()` with full breakdown table.
- `ltm profile` — current profile dump.
- `ltm consolidate` — run the maintenance pass.
- `ltm redact --entity <name>` / `--session <id>` / `--pattern <re>`
- `ltm stats` — store size + retention summary.
- `ltm export > dump.json`

Configured via `LTM_STORE_DIR` env or `--store-dir` flag. This is what
makes the system inspectable without writing a script every time.

### Task 5.2 — A `ltm doctor` subcommand

`ltm doctor` checks store health:

- JSONL files are well-formed (one line per record, every line parses).
- No latest-wins fold conflicts that look like collisions (multiple
  records with the same id at the same timestamp).
- `ingest-state.json` references actually exist.
- Redaction audit log has no orphans (entries referencing non-existent
  records).
- Vector dimensions are consistent across all embeddings.
- Reports findings; `--fix` opportunistically compacts logs + rebuilds
  ingest-state from on-disk truth.

This is the file I want to run after any "memory weirdness" report.

### Task 5.3 — Observability — per-retrieval JSONL log

Optional: when `LTM_RETRIEVAL_LOG=/path/to/file` is set,
`MemorySystem.retrieve` appends a JSONL line per call with `{at, query,
k, returned[{id, score, breakdown}]}` — same shape `explain()` returns.
This is the trace that lets me debug "why didn't it surface that?" on
real ytsejam usage post-fold, without needing to instrument the calling
code.

### Task 5.4 — README rewrite to match what the system actually does

After Phases 1–4 land, the README's eval numbers are obsolete. Rewrite to:

- Show the per-band eval table with actual current numbers.
- Distinguish HashEmbedder-default (lexical) from semantic-eval mode
  (LocalEmbedder).
- Document the optional dependencies and what each unlocks.
- Add a "When NOT to use this" section: single-tenant, single-writer,
  ~10⁴ records, ytsejam-session-format only, no streaming retrieval.
- Add a "What's stable / what's PoC-line" table mapping each module to its
  maturity.

### Task 5.5 — A bench harness

`npm run bench` measures: ingest throughput (turns/sec), retrieval
latency (p50/p99 at corpus sizes 100/1k/10k records), consolidation time
per 1k records. Writes `bench-report.json`. Catches the "we accidentally
made retrieval O(n²)" regression that pure-correctness tests won't.

Initial thresholds: ingest ≥ 500 turns/sec; retrieve p99 ≤ 50ms at 10k
records (with HashEmbedder). LocalEmbedder is allowed an order of
magnitude slower.

---

## Phase 6 — Pre-fold readiness

Only after Phases 1–5 are green. NOT shipping the fold — preparing the
ytsejam fold plan with the experience earned.

### Task 6.1 — Fold gap document

`docs/FOLD-GAP.md` (a new doc, separate from this plan): what changes when
ltm becomes `server/src/ltm/` in ytsejam. Topics:

- Public surface — does anything need to move/rename?
- The `Embedder` swap — point at ytsejam's pi-ai model catalog; what's
  the cost-per-1k-turns at the current production traffic shape?
- Where the `agent_end` hook fires; what the per-turn ingest cost
  budget is.
- Consolidation cadence — slot into the existing housekeeping skill or
  separate cron?
- API routes for inspect/explain/redact — propose REST shapes.
- Migration path for existing ytsejam users — ltm starts empty by
  design (cog memory remains its own subsystem); how does the user
  opt in?

This doc is the input to the future `/brainstorm` session that produces
the actual fold plan + design.

### Task 6.2 — Workspace-package extraction

Move `ltm/` to a workspace package shape (`packages/ltm/` if the eventual
ytsejam fold uses workspaces, or keep at `~/projects/ltm/` and publish as
a private npm package via `npm pack`). The fold integration imports
from the package, not a source path. This means the eval can keep running
standalone after the fold, and a regression caught in ytsejam can be
fixed + tested in ltm in isolation.

If ytsejam doesn't use workspaces (verify), skip the workspace shape; do
the npm pack alternative.

---

## Estimated shape

| phase | tasks | shape                              |
|-------|-------|------------------------------------|
| 1     | 4     | Make the eval honest               |
| 2     | 7     | Fix silent bugs                    |
| 3     | 5     | Adversarial tests                  |
| 4     | 4     | Make paraphrase actually work      |
| 5     | 5     | Operational fitness                |
| 6     | 2     | Pre-fold readiness                 |
| TOTAL | 27    | ~27 PRs                            |

Order: 1 → 2 → 3 → 4 → 5 → 6. Within a phase, tasks can run in any order
as long as the gate stays green. Phase 4 SHOULD wait until Phase 1.2 (the
paraphrase probe) lands so the impact is measurable.

## Definition of done for this whole plan

I can:

1. Drop ltm into ytsejam, point it at `~/.ytsejam/data/sessions`, and have
   `composeContext` add useful memory to my system prompt within a turn
   end-to-end.
2. Run `ltm explain "what does Brian think about meetings?"` and read a
   ranked, scored, breakdown-annotated answer that I can sanity-check.
3. Run `ltm redact --entity "<thing I regret typing>"` and have it
   actually be gone from disk, retrieval, profile, and audit, with the
   audit log proving it without re-leaking.
4. Trust the eval numbers in the README mean what they say across at
   least three horizons and two probe styles, at 20 random seeds.
5. Read `docs/FOLD-GAP.md` and know exactly what the next plan needs to
   decide.

If any of those five aren't true at the end, the plan failed and I should
write a follow-up.

---

_Mentat, 2026-06-12. Filed at the root of `~/projects/ltm/` per Brian's
request after a one-shot evaluation by the Claude Fable model._
