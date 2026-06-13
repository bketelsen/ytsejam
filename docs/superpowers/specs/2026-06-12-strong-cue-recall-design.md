# Strong-cue recall — design

Date: 2026-06-12
Status: approved (Brian, this session)
Branch: feat/strong-cue-recall

## Problem

Real embeddings (OllamaEmbedder, PLAN-OLLAMA) lift paraphrase recall only
on the short band (hash 75% → nomic 75–100% by seed). Medium/long
paraphrase recall is 0% with every embedder. Root-cause analysis against
the medium-band eval store (`.eval/medium/store`, "sister Alice" probe)
found three stacked policies, not an embedding-quality limit:

1. **Consolidation excludes the verbatim turn.** The planted turn is
   `state: consolidated`; `Retriever.admit()` drops consolidated records
   from both indexes and `rank()` skips them. The fact text survives in
   one extractive summary, but that summary is old and semantically
   diluted (multi-topic), so it loses on ranking.
2. **Cosine compression buries strong matches.** The vector channel is
   normalized by pool max (`cos / poolMax`, retriever.ts). Real-embedder
   cosines cluster tightly, so the best match beats distractors by ~0.02
   after normalization — less than the 0.08 recency weight. A perfect
   vector match earns 0.30 total (weights: vector 0.3, lexical 0.4,
   recency 0.08, salience 0.07, graph 0.15) while a fresh mediocre
   distractor sums to ~0.38.
3. **The profile fact decays just below the slot-promotion floor.**
   `rel_sister=Alice` sits at effective strength ~0.18 vs the 0.2 floor
   at the 24-month horizon. `promoteFacts()` only sees the floor-filtered
   `ProfileSummary`, so the slot machinery that delivers short-band
   paraphrase recall (6/8 probes are slot-shaped) goes dark.

All the data is still present (consolidated record text + embedding;
`facts.jsonl` fact). This is a ranking/policy problem.

## Decisions (made with Brian)

- **Goal:** a direct question is a strong retrieval cue and may recall
  decayed/consolidated memories. Decay continues to govern what surfaces
  *unprompted*. (The eval already encodes this split: identity/directive/
  preference/stability metrics are computed from the floor-filtered
  profile, not from question probes — those assertions stay untouched.)
- **Mechanisms:** both slot-driven (works with HashEmbedder) and
  vector-driven (where real embeddings earn their keep).
- **Side-effects of resurrection:** (a) counts as rehearsal — half-life
  stretches via the existing access mechanisms; (b) resurfaced items are
  marked stale with provenance so consumers can say "you told me in
  Jan 2026…" rather than asserting currency.

## Design

### 1. Slot recall below floor

- `summarizeProfile()` (src/semantic/store.ts) gains an optional dormant
  section: active facts that failed their floor. Floors stay applied in
  exactly one place.
- `promoteFacts(query, profile, { dormant })` (src/retrieval/promote.ts):
  when a slot keyword fires and no above-floor fact fills the predicate,
  promote the strongest dormant fact for it with `stale: true`. Rendered
  text carries age: `"The user's sister is named Alice (last mentioned
  2026-01-05)."`
- Queries with no slot keyword never touch dormant facts — unprompted
  composition is unchanged.
- Keyword-map addition: `project → works_on` (one of the 8 eval probes
  is currently unmapped).
- Rehearsal: `SemanticFact` gains optional `recallCount` (default 0,
  additive to facts.jsonl — no migration), bumped when a dormant fact is
  promoted. Effective strength's half-life stretches with `recallCount`
  mirroring the episodic `(1 + accessBonus × accessCount)` term: facts
  you keep asking about climb back above the floor; ignored ones fade.

### 2. Vector resurrection of consolidated turns

- `Retriever.admit()` keeps consolidated records (with embeddings) in
  the **vector** index. Lexical stays excluded: verbatim-word queries
  already reach the summaries; resurrection is the semantic path.
- In `rank()`, a consolidated candidate survives the state filter iff
  its raw cosine is a clear outlier over the candidate pool: z-score ≥
  `config.resurrectZ` (new knob; default calibrated by measurement
  during implementation). Pools with ~zero cosine variance never
  resurrect (guard against degenerate/hash-sparse pools).
- Survivors score normally, are marked `stale: true`, and take an
  `accessCount` bump through the existing rate-limited
  `EpisodicStore.access()` path — a resurrected memory decays slower
  next time.
- `includeConsolidated` callers see no behavior change.

### 3. Vector channel normalization

- Replace pool-max ratio with mean-relative spread:
  `(max(0, cos) − poolMean) / (poolMax − poolMean)`, clamped to [0, 1]
  (poolMean over the non-negative pool cosines). The pool's best
  semantic match earns the full vector weight; typical distractors earn
  ~0. Applies to `vectorById` and the fallback per-record cosine path in
  `rank()`.
- Load-bearing for §2: a resurrected turn has no recency/salience left
  and must win on vector alone.

### 4. Surface

- `RetrievedMemory` gains optional `stale?: boolean`, set by both recall
  paths. `PromotedFact` construction sets it for dormant promotions.
- `ltm explain` / retrieval trace show the flag.
- No store-format migrations.

### 5. Eval and thresholds

- Untouched by design: identity, directive, preference F1, stability
  (all profile-based; decay-bites assertions on the long band keep
  holding).
- Paraphrase and plain probes benefit. Expected after re-baseline
  (measured minus 5pp; the 20-seed sweep gate must hold):
  - medium/long paraphrase ≈ 75% with hash (6/8 slot-recoverable),
  - ≈ 100% with Ollama (vector resurrection recovers guitar/marathon,
    the episodic-only pair).
- `eval:ollama` then gets a justified raised medium/long paraphrase
  threshold — the assertion PLAN-OLLAMA wanted but measurement denied.
- New negative assertion: dormant facts must NOT appear for generic
  (slot-free) queries — floors still bite unprompted.

### 6. Testing

TDD per component:
- dormant promotion: below-floor fact promoted on slot query with
  `stale: true` + rendered age; NOT promoted on generic query; above-floor
  fact preferred over dormant when both exist.
- resurrection: synthetic embeddings — clear outlier resurrects;
  mid-pool consolidated record does not; zero-variance pool does not;
  accessCount bumped; `stale` set.
- normalization: unit tests over known pools (compressed cluster vs
  spread), fallback path included.
- rehearsal: repeated slot asks raise a dormant fact back above the
  floor; unasked control fact keeps fading.
- end-to-end: full eval re-baseline (hash + ollama + 20-seed sweep) and
  bench (vector index grows by consolidated records; thresholds verify).

## Out of scope

- Reranker integration, batched embeds (PLAN-OLLAMA out-of-scope list).
- Lexical resurrection of consolidated turns.
- LLM-based question/intent classification — slot keywords + vector
  z-score are the cue detectors.
- Changing consolidation itself (summary quality is a separate lever).
