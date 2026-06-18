/**
 * Hybrid retrieval: per query, candidates come from the vector index and the
 * BM25 index; each candidate is scored as a weighted blend of
 *
 *   vector cosine + BM25 (normalized) + recency + salience×retention
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
import { retention, ageDays } from "../episodic/decay.ts";
import type { EpisodicStore } from "../episodic/store.ts";

const CANDIDATE_POOL = 50;

/**
 * The most common embedding dimension across a set of records, or null when
 * none carry an embedding. Used to pin the vector index to the live
 * dimension even when legacy off-dimension contaminants appear first in
 * insertion order. Ties resolve to the first dimension reaching the max
 * count (deterministic over a stable record order).
 */
export function majorityEmbeddingDim(records: EpisodicRecord[]): number | null {
  const counts = new Map<number, number>();
  for (const r of records) {
    if (!r.embedding || r.embedding.length === 0) continue;
    counts.set(r.embedding.length, (counts.get(r.embedding.length) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = -1;
  for (const [dim, n] of counts) {
    if (n > bestCount) {
      bestCount = n;
      best = dim;
    }
  }
  return best;
}

/**
 * Vector-channel normalization: mean-relative spread over the candidate
 * pool, clamped to [0,1]. Real embedders cluster cosines tightly (e.g.
 * nomic ~0.55-0.62 across a conversational corpus), so the previous
 * pool-max ratio left the best match ~0.02 ahead of distractors — less
 * than the recency weight, which is why fresh chatter outranked perfect
 * semantic matches. Mean-relative spread gives the pool's best match the
 * full vector weight and typical distractors ~0. Degenerate pools
 * (max ≈ mean) fall back to the old max-ratio.
 */
export function spreadNormalize(cos: number, mean: number, max: number): number {
  const c = Math.max(0, cos);
  const range = max - mean;
  if (range < 1e-9) return max > 1e-9 ? Math.min(1, c / max) : 0;
  return Math.min(1, Math.max(0, (c - mean) / range));
}

/**
 * rank() output before fact promotion: every record comes from the episodic
 * store, so scoring/MMR may rely on EpisodicRecord-only fields (embedding)
 * that the wider RetrievedMemory union (which admits PromotedFact) lacks.
 */
interface RankedMemory extends RetrievedMemory {
  record: EpisodicRecord;
}

export interface RetrieverDeps {
  store: EpisodicStore;
  embedder: Embedder;
  config: LtmConfig;
}

export class Retriever {
  private vectors: VectorIndex;
  private lexical = new Bm25Index();
  private readonly deps: RetrieverDeps;

  constructor(deps: RetrieverDeps) {
    this.deps = deps;
    // Fix the vector index to the MAJORITY embedding dimension before
    // admitting anything. A store may hold legacy off-dimension contaminants
    // (e.g. hash-fallback 256-dim records); if insertion order put one first,
    // a first-seen index would pin to the minority dimension and refuse the
    // real ones. Majority-dim makes the live dimension win regardless of order.
    this.vectors = new VectorIndex(majorityEmbeddingDim(deps.store.all()) ?? undefined);
    for (const record of deps.store.all()) this.admit(record);
  }

  /** Add/refresh a record in the live indexes (or drop it if not active). */
  admit(record: EpisodicRecord): void {
    if (record.state === "active" && record.text) {
      if (record.embedding) this.vectors.set(record.id, record.embedding);
      this.lexical.add(record.id, record.text);
    } else if (record.state === "consolidated" && record.text && record.embedding) {
      // Consolidated records stay vector-searchable so a strong semantic
      // match can resurrect them (strong-cue recall). Lexical stays
      // excluded: verbatim-term queries already reach the summaries.
      this.vectors.set(record.id, record.embedding);
      this.lexical.remove(record.id);
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
    filterTags?: string[],
  ): Promise<RetrievedMemory[]> {
    const { store, embedder, config } = this.deps;
    const queryVector = await embedder.embed(query);

    const vectorHits = this.vectors.search(queryVector, CANDIDATE_POOL);
    const lexicalHits = this.lexical.search(query, CANDIDATE_POOL);

    // Both content channels are normalized so the configured weights compare
    // like with like (PLAN 2.2). Lexical normalizes to its pool max (BM25
    // spreads naturally); the vector channel uses mean-relative spread — see
    // spreadNormalize.
    // VectorIndex.search returns hits sorted descending, so rawCosines[0] is
    // the pool maximum after the non-negative clamp.
    const maxLexical = lexicalHits[0]?.score || 1;
    const rawCosines = vectorHits.map((h) => Math.max(0, h.score));
    const maxVector = rawCosines[0] ?? 0;
    const meanVector = rawCosines.length
      ? rawCosines.reduce((s, x) => s + x, 0) / rawCosines.length
      : 0;
    // Resurrection gate statistics (strong-cue recall): a consolidated
    // record resurrects only when its cosine is a clear outlier over the
    // candidate pool. Leave-one-out: each candidate is judged against the
    // pool EXCLUDING itself, so a strong match is not suppressed by its own
    // contribution to the mean/std — and two strong matches don't suppress
    // each other (measured: two cosine-1.0 targets self-included land at
    // z≈2.1 and neither resurrects; LOO puts both at z≈3).
    const sumCosines = rawCosines.reduce((s, x) => s + x, 0);
    const sumSqCosines = rawCosines.reduce((s, x) => s + x * x, 0);
    const rawCosineById = new Map(vectorHits.map((h) => [h.id, Math.max(0, h.score)]));
    /** LOO z-score of x within the pool; -Infinity when undefined (tiny/flat pool). */
    const looZ = (x: number): number => {
      const n = rawCosines.length;
      if (n < 3) return -Infinity;
      const mean = (sumCosines - x) / (n - 1);
      const variance = Math.max(0, (sumSqCosines - x * x) / (n - 1) - mean * mean);
      const std = Math.sqrt(variance);
      return std < 1e-6 ? -Infinity : (x - mean) / std;
    };
    const lexicalById = new Map(lexicalHits.map((h) => [h.id, h.score / maxLexical]));
    const vectorById = new Map(
      vectorHits.map((h) => [h.id, spreadNormalize(h.score, meanVector, maxVector)]),
    );

    const candidateIds = new Set<string>([
      ...vectorById.keys(),
      ...lexicalById.keys(),
    ]);

    const scored: RankedMemory[] = [];
    for (const id of candidateIds) {
      const record = store.get(id);
      if (!record || !record.text) continue;
      if (record.state === "redacted") continue;
      // Tag scoping (SEAM 3): a filter means "search the tagged subset" —
      // untagged records are excluded while one is set. "infra" matches
      // "infra" and "infra:net" (tag-segment prefix), not "infrastructure".
      if (
        filterTags &&
        !record.tags?.some((t) => filterTags.some((f) => t === f || t.startsWith(`${f}:`)))
      ) {
        continue;
      }
      let stale = false;
      if (record.state === "consolidated" && !includeConsolidated) {
        // Only a clear semantic outlier reaches past consolidation; flat or
        // tiny pools never resurrect.
        const raw = rawCosineById.get(id);
        if (raw === undefined || looZ(raw) < config.resurrectZ) continue;
        stale = true;
      }

      const w = config.weights;
      const ret = retention(record, now, config.decay);
      const breakdown: ScoreBreakdown = {
        vector:
          vectorById.get(id) ??
          // Guard: only score embeddings that match the query dimension. An
          // off-dimension stored vector (legacy hash fallback) contributes 0
          // rather than reaching the now-throwing cosine.
          (record.embedding && record.embedding.length === queryVector.length
            ? spreadNormalize(cosine(queryVector, record.embedding), meanVector, maxVector)
            : 0),
        lexical: lexicalById.get(id) ?? 0,
        recency: Math.pow(2, -ageDays(record.timestamp, now) / config.recencyHalfLifeDays),
        salience: record.salience,
        retention: ret,
        total: 0,
      };
      breakdown.total =
        w.vector * breakdown.vector +
        w.lexical * breakdown.lexical +
        w.recency * breakdown.recency +
        w.salience * breakdown.salience * ret;
      scored.push({ record, score: breakdown.total, breakdown, ...(stale ? { stale: true } : {}) });
    }

    scored.sort((a, b) => b.score - a.score);
    return this.mmr(scored, k, config.mmrLambda);
  }

  /** Maximal Marginal Relevance over embeddings; falls back to plain order. */
  private mmr(ranked: RankedMemory[], k: number, lambda: number): RankedMemory[] {
    const pool = ranked.slice(0, Math.max(k * 4, 20));
    const selected: RankedMemory[] = [];
    while (selected.length < k && pool.length > 0) {
      let bestIdx = 0;
      let bestScore = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const candidate = pool[i];
        let maxSim = 0;
        if (candidate.record.embedding) {
          for (const s of selected) {
            if (!s.record.embedding) continue;
            // Skip cross-dimension pairs (legacy off-dim embeddings) — they
            // are not comparable; treat as no similarity rather than throwing.
            if (s.record.embedding.length !== candidate.record.embedding.length)
              continue;
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
