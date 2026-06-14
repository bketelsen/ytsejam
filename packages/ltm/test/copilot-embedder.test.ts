import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CopilotEmbedder } from "../src/embedding/copilot-embedder.ts";
import { CachedEmbedder } from "../src/embedding/cached-embedder.ts";
import type { Embedder } from "../src/embedding/embedder.ts";

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: { model: string; input: string };
}

function vectorFor(text: string, dimension: number): number[] {
  const data = new Array<number>(dimension).fill(0);
  for (let i = 0; i < text.length; i++) {
    data[i % dimension] += text.charCodeAt(i);
  }
  return data;
}

/**
 * Fake Copilot /embeddings: deterministic, NOT pre-normalized (exercises the
 * defensive re-norm). Records every call so tests can count probes.
 */
function fakeCopilot(dimension = 1536): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as RecordedCall["body"];
    calls.push({ url: String(url), headers: init.headers as Record<string, string>, body });
    return new Response(
      JSON.stringify({
        data: [{ embedding: vectorFor(body.input, dimension), index: 0 }],
        model: body.model,
        usage: {},
      }),
      { status: 200 },
    );
  });
  return { calls };
}

function countingEmbedder(inner: Embedder): Embedder & { calls: number } {
  let calls = 0;
  return {
    dimension: inner.dimension,
    async embed(text: string) {
      calls++;
      return inner.embed(text);
    },
    get calls() {
      return calls;
    },
  };
}

function getApiKey(key = "test-key"): () => Promise<string | undefined> {
  return vi.fn(async () => key);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copilot embedder adapter", () => {
  it("discovers its dimension by probing the wire when none is configured", async () => {
    const copilot = fakeCopilot(1536);
    const embedder = await CopilotEmbedder.create({ getApiKey: getApiKey() });
    expect(embedder.dimension).toBe(1536);
    expect(embedder.modelName).toBe("text-embedding-3-small");
    expect(copilot.calls).toHaveLength(1);
    expect(copilot.calls[0].url).toBe("https://api.enterprise.githubcopilot.com/embeddings");
    expect(copilot.calls[0].headers).toMatchObject({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
      "Copilot-Integration-Id": "vscode-chat",
    });
    expect(copilot.calls[0].body).toEqual({
      model: "text-embedding-3-small",
      input: "dimension probe",
    });
  });

  it("reuses the discovered dimension — no second probe across embeds", async () => {
    const copilot = fakeCopilot(1536);
    const embedder = await CopilotEmbedder.create({ getApiKey: getApiKey() });
    await embedder.embed("first");
    await embedder.embed("second");
    expect(embedder.dimension).toBe(1536);
    const probes = copilot.calls.filter((c) => c.body.input === "dimension probe");
    expect(probes).toHaveLength(1);
    expect(copilot.calls).toHaveLength(3); // probe + two embeds
  });

  it("surfaces URL, model, status, and body on an HTTP error", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ error: "server exploded" }), { status: 500 }),
    );
    const err = await CopilotEmbedder.create({
      getApiKey: getApiKey(),
      model: "missing-model",
      baseUrl: "https://example.test/copilot",
    }).then(
      () => {
        throw new Error("expected rejection");
      },
      (e: Error) => e,
    );
    expect(err.message).toContain("https://example.test/copilot/embeddings");
    expect(err.message).toContain("missing-model");
    expect(err.message).toContain("500");
    expect(err.message).toContain("server exploded");
  });

  it("refreshes the API key and retries once on HTTP 401", async () => {
    const key = vi.fn(async () => (key.mock.calls.length === 1 ? "expired-key" : "fresh-key"));
    const calls: RecordedCall[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as RecordedCall["body"];
      calls.push({ url: String(url), headers: init.headers as Record<string, string>, body });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      }
      return new Response(
        JSON.stringify({ data: [{ embedding: vectorFor(body.input, 1536), index: 0 }] }),
        { status: 200 },
      );
    });

    const embedder = await CopilotEmbedder.create({ getApiKey: key, dimension: 1536 });
    await expect(embedder.embed("hello")).resolves.toHaveLength(1536);
    expect(key).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(2);
    expect(calls[0].headers.Authorization).toBe("Bearer expired-key");
    expect(calls[1].headers.Authorization).toBe("Bearer fresh-key");
  });

  it("throws after a single retry when HTTP 401 repeats", async () => {
    const key = vi.fn(async () => "still-bad-key");
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    );
    const embedder = await CopilotEmbedder.create({ getApiKey: key, dimension: 1536 });
    await expect(embedder.embed("hello")).rejects.toThrow(/401/);
    expect(key).toHaveBeenCalledTimes(2);
  });

  it("throws a contract-violation error when data[0].embedding is missing", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ data: [{ index: 0 }], detail: "missing embedding" }), {
          status: 200,
        }),
    );
    await expect(CopilotEmbedder.create({ getApiKey: getApiKey() })).rejects.toThrow(
      /data\[0\]\.embedding.*missing embedding/s,
    );
  });

  it("returns unit-norm vectors (defensive re-normalization)", async () => {
    fakeCopilot(1536);
    const embedder = await CopilotEmbedder.create({ getApiKey: getApiKey() });
    const v = await embedder.embed("the user prefers oat milk");
    expect(v).toHaveLength(1536);
    const sumSquares = v.reduce((s, x) => s + x * x, 0);
    expect(Math.abs(sumSquares - 1)).toBeLessThan(1e-9);
  });

  it("throws immediately when getApiKey returns undefined", async () => {
    const copilot = fakeCopilot(1536);
    const embedder = await CopilotEmbedder.create({
      getApiKey: vi.fn(async () => undefined),
      dimension: 1536,
    });
    await expect(embedder.embed("hello")).rejects.toThrow(/api key/i);
    expect(copilot.calls).toHaveLength(0);
  });

  it("composes with CachedEmbedder — repeat embeds never hit the inner embedder", async () => {
    fakeCopilot(1536);
    const copilot = await CopilotEmbedder.create({ getApiKey: getApiKey() });
    const inner = countingEmbedder(copilot);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltm-copilot-cache-"));
    const cached = new CachedEmbedder(inner, dir, copilot.modelName);
    const a = await cached.embed("hello world");
    expect(inner.calls).toBe(1);
    const b = await cached.embed("hello world");
    expect(inner.calls).toBe(1); // cache hit, no new inner embed
    expect(b).toEqual(a);
  });

  it("skips probe for configured dimension and fails loudly when the wire disagrees", async () => {
    const copilot = fakeCopilot(100);
    const embedder = await CopilotEmbedder.create({
      getApiKey: getApiKey(),
      dimension: 1536,
    });
    expect(embedder.dimension).toBe(1536);
    expect(copilot.calls).toHaveLength(0);
    await expect(embedder.embed("anything")).rejects.toThrow(/100-dim vector.*1536-dim/s);
  });
});
