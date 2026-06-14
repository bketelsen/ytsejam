import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CachedEmbedder, HashEmbedder } from "ltm";
import { createLtmEmbedder, type AuthStoreLike } from "../src/memory/embedder.ts";

function cacheDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ytsejam-ltm-embedder-cache-"));
}

function authStore(hasCredentials: boolean, key = "test-copilot-token"): AuthStoreLike {
  return {
    hasCredentials: vi.fn((provider: string) => provider === "github-copilot" && hasCredentials),
    getApiKey: vi.fn(async (provider: string) =>
      provider === "github-copilot" && hasCredentials ? key : undefined,
    ),
  };
}

function vector(dimension: number): number[] {
  return new Array<number>(dimension).fill(0).map((_, i) => i + 1);
}

function cachedInternals(embedder: unknown): { inner: { dimension: number }; namespace: string } {
  return embedder as { inner: { dimension: number }; namespace: string };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runtime LTM embedder factory", () => {
  it("creates pinned hash mode as a HashEmbedder wrapped in CachedEmbedder with the hash namespace", async () => {
    const result = await createLtmEmbedder(authStore(false), {
      mode: "hash",
      cacheDir: cacheDir(),
    });

    expect(result.label).toBe("hash:256");
    expect(result.dimension).toBe(256);
    expect(result.embedder).toBeInstanceOf(CachedEmbedder);
    expect(cachedInternals(result.embedder).namespace).toBe("hash:256");
    expect(cachedInternals(result.embedder).inner).toBeInstanceOf(HashEmbedder);
  });

  it("rejects pinned copilot mode without Copilot credentials and explains how to opt down", async () => {
    await expect(
      createLtmEmbedder(authStore(false), {
        mode: "copilot",
        cacheDir: cacheDir(),
      }),
    ).rejects.toThrow(/YTSEJAM_LTM_EMBEDDER=.*(ollama|hash)/);
  });

  it("rejects pinned ollama mode when the configured service URL is unreachable and explains how to opt down", async () => {
    const url = "http://127.0.0.1:1";
    const err = await createLtmEmbedder(authStore(false), {
      mode: "ollama",
      cacheDir: cacheDir(),
      ollama: { baseUrl: url },
    }).then(
      () => {
        throw new Error("expected rejection");
      },
      (e: Error) => e,
    );

    expect(err.message).toContain(url);
    expect(err.message).toContain("YTSEJAM_LTM_EMBEDDER=ollama");
    expect(err.message).toMatch(/hash|auto|copilot/);
  });

  it("selects Copilot in auto mode when Copilot credentials are present and the probe succeeds", async () => {
    vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit) => {
      expect(String(url)).toBe("https://api.enterprise.githubcopilot.com/embeddings");
      expect(JSON.parse(init.body as string)).toEqual({
        input: "dimension probe",
        model: "text-embedding-3-small",
      });
      return new Response(JSON.stringify({ data: [{ embedding: vector(1536), index: 0 }] }), {
        status: 200,
      });
    });

    const result = await createLtmEmbedder(authStore(true), {
      mode: "auto",
      cacheDir: cacheDir(),
    });

    expect(result.label).toBe("copilot:text-embedding-3-small");
    expect(result.dimension).toBe(1536);
    expect(result.embedder).toBeInstanceOf(CachedEmbedder);
  });

  it("selects Ollama in auto mode when Copilot credentials are absent and the Ollama probe succeeds", async () => {
    vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit) => {
      expect(String(url)).toBe("http://localhost:11434/api/embed");
      expect(JSON.parse(init.body as string)).toEqual({
        input: "dimension probe",
        model: "nomic-embed-text:latest",
      });
      return new Response(JSON.stringify({ embeddings: [vector(768)] }), { status: 200 });
    });

    const result = await createLtmEmbedder(authStore(false), {
      mode: "auto",
      cacheDir: cacheDir(),
    });

    expect(result.label).toBe("ollama:nomic-embed-text:latest");
    expect(result.dimension).toBe(768);
    expect(result.embedder).toBeInstanceOf(CachedEmbedder);
  });

  it("falls back to HashEmbedder in auto mode when neither Copilot nor Ollama is available and logs a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });

    const result = await createLtmEmbedder(authStore(false), {
      mode: "auto",
      cacheDir: cacheDir(),
    });

    expect(result.label).toBe("hash:256");
    expect(result.dimension).toBe(256);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Falling back to HashEmbedder"));
  });

  it("reports a dimension field matching the wrapped embedder dimension for hash and copilot modes", async () => {
    vi.stubGlobal("fetch", async (url: string | URL) => {
      if (String(url).includes("api.enterprise.githubcopilot.com")) {
        return new Response(JSON.stringify({ data: [{ embedding: vector(1536), index: 0 }] }), {
          status: 200,
        });
      }
      throw new Error(`unexpected fetch to ${String(url)}`);
    });

    const hash = await createLtmEmbedder(authStore(false), {
      mode: "hash",
      cacheDir: cacheDir(),
    });
    const copilot = await createLtmEmbedder(authStore(true), {
      mode: "copilot",
      cacheDir: cacheDir(),
    });

    expect(hash.dimension).toBe(cachedInternals(hash.embedder).inner.dimension);
    expect(copilot.dimension).toBe(cachedInternals(copilot.embedder).inner.dimension);
  });

  it("returns a CachedEmbedder instance", async () => {
    const result = await createLtmEmbedder(authStore(false), {
      mode: "hash",
      cacheDir: cacheDir(),
    });

    expect(result.embedder).toBeInstanceOf(CachedEmbedder);
  });
});
