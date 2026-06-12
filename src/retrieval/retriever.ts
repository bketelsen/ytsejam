/**
 * Hybrid retrieval: per query, candidates come from the vector index, the
 * BM25 index, and graph activation; each candidate is scored as a weighted
 * blend of
 *
 *   vector cosine + BM25 (normalized) + recency + salience×retention + graph
 *
 * then re-ranked with MMR for diversity and packed into a token budget.
 * Every returned item carries its full score breakdown — the same numbers
 * inspect.explain() shows the user.
 */

import type {
  EpisodicRecord,
  LtmConfig,
  RetrievedMemory,
  ScoreBreakdown,
} from "../types.ts";
import type { Embedder } from "../embedding/embedder.ts";
import { cosine } from "../embedding/embedder.ts";
import { VectorIndex } from "../embedding/vector-index.ts";
import { Bm25Index } from "./lexical.ts";
import type { PreferenceGraph } from "../semantic/graph.ts";
import { retention, ageDays } from "../episodic/decay.ts";
import type { EpisodicStore } from "../episodic/store.ts";

const CANDIDATE_POOL = 50;

export interface RetrieverDeps {
  store: EpisodicStore;
  embedder: Embedder;
  graph: PreferenceGraph;
  config: LtmConfig;
}

export class Retriever {
  private vectors = new VectorIndex();
  private lexical = new Bm25Index();
  private readonly deps: RetrieverDeps;

  constructor(deps: RetrieverDeps) {
    this.deps = deps;
    for (const record of deps.store.all()) this.admit(record);
  }

  /** Add/refresh a record in the live indexes (or drop it if not active). */
  admit(record: EpisodicRecord): void {
    if (record.state === "active" && record.text) {
      if (record.embedding) this.vectors.set(record.id, record.embedding);
      this.lexical.add(record.id, record.text);
    } else {
      this.vectors.delete(record.id);
      this.lexical.remove(record.id);
    }
  }

  evict(id: string): void {
    this.vectors.delete(id);
    this.lexical.remove(id);
  }

  async rank(
    query: string,
    k: number,
    now: string,
    includeConsolidated = false,
  ): Promise<RetrievedMemory[]> {
    const { store, embedder, graph, config } = this.deps;
    const queryVector = await embedder.embed(query);

    const vectorHits = this.vectors.search(queryVector, CANDIDATE_POOL);
    const lexicalHits = this.lexical.search(query, CANDIDATE_POOL);
    const graphBoosts = graph.activate(query);

    // Both content channels are normalized to their own pool max so the
    // configured weights compare like with like. Raw cosine tops out around
    // 0.1–0.7 for the hash embedder while BM25 was already max-normalized —
    // unnormalized, vector's effective weight was a fraction of its
    // documented share.
    const maxLexical = lexicalHits[0]?.score || 1;
    const maxVector = Math.max(vectorHits[0]?.score ?? 0, 1e-9);
    const lexicalById = new Map(lexicalHits.map((h) => [h.id, h.score / maxLexical]));
    const vectorById = new Map(
      vectorHits.map((h) => [h.id, Math.max(0, h.score) / maxVector]),
    );

    const candidateIds = new Set<string>([
      ...vectorById.keys(),
      ...lexicalById.keys(),
      ...graphBoosts.keys(),
    ]);

    const scored: RetrievedMemory[] = [];
    for (const id of candidateIds) {
      const record = store.get(id);
      if (!record || !record.text) continue;
      if (record.state === "redacted") continue;
      if (record.state === "consolidated" && !includeConsolidated) continue;

      const w = config.weights;
      const ret = retention(record, now, config.decay);
      const breakdown: ScoreBreakdown = {
        vector:
          vectorById.get(id) ??
          (record.embedding
            ? Math.min(1, Math.max(0, cosine(queryVector, record.embedding)) / maxVector)
            : 0),
        lexical: lexicalById.get(id) ?? 0,
        recency: Math.pow(2, -ageDays(record.timestamp, now) / config.recencyHalfLifeDays),
        salience: record.salience,
        graph: graphBoosts.get(id) ?? 0,
        retention: ret,
        total: 0,
      };
      breakdown.total =
        w.vector * Math.max(0, breakdown.vector) +
        w.lexical * breakdown.lexical +
        w.recency * breakdown.recency +
        w.salience * breakdown.salience * ret +
        w.graph * breakdown.graph;
      scored.push({ record, score: breakdown.total, breakdown });
    }

    scored.sort((a, b) => b.score - a.score);
    return this.mmr(scored, k, config.mmrLambda);
  }

  /** Maximal Marginal Relevance over embeddings; falls back to plain order. */
  private mmr(ranked: RetrievedMemory[], k: number, lambda: number): RetrievedMemory[] {
    const pool = ranked.slice(0, Math.max(k * 4, 20));
    const selected: RetrievedMemory[] = [];
    while (selected.length < k && pool.length > 0) {
      let bestIdx = 0;
      let bestScore = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const candidate = pool[i];
        let maxSim = 0;
        if (candidate.record.embedding) {
          for (const s of selected) {
            if (!s.record.embedding) continue;
            maxSim = Math.max(maxSim, cosine(candidate.record.embedding, s.record.embedding));
          }
        }
        const mmrScore = lambda * candidate.score - (1 - lambda) * maxSim;
        if (mmrScore > bestScore) {
          bestScore = mmrScore;
          bestIdx = i;
        }
      }
      selected.push(pool.splice(bestIdx, 1)[0]);
    }
    return selected;
  }
}

/** Greedy budget packing: keep ranked order, skip items that don't fit. */
export function packToBudget(
  items: RetrievedMemory[],
  tokenBudget: number,
): RetrievedMemory[] {
  const out: RetrievedMemory[] = [];
  let used = 0;
  for (const item of items) {
    const tokens = Math.ceil(item.record.text.length / 4);
    if (used + tokens > tokenBudget) continue;
    out.push(item);
    used += tokens;
  }
  return out;
}
