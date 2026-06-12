# ltm

Long-term memory for [ytsejam](../ytsejam) sessions, standalone proof of
concept. Episodic memory with decay/consolidation, semantic memory
(preference graph + entity store), and a hybrid retrieval layer that surfaces
relevant context per turn — operating directly on ytsejam's JSONL session
store (pi v3 format). See [ARCHITECTURE.md](ARCHITECTURE.md) for the design;
[spec.md](spec.md) for the original brief.

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
const audit = mem.auditTrail();          // ids + counts only, never content
```

Custom embedder (the default is a deterministic, offline hashed
bag-of-words) and LLM summarizer hook:

```ts
const mem = MemorySystem.open({
  storeDir,
  embedder: { dimension: 1536, embed: (text) => myEmbeddingApi(text) },
  summarizer: (records, maxChars) => myLlmSummarize(records, maxChars),
});
```

## Commands

```sh
npm test           # vitest suite (unit + end-to-end + eval thresholds)
npm run check      # tsc --noEmit
npm run eval       # full eval: generate synthetic corpus, ingest, score, report
npm run fixtures   # just generate a synthetic corpus (fixtures/generated)
```

`npm run eval` plants facts and preferences in a seeded 12-session / ~6-month
synthetic corpus (ytsejam session format), ingests it session by session with
a consolidation pass mid-horizon, and scores recall@k/MRR plus
personality-mirroring consistency (preference F1, directive recall,
contradiction resolution, profile stability). It exits non-zero below
thresholds.

## Store layout

```
<storeDir>/
  episodic.jsonl      # turn/summary records (latest-wins snapshots)
  facts.jsonl         # learned user facts
  entities.jsonl      # observed entities
  redactions.jsonl    # redaction audit log (ids/counts/digests only)
  ingest-state.json   # per-session ingestion progress
```

JSONL is the source of truth; vector/BM25 indexes and the preference graph
are derived in memory on load.
