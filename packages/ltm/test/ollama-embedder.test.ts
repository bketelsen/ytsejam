import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OllamaEmbedder } from "../src/embedding/ollama-embedder.ts";
import { CachedEmbedder } from "../src/embedding/cached-embedder.ts";

interface RecordedCall {
  url: string;
  body: { model: string; input: string };
}

/**
 * Fake /api/embed: deterministic, NOT pre-normalized (exercises the
 * defensive re-norm). Records every call so tests can count probes.
 */
function fakeOllama(dimension = 6): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as RecordedCall["body"];
    calls.push({ url: String(url), body });
    const data = new Array<number>(dimension).fill(0);
    for (let i = 0; i < body.input.length; i++) {
      data[i % dimension] += body.input.charCodeAt(i);
    }
    return new Response(JSON.stringify({ model: body.model, embeddings: [data] }), {
      status: 200,
    });
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ollama embedder adapter (PLAN-OLLAMA O1)", () => {
  it("discovers its dimension by probing the wire when none is configured", async () => {
    const ollama = fakeOllama(6);
    const embedder = await OllamaEmbedder.create({ model: "nomic-embed-text:latest" });
    expect(embedder.dimension).toBe(6);
    expect(embedder.modelName).toBe("nomic-embed-text:latest");
    expect(ollama.calls).toHaveLength(1);
    expect(ollama.calls[0].url).toBe("http://localhost:11434/api/embed");
    expect(ollama.calls[0].body).toEqual({
      model: "nomic-embed-text:latest",
      input: "dimension probe",
    });
  });

  it("reuses the discovered dimension — no second probe across embeds", async () => {
    const ollama = fakeOllama(6);
    const embedder = await OllamaEmbedder.create({ model: "nomic-embed-text:latest" });
    await embedder.embed("first");
    await embedder.embed("second");
    expect(embedder.dimension).toBe(6);
    const probes = ollama.calls.filter((c) => c.body.input === "dimension probe");
    expect(probes).toHaveLength(1);
    expect(ollama.calls).toHaveLength(3); // probe + two embeds
  });

  it("skips the probe entirely when a dimension is configured", async () => {
    const ollama = fakeOllama(6);
    const embedder = await OllamaEmbedder.create({
      model: "nomic-embed-text:latest",
      dimension: 6,
    });
    expect(embedder.dimension).toBe(6);
    expect(ollama.calls).toHaveLength(0);
  });

  it("throws when the wire disagrees with a configured dimension", async () => {
    fakeOllama(6);
    const embedder = await OllamaEmbedder.create({
      model: "nomic-embed-text:latest",
      dimension: 4,
    });
    await expect(embedder.embed("anything")).rejects.toThrow(/6-dim vector.*4-dim/s);
  });

  it("surfaces URL, model, status, and body on an HTTP error", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ error: "model not found" }), { status: 500 }),
    );
    const err = await OllamaEmbedder.create({
      model: "missing-model:latest",
      baseUrl: "http://example.test:11434",
    }).then(
      () => {
        throw new Error("expected rejection");
      },
      (e: Error) => e,
    );
    expect(err.message).toContain("http://example.test:11434/api/embed");
    expect(err.message).toContain("missing-model:latest");
    expect(err.message).toContain("500");
    expect(err.message).toContain("model not found");
  });

  it("throws a contract-violation error when embeddings[0] is missing", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ embeddings: [] }), { status: 200 }),
    );
    await expect(OllamaEmbedder.create({ model: "nomic-embed-text:latest" })).rejects.toThrow(
      /embeddings\[0\]/,
    );
  });

  it("returns unit-norm vectors (defensive re-normalization)", async () => {
    fakeOllama(6);
    const embedder = await OllamaEmbedder.create({ model: "nomic-embed-text:latest" });
    const v = await embedder.embed("the user prefers oat milk");
    expect(v).toHaveLength(6);
    const sumSquares = v.reduce((s, x) => s + x * x, 0);
    expect(Math.abs(sumSquares - 1)).toBeLessThan(1e-9);
  });

  it("composes with CachedEmbedder — repeat embeds never hit the wire", async () => {
    const ollama = fakeOllama(6);
    const inner = await OllamaEmbedder.create({ model: "nomic-embed-text:latest" });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltm-ollama-cache-"));
    const cached = new CachedEmbedder(inner, dir, inner.modelName);
    const a = await cached.embed("hello world");
    const callsAfterFirst = ollama.calls.length;
    const b = await cached.embed("hello world");
    expect(ollama.calls.length).toBe(callsAfterFirst); // cache hit, no new fetch
    expect(b).toEqual(a);
  });
});
