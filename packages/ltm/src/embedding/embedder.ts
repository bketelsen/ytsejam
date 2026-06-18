/**
 * Embedding layer. The system is embedder-agnostic: anything implementing
 * Embedder can back the vector index (e.g. an API-based embedder in
 * production). The default HashEmbedder is deterministic, offline, and
 * dependency-free — good enough for the PoC and for reproducible evals.
 */

export interface Embedder {
  readonly dimension: number;
  /** Returns a unit-norm vector. Must be deterministic per input. */
  embed(text: string): Promise<number[]>;
}

/**
 * Lowercase word tokens. Inner punctuation survives so identifiers and paths
 * stay whole (config.ts, example.com), but leading/trailing punctuation is
 * stripped — otherwise a sentence-final "guitar." can never match "guitar".
 */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_@#./-]+/g) ?? [])
    .map((t) => t.replace(/^[./-]+|[./-]+$/g, ""))
    .filter((t) => t.length > 1);
}

/** FNV-1a 32-bit hash. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Conversational stopwords. Chat queries are question-shaped ("What is my…",
 * "Can you help me…"), so interrogatives and auxiliaries carry no signal and
 * would otherwise dominate idf in a small conversational corpus.
 */
export const STOPWORDS = new Set(
  ("a an and are as at be been being but by can could did do does for from had has have " +
    "how i if in into is it its just me my of on or our really should so some that the " +
    "their them they this to too very was we were what when where which who whom why will " +
    "with would you your am also about please dont don im ive id lets let").split(" "),
);

/**
 * Hashed bag-of-words embedder: unigrams + bigrams folded into a fixed-size
 * vector with signed hashing, log-TF weighting, L2-normalized. Captures
 * lexical similarity (which the hybrid retriever complements with BM25);
 * the signed second hash keeps collisions from biasing scores upward.
 */
export class HashEmbedder implements Embedder {
  readonly dimension: number;

  constructor(dimension = 256) {
    this.dimension = dimension;
  }

  embed(text: string): Promise<number[]> {
    const v = new Float64Array(this.dimension);
    const tokens = tokenize(text).filter((t) => !STOPWORDS.has(t));
    const counts = new Map<string, number>();
    for (let i = 0; i < tokens.length; i++) {
      counts.set(tokens[i], (counts.get(tokens[i]) ?? 0) + 1);
      if (i + 1 < tokens.length) {
        const bigram = `${tokens[i]}_${tokens[i + 1]}`;
        counts.set(bigram, (counts.get(bigram) ?? 0) + 0.5);
      }
    }
    for (const [token, count] of counts) {
      const h = fnv1a(token);
      const idx = h % this.dimension;
      const sign = fnv1a(`s${token}`) % 2 === 0 ? 1 : -1;
      v[idx] += sign * (1 + Math.log(count));
    }
    let norm = 0;
    for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm) || 1;
    const out = new Array<number>(this.dimension);
    for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
    return Promise.resolve(out);
  }
}

/** L2-normalize a vector, falling back to norm 1 for all-zero inputs. */
export function normalizeUnit(vector: number[]): number[] {
  let norm = 0;
  for (const x of vector) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return vector.map((x) => x / norm);
}

/** Cosine similarity of two unit-norm vectors (plain dot product). */
/**
 * Dot product of two L2-normalized vectors == cosine similarity. Throws on a
 * dimension mismatch: vectors of different lengths are not comparable, and
 * silently truncating to the shorter length (the old behavior) produced a
 * plausible-looking garbage score that masked the D2 contamination. Callers
 * scoring possibly-off-dimension stored embeddings must dimension-check first.
 */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosine: dimension mismatch (${a.length} vs ${b.length}); vectors are not comparable`,
    );
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
