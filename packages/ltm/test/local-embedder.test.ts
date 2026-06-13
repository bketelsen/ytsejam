import { describe, expect, it } from "vitest";
import { LocalEmbedder, type FeatureExtractionPipeline } from "../src/embedding/local-embedder.ts";

/** Fake transformers.js pipeline: 8-dim, deterministic, NOT pre-normalized. */
function fakePipeline(): FeatureExtractionPipeline & { calls: string[] } {
  const calls: string[] = [];
  const pipe = (async (text: string, options: { pooling: "mean"; normalize: true }) => {
    expect(options).toEqual({ pooling: "mean", normalize: true });
    calls.push(text);
    const data = new Float32Array(8);
    for (let i = 0; i < text.length; i++) data[i % 8] += text.charCodeAt(i);
    return { data };
  }) as FeatureExtractionPipeline & { calls: string[] };
  pipe.calls = calls;
  return pipe;
}

describe("local embedder adapter shape (PLAN 4.2)", () => {
  it("probes the pipeline for its dimension and emits unit-norm vectors", async () => {
    const pipe = fakePipeline();
    const embedder = await LocalEmbedder.create({
      model: "fake/all-MiniLM-L6-v2",
      pipelineFactory: () => Promise.resolve(pipe),
    });
    expect(embedder.dimension).toBe(8);
    expect(embedder.modelName).toBe("fake/all-MiniLM-L6-v2");

    const v = await embedder.embed("the user prefers oat milk");
    expect(v).toHaveLength(8);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
    expect(pipe.calls).toContain("the user prefers oat milk");
  });

  it("fails with actionable guidance when no model is configured", async () => {
    const prev = process.env.LOCAL_EMBEDDER_MODEL;
    delete process.env.LOCAL_EMBEDDER_MODEL;
    try {
      await expect(LocalEmbedder.create()).rejects.toThrow(/LOCAL_EMBEDDER_MODEL/);
    } finally {
      if (prev !== undefined) process.env.LOCAL_EMBEDDER_MODEL = prev;
    }
  });

  it("fails with install guidance when the optional dependency is missing", async () => {
    // No pipelineFactory injected and @huggingface/transformers is not
    // installed in this repo — the real factory must explain itself.
    await expect(LocalEmbedder.create({ model: "Xenova/all-MiniLM-L6-v2" })).rejects.toThrow(
      /@huggingface\/transformers/,
    );
  });
});
