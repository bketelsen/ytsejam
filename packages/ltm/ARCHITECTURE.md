# LTM Architecture

Long-term memory for `ytsejam`: episodic memory with decay and consolidation,
semantic memory (a preference graph and entity store), and a retrieval layer
that surfaces relevant context per turn. Delivered standalone as a proof of
concept; designed to fold into `ytsejam/server` the way the cog memory module
was (public surface in one `index.ts`, JSONL as source of truth, derived
indexes rebuilt on load).

```
ytsejam session store (pi v3 JSONL)          LTM store (JSONL, latest-wins)
┌──────────────────────────┐                ┌──────────────────────────────┐
│ <dataDir>/sessions/*.jsonl│   ingest      │ episodic.jsonl               │
│  header v3 + entry tree   ├──────────────▶│ facts.jsonl   entities.jsonl │
└──────────────────────────┘   pipeline     │ redactions.jsonl             │
                                            │ ingest-state.json            │
                                            └──────────┬───────────────────┘
                                                       │ load / rebuild
                                                       ▼
                                   derived, in-memory, never persisted
                                   ┌──────────────────────────────────┐
                                   │ vector index (flat cosine)       │
                                   │ BM25 index                       │
                                   │ preference graph (facts + co-occ)│
                                   └──────────┬───────────────────────┘
                                              │ retrieve(query)
                                              ▼
                                   profile + ranked episodic context
```

## Design tenets

1. **JSONL is the source of truth; everything else is derived.** Mirrors
   ytsejam ("sqlite is a derived index"). Each store file is an append-only
   log of full record snapshots, folded latest-wins on read (`JsonlLog`).
   Vector index, BM25, and the preference graph are rebuilt from the logs.
2. **Deterministic, dependency-free core.** No network, no LLM in the loop by
   default. Embeddings come from a pluggable `Embedder` interface whose
   default (`HashEmbedder`) is a deterministic hashed bag-of-words; the
   consolidation summarizer is extractive by default with an injectable async
   LLM hook (`Summarizer`). This keeps the eval reproducible and the library
   runnable offline; production can swap in API embeddings without touching
   the stores (records carry their vectors).
3. **Provenance everywhere.** Every episodic record points at its session
   entry (`sessionId`/`entryId`); every semantic fact and entity carries the
   source turns that asserted it. Redaction is therefore a graph walk, not a
   text search.
4. **Heuristics now, models later.** Preference learning, salience, and
   entity extraction are lexical heuristics behind small interfaces. They are
   the PoC floor, not the ceiling — each can be upgraded to an LLM extractor
   that emits the same candidate shapes.

## Reading the session store

`src/session/format.ts` + `reader.ts`. A ytsejam session file (written by
pi-agent-core) is one JSON object per line:

- line 1: `{type:"session", version:3, id, timestamp, cwd}`
- lines 2+: tree entries `{type, id, parentId, timestamp, …}` — `message`,
  `compaction`, `session_info`, `leaf`, and others.

Entries form a **tree** (edits/retries branch); the active branch is the path
from the latest `leaf` entry's target back to the root (falling back to the
last entry when no `leaf` exists). The reader:

- walks only the active branch — abandoned branches are not memory;
- extracts `user` and `assistant` turns (assistant *text* only; `thinking`
  and tool results are excluded by default, both togglable);
- keeps `compaction` summaries as `summary` turns — distilled history the
  harness already paid for;
- is tolerant: a malformed line becomes a warning, not a failure, because a
  memory pipeline must survive a store with one bad write in it (pi's own
  loader throws; we deliberately do not).

## Episodic memory

`src/episodic/`. One record per turn chunk (`${sessionId}/${entryId}#${i}`);
long turns split on paragraph/sentence boundaries under `maxChunkChars`.

**Salience** (`salience.ts`) — intrinsic worth-remembering in [0,1], assigned
at ingest: user turns > assistant turns; preference/identity markers and
self-disclosures (declarative first-person sentences, e.g. "I picked up my
old Telecaster") score high; task requests ("Can you help me debug…?") score
neutral; filler ("ok thanks") scores ~0.

**Decay** (`decay.ts`) — an exponential forgetting curve whose half-life
stretches with salience and with retrieval accesses (spaced-repetition
flavor):

```
halfLife  = halfLifeDays · (1 + accessBonus·accessCount) · (0.5 + salience)
retention = 2^(−ageDays / halfLife)
```

Retention multiplies the salience term in ranking and gates consolidation.
Decay alone never deletes anything.

**Consolidation** (`consolidate.ts`) — the maintenance pass. Turn records
older than `olderThanDays` whose retention fell below `retentionFloor` are
grouped per session and folded into one `consolidated` summary record. The
default summarizer is extractive: sentences scored by salience, entity
density, preference markers, and self-disclosure, kept in chronological order
under `maxSummaryChars`. Children move to state `consolidated` — out of
default retrieval but retained for provenance and inspection. The summary
inherits the group's max salience and most recent timestamp.

## Semantic memory

`src/semantic/`. Two persisted stores and one derived graph.

**Facts** (`facts.jsonl`) — durable statements about the user, learned from
user turns only, keyed by `(kind, predicate, normalized object, polarity)`:

| kind       | predicate            | example trigger                       |
|------------|----------------------|---------------------------------------|
| identity   | `name`, `role`       | "my name is Brian", "I'm a developer" |
| preference | `prefers` (±1)       | "I love dark roast" / "I hate X"      |
| directive  | `directive` (±1)     | "please always/never …", "from now on"|
| attribute  | `uses`, `works_at`, `works_on` | "I use vim", "I work at Initech" |

Belief dynamics:

- **Reinforcement**: re-assertion moves strength asymptotically toward 1
  (`s′ = 1 − (1−s)(1−0.4)`) and appends the new source turn.
- **Contradiction**: an opposite-polarity assertion about the same normalized
  object — or a new value for a single-valued slot (`name`, `role`,
  `works_at`) — marks the older fact `supersededBy` the newer one. Newest
  statement wins; re-assertion revives.
- **Disuse decay** at read time: effective strength halves per
  kind-specific half-life (preferences 120d, attributes 180d, identity and
  directives 365d — slot-like facts are stated once and expected to stick).
  Facts below the profile floor stop surfacing without being deleted.

**Entities** (`entities.jsonl`) — people (via relationship phrases: "my
sister Alice"), tech terms (lexicon), code spans, paths, URLs, emails, and
capitalized n-grams (stoplist-filtered), with mention counts and sources.

**Preference graph** (`graph.ts`) — derived on load, never persisted: the
user node connects to entities through fact edges (weight = strength); entity
pairs co-occurring in a turn get `co_occurs` edges. Retrieval runs one round
of spreading activation from the query's entities; episodic records
mentioning activated entities get a graph boost. Deriving (not storing) the
graph means redaction can never leave a stale edge.

## Retrieval layer

`src/retrieval/`. Per query: candidates from the vector index (flat cosine
over `HashEmbedder` vectors), BM25 (stopword-filtered — chat queries are
question-shaped, so interrogatives carry no signal), and graph activation.
Each candidate scores:

```
score = 0.30·cosine + 0.40·bm25 + 0.08·recency + 0.07·salience·retention + 0.15·graph
```

Content match dominates by construction; recency and salience are
tie-breakers that cannot outvote an exact term match. The ranked list is
re-ranked with MMR (λ=0.7) for diversity, packed greedily into a token
budget, and returned with a full per-channel `ScoreBreakdown` — the same
numbers `explain()` shows the user. Surfaced records get an `accessCount`
bump, which slows their decay.

`composeContext()` renders a system-prompt-ready block: the profile first
(identity, attributes, preferences, standing directives), then episodic
memories with dates. The profile-first ordering matters: identity/attribute
questions ("where do I work?") are answered by semantic memory; episodic
memory is for events.

## Inspection & redaction (user control)

`MemorySystem` exposes the full surface: `listEpisodic`/`listFacts`/
`listEntities`/`getRecord` (raw stores), `explain(query)` (ranked candidates
with score breakdowns, read-only), `stats()`, and `export()` (full dump,
embeddings stripped).

`redact(selector)` accepts `{recordId}`, `{sessionId}`, `{entity}`, or
`{pattern}` and propagates:

1. matching episodic records become tombstones — text and embedding
   destroyed, id/provenance retained — and the log is **compacted
   immediately** so the content doesn't survive in superseded JSONL lines;
2. semantic facts/entities lose the matching source turns; with no remaining
   evidence they are redacted outright (logs compacted likewise);
3. consolidated summaries containing a redacted child are themselves redacted
   and rebuilt from the surviving children;
4. an audit event is appended to `redactions.jsonl` — ids and counts only;
   entity names and patterns are logged as SHA-256 digests, because the
   selector itself is the content the user asked to forget.

Redacted entities stay forgotten: re-ingesting the same sessions will not
resurrect them (the tombstone wins; ingest state already marks the turns
processed).

## Evaluation harness

`src/eval/`. `synthetic.ts` generates a corpus in the exact pi-v3 format from
a seeded PRNG: a persona (8 facts, 4 preferences, 2 directives, 1
mid-horizon contradiction, an identity) planted across 12 sessions / ~6
months among distractor chatter, with ground truth recording where everything
lives. `harness.ts` ingests session-by-session (snapshotting the profile
after each), runs a consolidation pass two-thirds through, then scores:

- **Recall quality**: every planted fact probed (recall@1/@5, MRR). A probe
  counts when the answer surfaces in the context the assistant would get —
  episodic items at their rank, or profile facts (which composeContext places
  first, i.e. rank 1).
- **Personality mirroring**: preference precision/recall/F1 against the
  planted persona, directive recall, identity correctness, contradiction
  resolved to the latest statement, and **stability** — once a preference is
  learned it must persist with the right polarity through every later
  snapshot.

`npm run eval` runs three horizon bands (short ≈ 6mo, medium ≈ 24mo,
long ≈ 48mo) with per-band thresholds calibrated to measured behavior, a
paraphrase probe set per fact, and `npm run eval:sweep` re-checks 20 seeds.
The medium/long bands deliberately measure the regime where decay bites
(preferences fading between reassertions, identity retiring at 4 years) and
the test suite asserts those erosions as correct behavior. See the README
for the current per-band numbers and PLAN.md Phase 1/4 for the calibration
rules.

## Integration sketch (ytsejam) — status

Most of this sketch shipped by 2026-06-15. Annotated for current state:

- ✅ **Workspace package** (shipped 2026-06-12): published as `packages/ltm`,
  `MemorySystem` is the public surface, opened against `<dataDir>/ltm/`. The
  ytsejam server holds the single-writer lock.
- ✅ **Ingest on `agent_end`** (shipped 2026-06-15): the manager calls
  `ingestSessionFile(path)` after each chat-session `agent_end`; the task
  manager mirrors this for subagent sessions on `run()` completion. Late-bind
  via `ltm: () => memory.getLtm()` thunk so the call is a no-op if LTM is
  detached. Subagent transcripts are caught by the same `sessions/` walk used
  for chat — task-event JSONL is intentionally NOT ingested (event metadata
  isn't conversation).
- ⏸ **`composeContext(latestUserText)` in the system prompt** — DEFERRED
  pending Friday 2026-06-19 review of real ingested data. The plan was to
  call it next to `cogBrief.promptSection()`, but choosing between always-on
  vs tool-call-only vs scoped-by-task is gated on the question "what does
  LTM actually retrieve when populated?" — answerable only after the
  backfill below has run.
- ✅ **`consolidate()` on housekeeping cadence** (shipped 2026-06-15):
  `memory.consolidateLtm()` exposed as `cog_rpc("consolidate_ltm")`, called
  from the `/housekeeping` skill. Folds episodic snapshots into thematic
  summaries.
- ⏸ **`explain`/`export`/`redact` API routes** — not in this PR. The
  memory module is single-writer so a UI panel would need to go through
  the server's existing memory API surface; deferred until there's a UI
  consumer.

### Operational surface added this PR

- **Admin HTTP routes** at `POST/GET/DELETE /api/admin/ltm-backfill[/:jobId]`
  drive a rate-limited `BackfillJob` that walks a JSONL directory and feeds
  each file through `ingestSessionFile`. Single-job slot per server process;
  POST returns 409 if a job is already running.
- **`ytsejam ltm backfill <dir>`** CLI subcommand wraps those routes for
  one-off use from a shell. Defaults: rate=2 turns/sec, batch=10 files,
  pause=2000ms, poll=5000ms. SIGINT cancels via DELETE. Requires the server
  to be RUNNING (opposite of `ltm replay`/`health`, which need it stopped).

## Known limits (PoC line)

- `HashEmbedder` is lexical; paraphrase recall leans on BM25 + the graph.
  Swap in a real embedder for semantic paraphrase matching — the interface
  and stores already accommodate it.
- Fact extraction is English-pattern-based; it under-extracts (by design —
  precision over recall, spurious facts are worse than missed ones).
- The flat vector index is O(n) per query; fine to ~10⁴ records, swap for ANN
  behind `VectorIndex`'s surface beyond that.
- Consolidation summarizes per session; cross-session thematic consolidation
  (one summary per *topic*) is the natural next step and slots in as another
  `Summarizer` strategy.
