# Design: cog-LTM bridge

**Date:** 2026-06-13
**Status:** Approved (design memo — see `~/projects/ltm/COG-LTM-COMBINATION.md`
for the full architectural argument and Fable's review notes)
**Branch (intended):** `feat/cog-ltm-bridge` (per-PR branches under this roof)

## Summary

Wire ytsejam's two memory substrates — **cog** (deliberative; markdown
hot-memory + observations + entities + threads) and **LTM** (experiential;
JSONL turn ingest with decay, consolidation, semantic extraction, vector
retrieval, strong-cue recall) — through a thin two-direction bridge that
makes them complementary instead of redundant. Neither substrate changes
its storage layout; both keep their existing read APIs; the bridge is
100% additive.

Three bridges, three PRs (plus PR 0 for workspace plumbing). Each is
useful alone, in this order: Bridge 1 (cog → LTM ingest), Bridge 3
(unified `recall(query)` read surface), Bridge 2 (LTM → cog fact
promotion via `/reflect`).

## Background

Cog and LTM are the two halves of human memory built from opposite sides:

- **Cog** is what you deliberately wrote down: high signal, low volume,
  cross-domain narrative, SSOT, indefinite retention, slow consolidation
  via `/reflect`. Optimized for "what do I believe about X?"
- **LTM** is what was experienced: every turn, decay-shaped, semantic
  extraction, vector retrieval, fast consolidation. Optimized for
  "where did we discuss X?"

Each can answer questions the other cannot. They've been built in
isolation; the bridge makes them addressable as a single recall surface.

### Why "bridge, not fold"

Folding LTM into cog (or vice versa) was rejected as a substrate-swap
that fails the harness-check gate by default (`cog-meta/patterns.md` —
"ytsejam is the final shape of the harness"). The bridge is small, both
substrates remain inspectable in their native shape, and the only
ytsejam-side code is the wiring.

Two architectural alternatives were considered and rejected in
`~/projects/ltm/COG-LTM-COMBINATION.md`:

- **Option A** — LTM as cog's backing store. Substrate-swap; loses
  markdown editability; fails harness gate.
- **Option B** — Cog as authoring layer on top of LTM. Subtler
  substrate-swap; couples deliberative writes to LTM availability.
- **Option C (recommended, this design)** — bridges in both directions,
  neither substrate sees the other as authoritative.

### LTM-side enablers already shipped

Five SEAM commits landed on LTM main (`~/projects/ltm` at `3631358`) to
shrink the bridges from ~500 LOC across 3 PRs (original estimate) to
~280 LOC across 4 PRs:

- **SEAM 2** — per-kind episodic half-life
  (`DecayConfig.halfLifeDaysByKind`). Defaults `{observation: 730}` so a
  backdated cog observation doesn't pre-decay to retention ~10⁻⁷ on
  arrival. Bridge 1 prerequisite.
- **SEAM 3** — `EpisodicRecord.tags?: string[]` + `retrieve({filterTags})`
  for domain scoping. Bridge 1 + Bridge 3 use it.
- **SEAM 4** — `kind: "observation"` added to `EpisodicKind`;
  `MemorySystem.recordObservation({text, timestamp, tags?, origin?, salience?})`.
  Content-addressed id (`obs-<sha256(text+timestamp)[:12]>`) → idempotent
  re-record. The single LTM call Bridge 1 needs.
- **SEAM 5 (a)** — `RedactionSelector.originPrefix` for cog-side
  provenance cascade (`mem.redact({originPrefix: "cog:personal/"})`
  tombstones the LTM record and cascades to extracted facts). Consolidation
  exemption for `kind === "observation"` so deliberate writes don't get
  folded.
- **SEAM 5 (b)** — fact-idempotent re-ingest: re-recording the same
  observation does NOT bump `mentionCount` or `strength` on extracted
  facts. The seam-loop defense (prevents Bridge 1 ↔ Bridge 2 infinite
  promotion).

All five are tested in `test/observation.test.ts` on LTM main.

## Goals

- **Bridge 1**: every cog observation also lands in LTM as
  `kind: "observation"`, gaining a semantic search surface over Brian's
  deliberate writes.
- **Bridge 2**: when LTM turn-extracted facts cross a stability gate,
  `/reflect` surfaces them as proposed cog observations for human review
  and promotion.
- **Bridge 3**: a single `recall(query)` agent tool returns interleaved
  results from both substrates, labeled by source.
- **No substrate change**: markdown stays markdown; JSONL stays JSONL;
  both substrates' existing read/write paths keep working untouched.
- **No silent loops**: Bridge 1 re-ingesting Bridge 2's output must be a
  true no-op (already enforced by SEAM 5 fact-idempotency).
- **Redaction cascades**: `cog_clear personal/` → LTM records + their
  extracted facts gone (already enforced by SEAM 5 originPrefix).

## Non-goals

- **Not a unified score across substrates.** LTM returns cosine
  similarity, cog returns BM25-ish text match; combining them into a
  single number is a fudge. Bridge 3 interleaves top-k per source instead.
- **Not auto-promotion to cog.** Bridge 2 surfaces candidates during
  `/reflect`; Brian confirms. Auto-write would erode trust in cog's
  human-curated property.
- **Not real-time fact-promotion notifications.** Bridge 2 batches on
  `/reflect`'s weekly cadence. Event-driven is a v2 consideration only if
  weekly batching proves too lossy in practice.
- **Not a domain auto-classifier for promoted facts.** Bridge 2 v1 uses
  a small heuristic table (`works_at` → `work/`, `lives_in` → `personal/`)
  and falls back to `pkb/proposed.md` for the unsure cases; Brian re-files
  manually if needed.

## Architecture

### Bridge 1 (cog observation → LTM `recordObservation`)

```
┌─────────────────────────────┐                ┌──────────────────────┐
│  cog_append observations.md │ ────────────► │  parse line          │
│  ("- 2026-06-13 [tag]: x")  │  inline       │  → recordObservation │
└─────────────────────────────┘  best-effort  │  (LTM)               │
                                              └──────────────────────┘
                                                       ▲
┌─────────────────────────────┐                       │
│  periodic reconciler        │ ──────────────────────┘
│  (catches missed writes)    │  every N minutes
└─────────────────────────────┘
```

- New file `server/src/memory/bridge/ltm-observer.ts` (~50 LOC).
- Hooks the existing `cog_append observations.md` write path in
  `server/src/memory/index.ts`. Inline best-effort; LTM unavailability
  must NOT block cog writes.
- Parse cog observation line shape `- YYYY-MM-DD [tags]: <text>` →
  `{text, timestamp: <iso of YYYY-MM-DD T00:00:00.000Z>, tags}`.
- Compute `origin: "cog:<domain-path>/<filename>#<line-content-hash>"`.
  Content-addressed (not line-number — markdown drifts when you edit
  above a line).
- Call `mem.recordObservation({text, timestamp, tags, origin, salience: 0.85})`.
- Reconciler: periodic process (probably 5-min cadence) re-tails the
  observations.md files, recomputes content hashes, and replays any line
  that LTM doesn't have. Catches drift if LTM was down during an inline
  write.
- One-shot replay script: on first install, walks every
  `~/.ytsejam/data/<domain>/observations.md` and seeds LTM from existing
  content.

### Bridge 2 (LTM fact promotion → cog observation via `/reflect`)

```
┌─────────────────────────┐  weekly  ┌─────────────────────────┐
│ /reflect run            │ ───────► │ listFacts().filter(gate)│
└─────────────────────────┘          └─────────────────────────┘
                                                │
                                                ▼
┌─────────────────────────────┐    ┌─────────────────────────┐
│ Brian confirms in /reflect  │ ◄─ │ render as proposed      │
│ review flow                 │    │ observation lines       │
└─────────────────────────────┘    └─────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────┐
│ write to <inferred-domain>/observations.md      │
│ + mem.markPromoted(factId, observationOrigin)   │
└─────────────────────────────────────────────────┘
```

- New file `server/src/skills/reflect/ltm-promotions.ts` (~150 LOC plus
  /reflect skill markdown updates).
- **Promotion gate** (corrected from original COG-LTM-COMBINATION.md
  memo per Fable's Correction #3): `mentionCount ≥ 3` AND
  `distinct sessions ≥ 2` AND `first-seen span ≥ 14d`. NOT `recallCount`
  (which only bumps on below-floor recalls — would exclude the always-
  above-floor stable patterns we're trying to find).
- LTM needs two small additions:
  - `SemanticFact.promotedAt?: string` so already-promoted facts are skipped
  - `MemorySystem.markPromoted(factId, origin: string): void` setter
- Domain inference: small heuristic table by predicate. Unsure cases go
  to `pkb/proposed.md` for manual re-filing. The table edits in place as
  patterns accrue.
- Loop defense is already structural: when Bridge 1 then re-ingests the
  cog observation that Bridge 2 just produced, SEAM 5's fact-idempotent
  re-record absorbs it (`mentionCount` doesn't accrue past the first
  sight of the obs-id).

### Bridge 3 (unified `recall(query)` agent tool)

```
                ┌──────────────────────────────────┐
                │ tool: recall(query, opts?)       │
                └──────────────────────────────────┘
                       │              │
                       ▼              ▼
        ┌─────────────────┐    ┌─────────────────┐
        │ mem.retrieve()  │    │ cog_search()    │
        │ top-k from LTM  │    │ top-k from cog  │
        └─────────────────┘    └─────────────────┘
                       │              │
                       └──────┬───────┘
                              ▼
                  interleave + dedupe + label
                              │
                              ▼
            ┌──────────────────────────────────┐
            │ items: [{from, text, where, ...}]│
            └──────────────────────────────────┘
```

- New file `server/src/memory/recall.ts` (~80 LOC) + tool registration.
- Interleave top-k from each source (per Fable's Correction #7 — no fake
  unified score; sources rank in their own space).
- Each item carries `from: "ltm" | "cog"`, source-relative `score`,
  `where` (session-id+entryId for LTM, path#section for cog), optional
  `stale: true` passthrough for LTM dormant-section results, optional
  `tags`.
- Filter pass-through: `recall(query, {filterTags: ["projects:ytsejam"]})`
  scopes both sides (LTM via SEAM 3 filterTags; cog via domain path
  prefix).
- Dedupe heuristic: skip cog items whose text appears verbatim as an LTM
  observation already (Bridge 1 produces these — surfacing both is
  redundant). Keep the cog item, drop the LTM duplicate (cog has the
  better `where`).

## Implementation order

1. **PR 0 — workspace plumbing** (~1 day). Adds `~/projects/ltm` as a
   workspace dependency of ytsejam. Smallest reversible change first;
   unblocks PR 1-3.
2. **PR 1 — Bridge 1** (~1-2 days). Most useful single bridge; LTM gains
   the deliberate-writes surface; gives Bridge 2 the data to chew on.
   Ship + bake for ~2 weeks before PR 2.
3. **PR 3 — Bridge 3** (~1 day). Wait, PR 3 before PR 2? Yes: Bridge 3
   makes Bridge 1's value visible to the agent ("ask one question, get
   both narratives and turns"). Bridge 2 needs more bake-time data
   anyway, and the gate threshold should be tuned on real signal.
4. **PR 2 — Bridge 2** (~2-3 days). Last because once you've used the
   unified recall for a few weeks, you'll have better signal on which
   facts deserve promotion vs which are noise.

Total: ~280 LOC across 4 PRs, ~5-7 days of work.

## Open questions / risks

- **PR 0 packaging shape**: npm workspace move-or-symlink vs
  `"ltm": "file:../ltm"` local file dep. Recommend file-dep first — zero
  ytsejam restructure. If we end up needing tighter integration later,
  promote to workspace then.
- **Bridge 1 reconciler placement**: ytsejam server process (existing
  lifecycle, no new systemd unit) vs separate process (isolation, can
  crash without taking ytsejam down). Recommend ytsejam-process v1; revisit
  if LTM ingest CPU cost is noticeable.
- **LTM corruption response**: Bridge 1 should fail-loud on writes
  (so the operator notices LTM is broken), fail-quiet during reconcile
  (so a transient failure doesn't spam logs).
- **cog domain rename migration**: when `personal/` is renamed (e.g. to
  `personal-archived/`), existing LTM records carry `origin: "cog:personal/..."`
  selectors that no longer match the live cog tree. Probably needs a
  one-shot migration tool: `mem.renameOrigin(oldPrefix, newPrefix)`.
  Defer to PR 1 implementation phase — design call once the data shape
  is real.
- **Bridge 2 promotion-gate tuning**: `mentionCount ≥ 3` and
  `distinct sessions ≥ 2` and `span ≥ 14d` are starting points. Real
  values come from looking at the first month of LTM data and picking
  thresholds where the candidate list is review-able (~10-30 per
  /reflect run feels right). Punted to PR 2's brainstorm phase.

## Success criteria

After all four PRs merge:

- Writing `cog_append personal/observations.md "- 2026-06-13 [home]: bought a new couch"` makes the line retrievable from LTM via `mem.retrieve("when did I buy furniture")` within seconds.
- Running the unified `recall("fold-cogmemory cutover")` agent tool returns the cog dev-log entry AND the LTM turns where we discussed the cutover at the time, interleaved.
- Running `/reflect` on a memory that has been ingesting for ≥14 days surfaces a Top-N list of facts to promote; confirmed ones land in the inferred domain's observations.md AND get marked in LTM so they don't re-appear next week.
- `cog_clear` of a domain cascades to LTM records and their extracted
  facts via `mem.redact({originPrefix})`.
- Cog gate AND LTM gate both stay green throughout each PR.
