import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CachedEmbedder } from "../src/embedding/cached-embedder.ts";
import type { Embedder } from "../src/embedding/embedder.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ltm-cache-"));
}

function countingEmbedder(dimension = 4): Embedder & { calls: number } {
  const stub = {
    dimension,
    calls: 0,
    embed(text: string): Promise<number[]> {
      stub.calls++;
      const v = new Array<number>(dimension).fill(0);
      v[text.length % dimension] = 1;
      return Promise.resolve(v);
    },
  };
  return stub;
}

describe("cached embedder (PLAN 4.1)", () => {
  it("second embed of the same text is a cache hit", async () => {
    const inner = countingEmbedder();
    const cached = new CachedEmbedder(inner, tmpDir());
    const a = await cached.embed("hello world");
    const b = await cached.embed("hello world");
    expect(inner.calls).toBe(1);
    expect(b).toEqual(a);
  });

  it("cache survives across instances (disk layer)", async () => {
    const dir = tmpDir();
    const first = countingEmbedder();
    await new CachedEmbedder(first, dir).embed("persistent text");
    const second = countingEmbedder();
    const v = await new CachedEmbedder(second, dir).embed("persistent text");
    expect(second.calls).toBe(0);
    expect(v.some((x) => x === 1)).toBe(true);
  });

  it("namespaces by embedder identity and dimension", async () => {
    const dir = tmpDir();
    const a = countingEmbedder(4);
    const b = countingEmbedder(8);
    await new CachedEmbedder(a, dir, "model-a").embed("same text");
    await new CachedEmbedder(b, dir, "model-b").embed("same text");
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(1); // no cross-model hit
  });

  it("recovers from a corrupt cache entry", async () => {
    const dir = tmpDir();
    const inner = countingEmbedder();
    const cached = new CachedEmbedder(inner, dir);
    await cached.embed("text");
    // Corrupt every cache file on disk.
    for (const sub of fs.readdirSync(dir)) {
      for (const f of fs.readdirSync(path.join(dir, sub))) {
        fs.writeFileSync(path.join(dir, sub, f), "{not json");
      }
    }
    const fresh = new CachedEmbedder(countingEmbedder(), dir);
    const v = await fresh.embed("text");
    expect(v).toHaveLength(4);
  });
});
