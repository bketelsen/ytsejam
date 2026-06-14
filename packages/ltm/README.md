# ltm

Long-term memory for [ytsejam](../ytsejam) sessions, standalone proof of
concept. Episodic memory with decay/consolidation, semantic memory
(preference graph + entity store), and a hybrid retrieval layer that
surfaces relevant context per turn — operating directly on ytsejam's JSONL
session store (pi v3 format). See [ARCHITECTURE.md](ARCHITECTURE.md) for the
design, [spec.md](spec.md) for the original brief, and [PLAN.md](PLAN.md)
for the hardening plan this code has been through (phases 1–5 complete).

Zero runtime dependencies; Node ≥ 22.6 (runs TypeScript directly).

## Use

```ts
import { MemorySystem } from "ltm";

const mem = MemorySystem.open({ storeDir: "./memory" });

// Ingest the session store (incremental — only new entries are processed).
await mem.ingestSessionDir("/path/to/ytsejam/data/sessions");

// Per turn: a system-prompt-ready block (user profile + relevant memories).
const context = await mem.composeContext("what should I get my sister?", {
  k: 8,
  tokenBudget: 1200,
});

// Maintenance: fold old, faded turns into per-session summaries.
await mem.consolidate();

// User control: inspect, explain, export, forget.
const why = await mem.explain("coffee preferences");
await mem.redact({ entity: "Alice" });   // also: {recordId}, {sessionId}, {pattern}
const audit = mem.auditTrail();          // ids + counts + digests only, never content

mem.close(); // releases the single-writer lock
```

The store is **single-writer**: `open()` takes an advisory lock
(`lock.pid`, stale locks from dead processes are taken over); a second
`open()` of a live store throws. Call `close()` when done.

## CLI

```sh
npx ltm ingest ~/ytsejam/data/sessions   # or: bin/ltm.js …
npx ltm retrieve "what does Brian think about meetings?"
npx ltm explain  "coffee"                # per-channel score breakdowns
npx ltm profile
npx ltm consolidate
npx ltm redact --entity "Alice"          # or --session/--pattern/--record
npx ltm stats
npx ltm export > dump.json
npx ltm doctor [--fix]                   # store health checks / repair
```

Store dir via `--store-dir` or `LTM_STORE_DIR` (default `./memory`). Set
`LTM_RETRIEVAL_LOG=/path/trace.jsonl` to append a per-retrieval trace
(`{at, query, k, returned[{id, score, breakdown}]}`) for debugging "why
didn't it surface that?".

## Commands

```sh
npm test           # vitest suite (unit + adversarial + fuzz + eval thresholds)
npm run check      # tsc --noEmit
npm run eval       # banded eval (short/medium/long horizons), report + exit code
npm run eval:sweep # 20 seeds × 3 bands; fails below 95% per-band pass rate
npm run eval:semantic  # eval with a local sentence-transformer (optional dep)
npm run eval:ollama    # eval against a local Ollama embedding model (no extra install)
npm run eval:copilot   # eval against GitHub Copilot's embeddings endpoint (requires GITHUB_COPILOT_API_KEY)
npm run bench      # ingest/retrieval/consolidation perf with thresholds
npm run fixtures   # generate a synthetic corpus without running the eval
```

## Eval results (HashEmbedder, defaults)

The eval plants facts/preferences/directives/a contradiction in seeded
synthetic corpora (ytsejam session format) across three horizons, ingests
session-by-session with a consolidation pass mid-horizon, and scores at
horizon end. Thresholds are calibrated to measured behavior minus 5pp
headroom and hold across a 20-seed sweep (60/60). Current measured numbers:

| band   | horizon        | recall@5 | paraphrase r@5 | MRR        | pref F1 | directives | identity | stability |
|--------|----------------|----------|----------------|------------|---------|------------|----------|-----------|
| short  | 12 × 14d ≈ 6mo | 100%     | 75%            | 1.00       | 1.00    | 100%       | yes      | 100%      |
| medium | 24 × 30d ≈ 2yr | 100%     | 75%            | 0.75 (min) | 0.33    | 100%       | yes*     | 40%       |
| long   | 24 × 60d ≈ 4yr | 100%     | 75%            | 0.9375 (min)| 0.33   | 0%         | no       | 20%       |

The medium/long erosion is **decay working as designed**, and the test
suite asserts it (a change that silently re-calibrates decay away fails):
preferences fade between reassertions, and identity itself retires at
4 years (\* medium surfaces identity via the configurable
`identityFloor: 0.2` — the long band proves it still retires even at the
lowered floor). The medium and long bands also lower `directiveFloor` to
0.2 symmetrically with `identityFloor`: medium then surfaces
single-assertion directives at 100% (threshold 0.95), while the long band
proves they still retire at ~4 years of disuse exactly like identity.
Episodic recall stays high at every horizon because decay re-ranks, it
never deletes. Decay governs **unprompted** surfacing — profile-based
metrics (pref F1, directives, identity, stability) are unchanged; direct
questions can now recover past the decay floor via strong-cue recall
(see below), returned stale-marked.

Paraphrase probes share no content words with their plants. 75% at short
horizon comes from slot-aware profile promotion (employer/allergy/
residence/relationship questions are answered by semantic slots); the
remaining misses are episodic-only facts that need a real embedder.

### With Ollama (`nomic-embed-text`, default seed)

| band   | recall@5 | paraphrase r@5           | paraphrase range (seeds 0–5) |
|--------|----------|--------------------------|------------------------------|
| short  | 100%     | **100%** (hash 75%)      | 87.5–100%                    |
| medium | 100%     | **88%** (hash 75%)       | 75–100%                      |
| long   | 100%     | **88%** (hash 75%)       | 75–100%                      |

The real embedder lifts exactly where embeddings can matter: the short
band's episodic-only paraphrase misses (75% → 100% on the default seed,
87.5–100% on other seeds vs hash's flat 75%). With strong-cue recall,
medium/long paraphrase rises to 75–88% — consolidated records are resurrected
via a leave-one-out cosine z-score outlier test (`resurrectZ`, default 2.5),
and dormant profile facts are promoted on direct slot questions.
Thresholds are calibrated to measured behavior minus 5pp headroom:
`paraphraseRecallAt5` 0.70, `recallAt5` 0.95, MRR 0.70/0.88 for medium/long.

### Strong-cue recall

A direct question is a strong retrieval cue that can recover memories past
their decay floor, while decay continues to govern unprompted surfacing.

**Slot recall of dormant facts.** Profile facts that fall below their decay
floor land in a `dormant` section. A direct slot question (e.g. "Tell me
about my sibling") with no above-floor answer promotes the strongest dormant
fact, rendered with its age — "The user's sister is named Alice (last
mentioned 2026-01-05)." — with `stale: true`. Generic identity predicates
(name/role) only participate in dormancy recall when they are the query's
sole matched slot, preventing incidental "called"/"name" tokens in unrelated
questions from displacing real answers.

**Rehearsal.** Recalling a dormant fact increments `recallCount` (rate-limited
persistence), stretching the fact's disuse half-life: facts you keep asking
about climb back above the floor; facts you stop asking about keep fading.
Asking is not re-asserting — `lastSeenAt` is untouched, so you cannot
accidentally anchor a stale fact to today.

**Vector resurrection.** Consolidated episodic records remain in the vector
index. A query whose cosine similarity to a candidate is a leave-one-out
z-score outlier (≥ `resurrectZ`, default 2.5) over the candidate pool
resurrects that record into results, marked `stale`. Returned resurrections
take the normal access bump (slower decay next time). Lexical search still
excludes consolidated records. Note: the twin-match ceiling is z≈2.98, so
raising `resurrectZ` above 2.9 will silently break resurrection — don't raise
it casually.

**Mean-relative vector normalization.** The vector channel maps
[pool mean, pool max] → [0,1] instead of cos/max, so tightly clustered
real-embedder cosines stop losing their margins to the recency weight.

**Observability.** Results carry `stale: true` when recalled from dormancy or
resurrection; `ltm explain` marks them `[stale]` / `[consolidated]`;
`LTM_RETRIEVAL_LOG` trace records include the flag. Consumers should phrase
stale-recalled facts historically ("you mentioned last January that…") rather
than as current assertions.

## Embedders

| mode | embedder | properties |
| --- | --- | --- |
| default | `HashEmbedder` (hashed bag-of-words, 256-dim) | deterministic, offline, zero deps; lexical-strength retrieval, weak on paraphrase |
| semantic (optional) | `LocalEmbedder` (`@huggingface/transformers`, e.g. all-MiniLM-L6-v2) | real paraphrase similarity; ~100MB of model + runtime |
| ollama (optional) | `OllamaEmbedder` (`http://localhost:11434`, e.g. `nomic-embed-text`) | real paraphrase similarity via a local Ollama service; zero install if Ollama is already running; 768-dim default; plain `fetch`, no SDK |
| copilot (optional) | `CopilotEmbedder` (https://api.enterprise.githubcopilot.com/embeddings, e.g. `text-embedding-3-small`) | real paraphrase similarity via GitHub Copilot's embeddings endpoint; requires a Copilot OAuth API key; 1536-dim default; plain fetch, no SDK |

If you already run Ollama locally with an embedding model pulled (e.g.
`ollama pull nomic-embed-text`), `npm run eval:ollama` swaps the default
`HashEmbedder` for the live model and caches embeddings on disk so
re-runs are free. No additional install. `--ollama-model` and
`--ollama-url` (or `OLLAMA_BASE_URL`) override the defaults;
`--semantic` and `--ollama` are mutually exclusive. A live smoke test
runs with `LTM_OLLAMA_LIVE=1 npm test`; the default suite stays hermetic
(mocked fetch).

If you have a GitHub Copilot OAuth API key, `GITHUB_COPILOT_API_KEY=... npm run eval:copilot` runs the LTM eval suite against Copilot's `text-embedding-3-small` (1536-dim). `--copilot-model` and `--copilot-url` (or `COPILOT_BASE_URL`) override the defaults; `--semantic`, `--ollama`, and `--copilot` are mutually exclusive. The CachedEmbedder is namespaced by `"copilot:"+modelName`, so re-runs cost nothing.

`@huggingface/transformers` is an **optional** peer dependency — skip it if
you don't need the in-process semantic mode. `npm run eval:semantic`
requires it plus `LOCAL_EMBEDDER_MODEL=<hub-id-or-path>`, and caches
embeddings the same way. Any
`{dimension, embed(text)}` object works as a custom embedder (e.g. an API
embedder at fold time); records carry their vectors, so swapping embedders
means re-ingesting, not migrating.

## Performance (bench, HashEmbedder)

At 10k records: ingest ~21k turns/sec, retrieval p99 5.7ms. `npm run bench`
fails below 500 turns/sec ingest or 50ms p99 at 10k.

## When NOT to use this

- **Multi-tenant memory** — one store models one user; there is no
  isolation between users in a store.
- **Concurrent writers** — single-writer by design (advisory lock enforced).
- **Large corpora** — the vector index is exact/flat; fine to ~10⁴ records,
  swap in ANN behind `VectorIndex` beyond that.
- **Non-ytsejam session formats** — the reader speaks pi v3 JSONL only.
- **Streaming/low-latency-token use** — retrieval is per-turn
  request/response, not streaming.

## Maturity

| module | status |
| --- | --- |
| session reader (pi v3, branch resolution, fork chains) | stable, fuzz-tested |
| episodic store / decay / consolidation | stable; extractive summarizer is the PoC floor (LLM summarizer injectable) |
| semantic extraction heuristics | PoC line: English regex patterns, precision-first; upgradeable to an LLM extractor behind the same candidate shapes |
| retrieval (hybrid + MMR + promotion) | stable; strong-cue recall recovers dormant/consolidated targets on direct questions; decay governs unprompted surfacing |
| redaction / audit | stable, round-trip tested |
| eval harness / sweep / bench | stable |
| LocalEmbedder | shape-tested seam; the Ollama path is the working semantic mode |
| OllamaEmbedder | stable — mocked-fetch tested, live smoke gated behind `LTM_OLLAMA_LIVE=1` |
| CopilotEmbedder | stable — mocked-fetch tested, 401-refresh + network-failure paths covered, live smoke not committed |

## Store layout

```text
<storeDir>/
  episodic.jsonl      # turn/summary records (latest-wins snapshots)
  facts.jsonl         # learned user facts
  entities.jsonl      # observed entities
  redactions.jsonl    # redaction audit log (ids/counts/digests only)
  ingest-state.json   # per-session ingestion progress
  lock.pid            # single-writer advisory lock (while open)
```

JSONL is the source of truth; vector/BM25 indexes and the preference graph
are derived in memory on load. `ltm doctor` checks the store's invariants
and `--fix` compacts/repairs.
