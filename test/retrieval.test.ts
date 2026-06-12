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

describe("score-channel normalization (PLAN 2.2)", () => {
  it("when vector and lexical agree on the top doc, both channels read 1.0", async () => {
    const work = tmpDir();
    const truth = generateFixtures({ outDir: path.join(work, "sessions"), sessions: 3, turnsPerSession: 8, seed: 7 });
    const mem = MemorySystem.open({ storeDir: path.join(work, "store"), now: () => truth.horizonEnd });
    await mem.ingestSessionDir(path.join(work, "sessions"));

    // Query a verbatim planted phrase: the same record must top both channels.
    const ranked = await mem.explain("my sister Alice is visiting next month", 5);
    const top = ranked[0];
    expect(top.record.text).toContain("Alice");
    expect(top.breakdown.vector).toBeCloseTo(1, 6);
    expect(top.breakdown.lexical).toBeCloseTo(1, 6);
    // No channel may exceed its normalized range.
    for (const item of ranked) {
      expect(item.breakdown.vector).toBeLessThanOrEqual(1);
      expect(item.breakdown.lexical).toBeLessThanOrEqual(1);
    }
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
    // Promoted slot facts are synthetic; pick the real episodic record.
    const hit = before.items.find((i) => i.record.kind !== "fact" && i.record.text.includes("Biscuit"));
    expect(hit).toBeDefined();
    const after = mem.getRecord(hit!.record.id)!;
    expect(after.accessCount).toBe(1);
  });

  it("profile facts promote into results for zero-overlap paraphrase queries (PLAN 4.3)", async () => {
    const work = tmpDir();
    const truth = generateFixtures({ outDir: path.join(work, "sessions"), sessions: 4, turnsPerSession: 8, seed: 7 });
    const mem = MemorySystem.open({ storeDir: path.join(work, "store"), now: () => truth.horizonEnd });
    await mem.ingestSessionDir(path.join(work, "sessions"));

    // "employed" shares no content words with "I work at Initech…".
    const { items } = await mem.retrieve("Where am I currently employed?", { k: 5, dryRun: true });
    const promoted = items.find((i) => i.record.kind === "fact");
    expect(promoted).toBeDefined();
    expect(promoted!.record.text).toContain("Initech");
    expect(items[0].record.kind).toBe("fact"); // slot answers lead

    // Synthetic records are never persisted.
    expect(mem.getRecord(promoted!.record.id)).toBeUndefined();
    expect(mem.listEpisodic().every((r) => r.kind !== "fact")).toBe(true);

    // A query touching no profile predicate promotes nothing.
    const none = await mem.retrieve("how do I parse YAML?", { k: 5, dryRun: true });
    expect(none.items.every((i) => i.record.kind !== "fact")).toBe(true);
  });

  it("1000 retrievals grow the episodic log by O(k·log n), not O(k·n) (PLAN 2.6)", async () => {
    const work = tmpDir();
    const truth = generateFixtures({ outDir: path.join(work, "sessions"), sessions: 3, turnsPerSession: 6, seed: 11 });
    const storeDir = path.join(work, "store");
    const mem = MemorySystem.open({ storeDir, now: () => truth.horizonEnd });
    await mem.ingestSessionDir(path.join(work, "sessions"));

    const logPath = path.join(storeDir, "episodic.jsonl");
    const linesBefore = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).length;

    const queries = 1000;
    const k = 3;
    for (let i = 0; i < queries; i++) {
      await mem.retrieve("What's my dog called?", { k });
    }

    const linesAfter = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).length;
    // Power-of-two flushing: each of the ≤k surfaced records appends at most
    // floor(log2(queries)) + 1 snapshots.
    const maxExtra = k * (Math.floor(Math.log2(queries)) + 1);
    expect(linesAfter - linesBefore).toBeLessThanOrEqual(maxExtra);

    // The in-memory count is exact and survives reopen at its last flush.
    const hit = (await mem.retrieve("What's my dog called?", { k, dryRun: true })).items.find(
      (i) => i.record.kind !== "fact" && i.record.text.includes("Biscuit"),
    )!;
    expect(hit.record.accessCount).toBe(queries);
    mem.close();
    const reopened = MemorySystem.open({ storeDir, now: () => truth.horizonEnd });
    const persisted = reopened.getRecord(hit.record.id)!;
    expect(persisted.accessCount).toBeGreaterThanOrEqual(512); // last power of two ≤ 1000
  });

  it("retrieval trace log records query, k, and score breakdowns (PLAN 5.3)", async () => {
    const work = tmpDir();
    const truth = generateFixtures({ outDir: path.join(work, "sessions"), sessions: 2, turnsPerSession: 6, seed: 13 });
    const tracePath = path.join(work, "trace", "retrievals.jsonl");
    const mem = MemorySystem.open({
      storeDir: path.join(work, "store"),
      now: () => truth.horizonEnd,
      retrievalLog: tracePath,
    });
    await mem.ingestSessionDir(path.join(work, "sessions"));

    await mem.retrieve("What's my dog called?", { k: 4 });
    await mem.retrieve("marathon training", { k: 2, dryRun: true }); // dryRun traces too

    const lines = fs.readFileSync(tracePath, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]) as {
      at: string;
      query: string;
      k: number;
      returned: { id: string; score: number; breakdown: { lexical: number } }[];
    };
    expect(first.query).toBe("What's my dog called?");
    expect(first.k).toBe(4);
    expect(first.returned.length).toBeGreaterThan(0);
    expect(first.returned[0].breakdown).toHaveProperty("lexical");
    // Without the env/option, nothing is written.
    const silent = MemorySystem.open({ storeDir: path.join(work, "store2") });
    silent.close();
    expect(fs.existsSync(path.join(work, "store2", "retrievals.jsonl"))).toBe(false);
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
