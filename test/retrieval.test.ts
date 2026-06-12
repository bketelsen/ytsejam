import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HashEmbedder, cosine } from "../src/embedding/embedder.ts";
import { Bm25Index } from "../src/retrieval/lexical.ts";
import { MemorySystem } from "../src/api/memory-system.ts";
import { generateFixtures } from "../src/eval/synthetic.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ltm-test-"));
}

describe("hash embedder", () => {
  const embedder = new HashEmbedder(128);

  it("is deterministic and unit-norm", async () => {
    const a = await embedder.embed("my sister Alice lives in Boulder");
    const b = await embedder.embed("my sister Alice lives in Boulder");
    expect(a).toEqual(b);
    const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("scores related texts above unrelated ones", async () => {
    const q = await embedder.embed("what is my sister's name?");
    const related = await embedder.embed("my sister Alice is visiting next month");
    const unrelated = await embedder.embed("the deploy pipeline failed on staging again");
    expect(cosine(q, related)).toBeGreaterThan(cosine(q, unrelated));
  });
});

describe("bm25", () => {
  it("ranks exact-term matches above non-matches and supports removal", () => {
    const index = new Bm25Index();
    index.add("a", "my dog Biscuit went to the vet");
    index.add("b", "kubernetes ingress controller configuration");
    index.add("c", "the vet recommended a new diet for the dog");

    const hits = index.search("dog vet Biscuit", 3);
    expect(hits[0].id).toBe("a");
    expect(hits.map((h) => h.id)).not.toContain("b");

    index.remove("a");
    expect(index.search("Biscuit", 3).map((h) => h.id)).not.toContain("a");
  });
});

describe("end-to-end retrieval over synthetic sessions", () => {
  it("surfaces planted facts and the user profile for a probe", async () => {
    const work = tmpDir();
    const truth = generateFixtures({ outDir: path.join(work, "sessions"), sessions: 4, turnsPerSession: 8, seed: 7 });
    const mem = MemorySystem.open({ storeDir: path.join(work, "store"), now: () => truth.horizonEnd });
    await mem.ingestSessionDir(path.join(work, "sessions"));

    const { items, profile } = await mem.retrieve("What is my sister's name?", { k: 5, dryRun: true });
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.record.text.includes("Alice"))).toBe(true);
    expect(profile.identity.some((f) => f.object === "Brian")).toBe(true);

    for (const item of items) {
      expect(item.breakdown.total).toBeCloseTo(item.score, 8);
    }
  });

  it("composeContext renders profile and memories within budget", async () => {
    const work = tmpDir();
    const truth = generateFixtures({ outDir: path.join(work, "sessions"), sessions: 4, turnsPerSession: 8, seed: 7 });
    const mem = MemorySystem.open({ storeDir: path.join(work, "store"), now: () => truth.horizonEnd });
    await mem.ingestSessionDir(path.join(work, "sessions"));

    const context = await mem.composeContext("planning coffee with my sister", { k: 6, tokenBudget: 600 });
    expect(context).toContain("What you know about the user");
    expect(context).toContain("Standing instructions:");
    expect(context.length / 4).toBeLessThan(600 + 400); // profile rides on top of episodic budget
  });

  it("retrieval access bumps slow decay (accessCount persisted)", async () => {
    const work = tmpDir();
    const truth = generateFixtures({ outDir: path.join(work, "sessions"), sessions: 3, turnsPerSession: 6, seed: 11 });
    const mem = MemorySystem.open({ storeDir: path.join(work, "store"), now: () => truth.horizonEnd });
    await mem.ingestSessionDir(path.join(work, "sessions"));

    const before = await mem.retrieve("What's my dog called?", { k: 3 });
    const hit = before.items.find((i) => i.record.text.includes("Biscuit"));
    expect(hit).toBeDefined();
    const after = mem.getRecord(hit!.record.id)!;
    expect(after.accessCount).toBe(1);
  });

  it("ingestion is incremental: re-ingesting the same dir adds nothing", async () => {
    const work = tmpDir();
    generateFixtures({ outDir: path.join(work, "sessions"), sessions: 2, turnsPerSession: 6, seed: 3 });
    const mem = MemorySystem.open({ storeDir: path.join(work, "store") });
    const first = await mem.ingestSessionDir(path.join(work, "sessions"));
    expect(first.recordsCreated).toBeGreaterThan(0);
    const second = await mem.ingestSessionDir(path.join(work, "sessions"));
    expect(second.recordsCreated).toBe(0);
    expect(second.turnsIngested).toBe(0);
  });
});
