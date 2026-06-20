import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemorySystem } from "../src/api/memory-system.ts";
import { HashEmbedder } from "../src/embedding/embedder.ts";
import type { EpisodicRecord } from "../src/types.ts";

/**
 * D2 integration regression: a store that already holds mixed-dimension
 * embeddings (the live contamination — 1536-dim Copilot vectors plus ~108
 * 256-dim hash-fallback vectors) must serve retrieval WITHOUT crashing, and
 * must exclude the off-dimension records rather than score them as garbage.
 * Drives the full MemorySystem retrieve() path over a seeded on-disk store.
 */

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ltm-dim-"));
}

function unit(dim: number, seed: number): number[] {
  // Deterministic non-zero unit-norm vector of the given dimension.
  const v = Array.from({ length: dim }, (_, i) => Math.sin(seed + i) + 1.0001);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

function rec(id: string, text: string, embedding: number[]): EpisodicRecord {
  return {
    id,
    kind: "turn",
    sessionId: "s1",
    entryId: id,
    role: "user",
    text,
    timestamp: "2026-01-01T00:00:00.000Z",
    salience: 0.5,
    accessCount: 0,
    state: "active",
    embedding,
  };
}

describe("MemorySystem retrieve over a mixed-dimension store (D2)", () => {
  const GOOD = 64; // the HashEmbedder dimension we open with
  const BAD = 256; // a contaminant dimension (the hash-fallback footprint)

  function seed(storeDir: string): void {
    fs.mkdirSync(storeDir, { recursive: true });
    const lines = [
      rec("good-1", "the quick brown fox", unit(GOOD, 1)),
      rec("good-2", "lazy dog sleeps", unit(GOOD, 2)),
      rec("bad-1", "contaminated record one", unit(BAD, 3)),
      rec("bad-2", "contaminated record two", unit(BAD, 4)),
    ].map((r) => JSON.stringify(r));
    fs.writeFileSync(path.join(storeDir, "episodic.jsonl"), `${lines.join("\n")}\n`);
  }

  it("does not throw and returns only matching-dimension records", async () => {
    const storeDir = path.join(tmp(), "ltm");
    seed(storeDir);
    const mem = MemorySystem.open({ storeDir, embedder: new HashEmbedder(GOOD) });
    try {
      const result = await mem.retrieve("quick brown fox", { k: 8 });
      const ids = result.items.map((m) => m.record.id);
      // The off-dimension records must not appear — they are excluded, not
      // scored. (They would have crashed the now-throwing cosine if admitted.)
      expect(ids).not.toContain("bad-1");
      expect(ids).not.toContain("bad-2");
      // The good records are retrievable.
      expect(ids).toContain("good-1");
    } finally {
      mem.close();
    }
  });

  it("pins to the MAJORITY dimension even when contaminants appear first (live shape)", async () => {
    // The real store's FIRST record is a 256-dim hash-fallback contaminant.
    // A first-seen index would pin to 256 and refuse every good 1536-dim
    // record — gutting retrieval. Majority-dim wins: the BAD bucket is the
    // minority here, so it is excluded and the GOOD records survive.
    const storeDir = path.join(tmp(), "ltm");
    fs.mkdirSync(storeDir, { recursive: true });
    const lines = [
      rec("bad-first", "contaminant seen first", unit(BAD, 9)), // FIRST on disk
      rec("good-1", "the quick brown fox", unit(GOOD, 1)),
      rec("good-2", "lazy dog sleeps", unit(GOOD, 2)),
      rec("good-3", "another good record", unit(GOOD, 5)),
    ].map((r) => JSON.stringify(r));
    fs.writeFileSync(path.join(storeDir, "episodic.jsonl"), `${lines.join("\n")}\n`);

    const mem = MemorySystem.open({ storeDir, embedder: new HashEmbedder(GOOD) });
    try {
      const result = await mem.retrieve("quick brown fox", { k: 8 });
      const ids = result.items.map((m) => m.record.id);
      expect(ids).not.toContain("bad-first"); // minority dim excluded
      expect(ids).toContain("good-1"); // majority dim retrievable
    } finally {
      mem.close();
    }
  });

  it("dimensionReport counts every bucket from disk and names the primary", () => {
    const storeDir = path.join(tmp(), "ltm");
    seed(storeDir);
    const mem = MemorySystem.open({ storeDir, embedder: new HashEmbedder(GOOD) });
    try {
      const report = mem.dimensionReport();
      expect(report.counts[GOOD]).toBe(2);
      expect(report.counts[BAD]).toBe(2);
      expect(report.total).toBe(4);
      // Tie broken by iteration order; with equal counts primary is whichever
      // was seen first (GOOD). Assert it is one of the present dimensions.
      expect([GOOD, BAD]).toContain(report.primary);
    } finally {
      mem.close();
    }
  });

  it("primaryIndexDimension() returns the MAJORITY, not the first-sampled record (MEM-H1 boot gate)", () => {
    // A contaminant of dimension BAD is FIRST on disk, but GOOD is the majority.
    // indexDimension() samples the first-pinned vector (BAD); primaryIndexDimension()
    // must return the majority (GOOD) so the boot dimension-mismatch gate keys off
    // the dimension retrieval actually uses — otherwise the gate compares against a
    // lone contaminant and can both wrongly pass a mismatched embedder and wrongly
    // disable LTM under the correct one.
    const storeDir = path.join(tmp(), "ltm");
    fs.mkdirSync(storeDir, { recursive: true });
    const lines = [
      rec("bad-first", "contaminant seen first", unit(BAD, 9)), // FIRST on disk
      rec("good-1", "alpha", unit(GOOD, 1)),
      rec("good-2", "beta", unit(GOOD, 2)),
      rec("good-3", "gamma", unit(GOOD, 5)),
    ].map((r) => JSON.stringify(r));
    fs.writeFileSync(path.join(storeDir, "episodic.jsonl"), `${lines.join("\n")}\n`);

    const mem = MemorySystem.open({ storeDir, embedder: new HashEmbedder(GOOD) });
    try {
      // The OLD gate input — first-sampled — returns the contaminant.
      expect(mem.indexDimension()).toBe(BAD);
      // The NEW gate input — majority — returns the dimension retrieval uses.
      expect(mem.primaryIndexDimension()).toBe(GOOD);
    } finally {
      mem.close();
    }
  });

  it("primaryIndexDimension() is null on an empty store", () => {
    const storeDir = path.join(tmp(), "ltm");
    const mem = MemorySystem.open({ storeDir, embedder: new HashEmbedder(GOOD) });
    try {
      expect(mem.primaryIndexDimension()).toBeNull();
    } finally {
      mem.close();
    }
  });
});
