/**
 * Ollama embedder (PLAN-OLLAMA Task O1) — OPTIONAL, opt-in.
 *
 * Talks to a local Ollama service over plain HTTP using Node's built-in
 * fetch — deliberately no SDK dependency, so installs pay nothing for it.
 * Where LocalEmbedder is the in-process seam (transformers.js, model
 * integration deferred), this is the working semantic path for any host
 * already running Ollama with an embedding model pulled
 * (e.g. `ollama pull nomic-embed-text`).
 *
 * Compose with CachedEmbedder so re-runs cost nothing:
 *
 *   const ollama = await OllamaEmbedder.create({ model: "nomic-embed-text:latest" });
 *   const embedder = new CachedEmbedder(ollama, cacheDir, ollama.modelName);
 */

import type { Embedder } from "./embedder.ts";

export interface OllamaEmbedderOptions {
  /** Ollama model name, e.g. "nomic-embed-text:latest". */
  model: string;
  /** Service root. Default http://localhost:11434. */
  baseUrl?: string;
  /**
   * Vector dimension. When omitted (the normal case), discovered by a
   * one-time probe embed — the wire is the source of truth. When set, the
   * probe is skipped and embed() fails loudly if the wire disagrees.
   */
  dimension?: number;
}

/**
 * One POST to /api/embed. This is the NEWER endpoint, which returns
 * `{model, embeddings: [[…]]}` with normalized vectors. Do NOT "simplify"
 * to the legacy /api/embeddings — that one returns `{embedding: [...]}`
 * (different shape) and its vectors are NOT normalized.
 */
async function requestEmbedding(baseUrl: string, model: string, text: string): Promise<number[]> {
  const url = `${baseUrl}/api/embed`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: text }),
    });
  } catch (error) {
    throw new Error(
      `Ollama embed request to ${url} (model ${model}) failed: ${(error as Error).message}. ` +
        `Is the Ollama service running?`,
    );
  }
  const body = await res.text();
  if (!res.ok) {
    throw new Error(
      `Ollama embed at ${url} (model ${model}) returned HTTP ${res.status}: ${body}`,
    );
  }
  const vector = (JSON.parse(body) as { embeddings?: number[][] }).embeddings?.[0];
  if (!vector || vector.length === 0) {
    throw new Error(
      `Ollama embed at ${url} (model ${model}) violated the /api/embed contract: ` +
        `expected a non-empty embeddings[0], got ${body.slice(0, 200)}`,
    );
  }
  return vector;
}

export class OllamaEmbedder implements Embedder {
  readonly dimension: number;
  readonly modelName: string;
  private readonly baseUrl: string;

  private constructor(modelName: string, baseUrl: string, dimension: number) {
    this.modelName = modelName;
    this.baseUrl = baseUrl;
    this.dimension = dimension;
  }

  static async create(opts: OllamaEmbedderOptions): Promise<OllamaEmbedder> {
    const baseUrl = (opts.baseUrl ?? "http://localhost:11434").replace(/\/+$/, "");
    if (opts.dimension !== undefined) {
      return new OllamaEmbedder(opts.model, baseUrl, opts.dimension);
    }
    const probe = await requestEmbedding(baseUrl, opts.model, "dimension probe");
    return new OllamaEmbedder(opts.model, baseUrl, probe.length);
  }

  async embed(text: string): Promise<number[]> {
    const vector = await requestEmbedding(this.baseUrl, this.modelName, text);
    if (vector.length !== this.dimension) {
      throw new Error(
        `Ollama model ${this.modelName} returned a ${vector.length}-dim vector but this ` +
          `embedder was created as ${this.dimension}-dim — the configured dimension and ` +
          `the wire disagree; drop the dimension option to probe instead.`,
      );
    }
    // Defensive re-normalization: the index assumes unit vectors.
    let norm = 0;
    for (const x of vector) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    return vector.map((x) => x / norm);
  }
}
