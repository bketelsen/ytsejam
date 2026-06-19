import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemorySystem } from "../src/api/memory-system.ts";
import type { Embedder } from "../src/embedding/embedder.ts";
import type { FactExtractor, FactCandidate } from "../src/semantic/fact-extractor.ts";

/** Counts embed() calls; throws if ever handed an empty string (the bug). */
class CountingEmbedder implements Embedder {
  readonly dimension = 8;
  calls = 0;
  async embed(text: string): Promise<number[]> {
    this.calls++;
    if (!text.trim()) throw new Error("embed called with empty string");
    const v = new Array(8).fill(0);
    for (let i = 0; i < text.length; i++) v[i % 8] += text.charCodeAt(i);
    return v;
  }
}

class Fake implements FactExtractor {
  out: FactCandidate[];
  constructor(out: FactCandidate[]) {
    this.out = out;
  }
  async extract(): Promise<FactCandidate[]> {
    return this.out;
  }
}

async function withMem<T>(fn: (mem: MemorySystem, emb: CountingEmbedder) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ltm-empty-q-"));
  const emb = new CountingEmbedder();
  const mem = MemorySystem.open({
    storeDir: dir,
    embedder: emb,
    factExtractor: new Fake([
      { kind: "identity", predicate: "name", object: "Brian", polarity: 1, initialStrength: 0.9 },
    ]),
  });
  try {
    return await fn(mem, emb);
  } finally {
    mem.close();
    await rm(dir, { recursive: true, force: true });
  }
}

describe("empty-query recall guard", () => {
  it("returns profile-only and never embeds an empty/whitespace query", async () => {
    await withMem(async (mem, emb) => {
      await mem.recordObservation({ text: "hi there", timestamp: "2026-06-19T00:00:00Z" });
      const before = emb.calls;

      const empty = await mem.retrieve("");
      expect(empty.items).toEqual([]); // no episodic hits
      expect(empty.profile.identity.map((f) => f.object)).toContain("Brian");

      const ws = await mem.retrieve("   \n\t ");
      expect(ws.items).toEqual([]);

      // The whole point: neither call reached the embedder.
      expect(emb.calls).toBe(before);
    });
  });

  it("a real query DOES embed (the guard is empty-only)", async () => {
    await withMem(async (mem, emb) => {
      await mem.recordObservation({ text: "hi there", timestamp: "2026-06-19T00:00:00Z" });
      const before = emb.calls;
      await mem.retrieve("what is my name");
      expect(emb.calls).toBeGreaterThan(before);
    });
  });
});
