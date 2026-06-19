/**
 * Flat in-memory cosine index. Exact search; fine for PoC scale (thousands
 * of records). Swappable for an ANN index behind the same surface later.
 */

import { cosine } from "./embedder.ts";

export interface VectorHit {
  id: string;
  score: number;
}

export class VectorIndex {
  private vectors = new Map<string, number[]>();
  private dim: number | null;
  private warnedMismatch = false;

  /**
   * @param expectedDim When provided, the index dimension is fixed up front
   *   (rather than established by the first inserted vector). Callers that
   *   know the canonical dimension — e.g. the majority dimension of a store
   *   that may hold legacy off-dimension contaminants — pass it so insertion
   *   order can't pin the index to a minority dimension.
   */
  constructor(expectedDim?: number) {
    this.dim = expectedDim ?? null;
  }

  /**
   * Insert/replace a vector. The first non-empty vector establishes the
   * index dimension (unless fixed via the constructor); any vector of a
   * different length is REFUSED (skipped, warned once) rather than stored. A
   * mixed-dimension index is the D2 contamination: `cosine` would silently
   * truncate to the shorter length and score garbage. Keeping the index
   * single-dimension means search() never compares across dimensions. Legacy
   * off-dimension records (e.g. hash-embedder fallbacks) are simply excluded
   * from retrieval until they are re-embedded — strictly better than a
   * corrupt score.
   */
  set(id: string, vector: number[]): void {
    if (vector.length === 0) return;
    if (this.dim === null) {
      this.dim = vector.length;
    } else if (vector.length !== this.dim) {
      if (!this.warnedMismatch) {
        this.warnedMismatch = true;
        console.warn(
          `[ltm] VectorIndex: refusing ${vector.length}-dim vector(s); index is ${this.dim}-dim. ` +
            `Off-dimension records are excluded from retrieval until re-embedded.`,
        );
      }
      this.vectors.delete(id); // ensure a stale same-id entry can't linger
      return;
    }
    this.vectors.set(id, vector);
  }

  delete(id: string): void {
    this.vectors.delete(id);
  }

  has(id: string): boolean {
    return this.vectors.has(id);
  }

  get size(): number {
    return this.vectors.size;
  }

  /** Return the dimensionality of any stored vector, or null when empty. */
  sampleDimension(): number | null {
    const first = this.vectors.values().next();
    return first.done ? null : first.value.length;
  }

  search(query: number[], k: number): VectorHit[] {
    const hits: VectorHit[] = [];
    for (const [id, vector] of this.vectors) {
      hits.push({ id, score: cosine(query, vector) });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }

  similarity(id: string, query: number[]): number {
    const v = this.vectors.get(id);
    return v ? cosine(query, v) : 0;
  }
}
