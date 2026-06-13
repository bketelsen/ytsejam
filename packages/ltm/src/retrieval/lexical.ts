/**
 * BM25 lexical index over episodic records. Rebuilt in memory from the
 * episodic store on load; complements the embedding channel with exact-term
 * matching (names, identifiers) that dense vectors blur.
 */

import { STOPWORDS, tokenize } from "../embedding/embedder.ts";

const K1 = 1.2;
const B = 0.75;

function contentTokens(text: string): string[] {
  return tokenize(text).filter((t) => !STOPWORDS.has(t));
}

export interface LexicalHit {
  id: string;
  score: number;
}

export class Bm25Index {
  private docs = new Map<string, Map<string, number>>();
  private docLengths = new Map<string, number>();
  private df = new Map<string, number>();
  private totalLength = 0;

  add(id: string, text: string): void {
    if (this.docs.has(id)) this.remove(id);
    const tf = new Map<string, number>();
    const tokens = contentTokens(text);
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    this.docs.set(id, tf);
    this.docLengths.set(id, tokens.length);
    this.totalLength += tokens.length;
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
  }

  remove(id: string): void {
    const tf = this.docs.get(id);
    if (!tf) return;
    for (const t of tf.keys()) {
      const n = (this.df.get(t) ?? 1) - 1;
      if (n <= 0) this.df.delete(t);
      else this.df.set(t, n);
    }
    this.totalLength -= this.docLengths.get(id) ?? 0;
    this.docs.delete(id);
    this.docLengths.delete(id);
  }

  get size(): number {
    return this.docs.size;
  }

  search(query: string, k: number): LexicalHit[] {
    const n = this.docs.size;
    if (n === 0) return [];
    const avgLength = this.totalLength / n || 1;
    const queryTokens = [...new Set(contentTokens(query))];

    const hits: LexicalHit[] = [];
    for (const [id, tf] of this.docs) {
      let score = 0;
      const len = this.docLengths.get(id) ?? 0;
      for (const t of queryTokens) {
        const f = tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) ?? 1;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * len) / avgLength));
      }
      if (score > 0) hits.push({ id, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }
}
