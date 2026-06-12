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
npm run bench      # ingest/retrieval/consolidation perf with thresholds
npm run fixtures   # generate a synthetic corpus without running the eval
```

## Eval results (HashEmbedder, defaults)

The eval plants facts/preferences/directives/a contradiction in seeded
synthetic corpora (ytsejam session format) across three horizons, ingests
session-by-session with a consolidation pass mid-horizon, and scores at
horizon end. Thresholds are calibrated to measured behavior minus 5pp
headroom and hold across a 20-seed sweep (60/60). Current measured numbers:

| band   | horizon        | recall@5 | paraphrase r@5 | MRR  | pref F1 | directives | identity | stability |
|--------|----------------|----------|----------------|------|---------|------------|----------|-----------|
| short  | 12 × 14d ≈ 6mo | 100%     | 75%            | 1.00 | 1.00    | 100%       | yes      | 100%      |
| medium | 24 × 30d ≈ 2yr | 88%      | 0%             | 0.69 | 0.33    | 0%         | yes*     | 40%       |
| long   | 24 × 60d ≈ 4yr | 88%      | 0%             | 0.88 | 0.33    | 0%         | no       | 20%       |

The medium/long erosion is **decay working as designed**, and the test
suite asserts it (a change that silently re-calibrates decay away fails):
preferences fade between reassertions, single-assertion directives are gone
by month 24, and identity itself retires at 4 years (\* medium surfaces
identity via the configurable `identityFloor: 0.2` — the long band proves
it still retires even at the lowered floor). Episodic recall stays high at
every horizon because decay re-ranks, it never deletes.

Paraphrase probes share no content words with their plants. 75% at short
horizon comes from slot-aware profile promotion (employer/allergy/
residence/relationship questions are answered by semantic slots); the
remaining misses are episodic-only facts that need a real embedder.

## Embedders

| mode | embedder | properties |
| --- | --- | --- |
| default | `HashEmbedder` (hashed bag-of-words, 256-dim) | deterministic, offline, zero deps; lexical-strength retrieval, weak on paraphrase |
| semantic (optional) | `LocalEmbedder` (`@huggingface/transformers`, e.g. all-MiniLM-L6-v2) | real paraphrase similarity; ~100MB of model + runtime |

`@huggingface/transformers` is an **optional** peer dependency — skip it if
you don't need semantic eval mode. `npm run eval:semantic` requires it plus
`LOCAL_EMBEDDER_MODEL=<hub-id-or-path>`, raises the medium band's
paraphrase threshold to 0.80, and caches embeddings on disk
(`CachedEmbedder`, SHA-256-keyed) so re-runs are free. Any
`{dimension, embed(text)}` object works as a custom embedder (e.g. an API
embedder at fold time); records carry their vectors, so swapping embedders
means re-ingesting, not migrating.

## Performance (bench, HashEmbedder)

At 10k records: ingest ~16k turns/sec, retrieval p50 5.9ms / p99 11ms,
consolidation ~7ms per 1k records. `npm run bench` fails below
500 turns/sec ingest or 50ms p99 at 10k.

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
| retrieval (hybrid + MMR + promotion) | stable with HashEmbedder; paraphrase quality gated on real embedder |
| redaction / audit | stable, round-trip tested |
| eval harness / sweep / bench | stable |
| LocalEmbedder | seam only — shape-tested, model integration deferred to the ytsejam fold plan |

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
