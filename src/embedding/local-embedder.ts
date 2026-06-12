/**
 * Local sentence-transformer embedder (PLAN.md Task 4.2) — OPTIONAL.
 *
 * Loads a feature-extraction pipeline from `@huggingface/transformers`
 * (an optional peer dependency, deliberately NOT in `dependencies`: the
 * runtime + a model like all-MiniLM-L6-v2 is ~100MB). Selected via the
 * LOCAL_EMBEDDER_MODEL env var or an explicit option; the default
 * HashEmbedder remains the offline, deterministic baseline and the eval
 * defaults to it.
 *
 * The pipeline factory is injectable so the adapter SHAPE is tested without
 * the heavy dependency; the actual model swap is deferred to the
 * fold-into-ytsejam plan (which can reuse ytsejam's pi-ai model catalog).
 * Compose with CachedEmbedder so re-runs cost nothing:
 *
 *   const local = await LocalEmbedder.create({ model: "Xenova/all-MiniLM-L6-v2" });
 *   const embedder = new CachedEmbedder(local, cacheDir, local.modelName);
 */

import type { Embedder } from "./embedder.ts";

/** Minimal surface of a transformers.js feature-extraction pipeline. */
export type FeatureExtractionPipeline = (
  text: string,
  options: { pooling: "mean"; normalize: true },
) => Promise<{ data: Float32Array | number[] }>;

export type PipelineFactory = (model: string) => Promise<FeatureExtractionPipeline>;

export interface LocalEmbedderOptions {
  /** Model id/path. Default: the LOCAL_EMBEDDER_MODEL env var. */
  model?: string;
  /** Test seam; defaults to dynamically importing @huggingface/transformers. */
  pipelineFactory?: PipelineFactory;
}

async function defaultFactory(model: string): Promise<FeatureExtractionPipeline> {
  // Computed specifier: the optional dependency must not be a resolution
  // error for installs that skip it.
  const moduleName = "@huggingface/transformers";
  let mod: { pipeline: (task: string, model: string) => Promise<unknown> };
  try {
    mod = (await import(moduleName)) as typeof mod;
  } catch {
    throw new Error(
      `LocalEmbedder requires the optional dependency ${moduleName} (~100MB with a model). ` +
        `Install it explicitly, or use the default HashEmbedder. See README "Semantic eval mode".`,
    );
  }
  return (await mod.pipeline("feature-extraction", model)) as FeatureExtractionPipeline;
}

export class LocalEmbedder implements Embedder {
  readonly dimension: number;
  readonly modelName: string;
  private readonly pipe: FeatureExtractionPipeline;

  private constructor(modelName: string, pipe: FeatureExtractionPipeline, dimension: number) {
    this.modelName = modelName;
    this.pipe = pipe;
    this.dimension = dimension;
  }

  static async create(opts: LocalEmbedderOptions = {}): Promise<LocalEmbedder> {
    const model = opts.model ?? process.env.LOCAL_EMBEDDER_MODEL;
    if (!model) {
      throw new Error(
        "No local embedder model configured: set LOCAL_EMBEDDER_MODEL=/path/or/hub-id " +
          "(e.g. Xenova/all-MiniLM-L6-v2) or pass {model}. See README \"Semantic eval mode\".",
      );
    }
    const pipe = await (opts.pipelineFactory ?? defaultFactory)(model);
    // Probe once to learn the dimension instead of trusting configuration.
    const probe = await pipe("dimension probe", { pooling: "mean", normalize: true });
    return new LocalEmbedder(model, pipe, probe.data.length);
  }

  async embed(text: string): Promise<number[]> {
    const out = await this.pipe(text, { pooling: "mean", normalize: true });
    const vector = Array.from(out.data);
    // Defensive re-normalization: the index assumes unit vectors.
    let norm = 0;
    for (const x of vector) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    return vector.map((x) => x / norm);
  }
}
