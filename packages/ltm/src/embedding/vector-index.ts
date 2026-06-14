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

  set(id: string, vector: number[]): void {
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
