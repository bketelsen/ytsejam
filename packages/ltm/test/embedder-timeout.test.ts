import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithTimeout, DEFAULT_EMBED_TIMEOUT_MS } from "../src/embedding/embedder.ts";
import { CopilotEmbedder } from "../src/embedding/copilot-embedder.ts";
import { OllamaEmbedder } from "../src/embedding/ollama-embedder.ts";

/**
 * MEM-H2: HTTP embedders must bound their fetch with a timeout so a hung
 * endpoint (black-holed TCP / stalled proxy) can't pin the caller — which, on
 * the nightly dream maintenance path, would wedge the whole job forever.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("fetchWithTimeout", () => {
  it("rejects with a timeout error when the request never settles", async () => {
    // A fetch that respects the abort signal but otherwise never resolves.
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      })) as typeof fetch;

    const started = Date.now();
    await expect(fetchWithTimeout("https://example.test/x", {}, 50)).rejects.toThrow(/timed out after 50ms/);
    // Must reject promptly (bounded), not hang.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("passes through a normal response and clears the timer", async () => {
    globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch;
    const res = await fetchWithTimeout("https://example.test/x", {}, 1_000);
    expect(res.status).toBe(200);
  });

  it("re-throws a non-abort fetch error unchanged", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    await expect(fetchWithTimeout("https://example.test/x", {}, 1_000)).rejects.toThrow(/ECONNREFUSED/);
  });

  it("exposes a sane default timeout", () => {
    expect(DEFAULT_EMBED_TIMEOUT_MS).toBe(30_000);
  });
});

describe("CopilotEmbedder timeout wiring", () => {
  it("times out a hung embeddings request", async () => {
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as typeof fetch;

    // dimension set so create() skips the probe; embed() drives the timed fetch.
    const embedder = await CopilotEmbedder.create({
      getApiKey: async () => "tok",
      dimension: 1536,
      timeoutMs: 50,
    });
    await expect(embedder.embed("hello")).rejects.toThrow(/timed out after 50ms/);
  });
});

describe("OllamaEmbedder timeout wiring", () => {
  it("times out a hung embed request", async () => {
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as typeof fetch;

    const embedder = await OllamaEmbedder.create({
      model: "nomic-embed-text:latest",
      dimension: 768,
      timeoutMs: 50,
    });
    await expect(embedder.embed("hello")).rejects.toThrow(/timed out after 50ms/);
  });
});
