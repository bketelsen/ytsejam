/**
 * GitHub Copilot embedder (issue #136) — OPTIONAL, opt-in.
 *
 * Talks to GitHub Copilot's /embeddings endpoint over plain HTTP using
 * Node's built-in fetch — deliberately no SDK dependency, so installs pay
 * nothing for it. The default model is text-embedding-3-small, which returns
 * OpenAI-shaped responses and is expected to be 1536-dimensional.
 *
 * Authentication is injected as getApiKey() so this package stays decoupled
 * from PiAuthStore (or any other token source). On 401, getApiKey() is called
 * again and the request is retried once, allowing the injected provider to
 * refresh internally.
 */

import type { Embedder } from "./embedder.ts";

export interface CopilotEmbedderOptions {
  /** Resolves a GitHub Copilot API key/token. Called again for the one 401 retry. */
  getApiKey: () => Promise<string | undefined>;
  /** Copilot embedding model name. Default text-embedding-3-small. */
  model?: string;
  /** Service root. Default https://api.enterprise.githubcopilot.com. */
  baseUrl?: string;
  /**
   * Vector dimension. When omitted (the normal case), discovered by a
   * one-time probe embed — the wire is the source of truth. When set, the
   * probe is skipped and embed() fails loudly if the wire disagrees.
   */
  dimension?: number;
}

async function postEmbedding(
  url: string,
  model: string,
  text: string,
  apiKey: string,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Copilot-Integration-Id": "vscode-chat",
    },
    body: JSON.stringify({ input: text, model }),
  });
}

async function requireApiKey(getApiKey: () => Promise<string | undefined>): Promise<string> {
  const apiKey = await getApiKey();
  if (apiKey === undefined) {
    throw new Error("Copilot embedder cannot request embeddings: API key is unavailable (getApiKey() returned undefined).");
  }
  return apiKey;
}

async function requestEmbedding(
  baseUrl: string,
  model: string,
  text: string,
  getApiKey: () => Promise<string | undefined>,
): Promise<number[]> {
  const url = `${baseUrl}/embeddings`;
  const guardedPost = async (apiKey: string): Promise<Response> => {
    try {
      return await postEmbedding(url, model, text, apiKey);
    } catch (error) {
      throw new Error(
        `Copilot embed request to ${url} (model ${model}) failed: ${(error as Error).message}.`,
      );
    }
  };

  let apiKey = await requireApiKey(getApiKey);
  let res = await guardedPost(apiKey);
  if (res.status === 401) {
    apiKey = await requireApiKey(getApiKey);
    res = await guardedPost(apiKey);
  }

  const body = await res.text();
  if (!res.ok) {
    throw new Error(
      `Copilot embed at ${url} (model ${model}) returned HTTP ${res.status}: ${body}`,
    );
  }

  const vector = (JSON.parse(body) as { data?: { embedding?: number[] }[] }).data?.[0]
    ?.embedding;
  if (!vector || vector.length === 0) {
    throw new Error(
      `Copilot embed at ${url} (model ${model}) violated the /embeddings contract: ` +
        `expected a non-empty data[0].embedding, got ${body.slice(0, 200)}`,
    );
  }
  return vector;
}

export class CopilotEmbedder implements Embedder {
  readonly dimension: number;
  readonly modelName: string;
  private readonly baseUrl: string;
  private readonly getApiKey: () => Promise<string | undefined>;

  private constructor(
    modelName: string,
    baseUrl: string,
    dimension: number,
    getApiKey: () => Promise<string | undefined>,
  ) {
    this.modelName = modelName;
    this.baseUrl = baseUrl;
    this.dimension = dimension;
    this.getApiKey = getApiKey;
  }

  static async create(opts: CopilotEmbedderOptions): Promise<CopilotEmbedder> {
    const model = opts.model ?? "text-embedding-3-small";
    const baseUrl = (opts.baseUrl ?? "https://api.enterprise.githubcopilot.com").replace(
      /\/+$/,
      "",
    );
    if (opts.dimension !== undefined) {
      return new CopilotEmbedder(model, baseUrl, opts.dimension, opts.getApiKey);
    }
    const probe = await requestEmbedding(baseUrl, model, "dimension probe", opts.getApiKey);
    return new CopilotEmbedder(model, baseUrl, probe.length, opts.getApiKey);
  }

  async embed(text: string): Promise<number[]> {
    const vector = await requestEmbedding(this.baseUrl, this.modelName, text, this.getApiKey);
    if (vector.length !== this.dimension) {
      throw new Error(
        `Copilot model ${this.modelName} returned a ${vector.length}-dim vector but this ` +
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
