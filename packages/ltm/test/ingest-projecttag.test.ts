// packages/ltm/test/ingest-projecttag.test.ts
// Task 3: thread projectTag through ingestSessionFile → IngestPipeline → ingestTurn

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IngestPipeline } from "../src/pipeline/ingest.ts";
import { SemanticStore } from "../src/semantic/store.ts";
import type { FactExtractor, FactCandidate } from "../src/semantic/fact-extractor.ts";
import type { EpisodicStore } from "../src/episodic/store.ts";
import type { Embedder } from "../src/embedding/embedder.ts";
import { mergeConfig } from "../src/types.ts";
import { MemorySystem } from "../src/api/memory-system.ts";

// Minimal fake embedder
const fakeEmbedder: Embedder = {
  embed: async () => [0.1, 0.2, 0.3],
  dimension: 3,
};

// Fake episodic store that accepts upserts
class FakeEpisodic {
  records: unknown[] = [];
  upsert(r: unknown) { this.records.push(r); }
  upsertMany(rs: unknown[]) { for (const r of rs) this.records.push(r); }
  get() { return undefined; }
  all() { return this.records as never[]; }
  delete() { /* noop */ }
  close() { /* noop */ }
}

// Fake extractor that always returns one project-scoped candidate
class FakeExtractor {
  async extract(): Promise<FactCandidate[]> {
    return [{
      kind: "directive",
      predicate: "prefers",
      object: "typescript",
      polarity: 1,
      initialStrength: 0.9,
      scope: "project",
    }];
  }
}

const config = mergeConfig();

let tmpDir: string;
afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTmpDir(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ltm-ingest-tag-"));
  return tmpDir;
}

// Write a minimal session JSONL fixture
function writeSessionFixture(dir: string, sessionId: string): string {
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-06-19T00:00:00.000Z", cwd: "/home/user" }),
    JSON.stringify({
      type: "message",
      id: "e0000001",
      parentId: null,
      timestamp: "2026-06-19T00:01:00.000Z",
      message: { role: "user", content: "I prefer TypeScript for this project.", timestamp: 1750291260000 },
    }),
  ];
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
  return filePath;
}

describe("IngestPipeline.ingestFile with projectTag", () => {
  it("passes projectTag to semantic.ingestTurn for project-scoped facts", async () => {
    const dir = makeTmpDir();
    const SESSION_ID = "aaaaaaaa-0000-7000-8000-111111111111";
    const filePath = writeSessionFixture(dir, SESSION_ID);

    const semanticStore = SemanticStore.open(dir, new FakeExtractor() as unknown as FactExtractor);
    const episodic = new FakeEpisodic() as unknown as EpisodicStore;

    const pipeline = new IngestPipeline({
      storeDir: dir,
      episodic,
      semantic: semanticStore,
      embedder: fakeEmbedder,
      config,
    });

    await pipeline.ingestFile(filePath, { projectTag: "projects:ytsejam" });

    const facts = semanticStore.allFacts();
    const fact = facts.find((f) => f.object === "typescript");
    expect(fact).toBeDefined();
    expect(fact?.projectTag).toBe("projects:ytsejam");
  });

  it("does not stamp projectTag when none is provided (back-compat)", async () => {
    const dir = makeTmpDir();
    const SESSION_ID = "bbbbbbbb-0000-7000-8000-222222222222";
    const filePath = writeSessionFixture(dir, SESSION_ID);

    const semanticStore = SemanticStore.open(dir, new FakeExtractor() as unknown as FactExtractor);
    const episodic = new FakeEpisodic() as unknown as EpisodicStore;

    const pipeline = new IngestPipeline({
      storeDir: dir,
      episodic,
      semantic: semanticStore,
      embedder: fakeEmbedder,
      config,
    });

    // No opts — should behave as before
    await pipeline.ingestFile(filePath);

    const facts = semanticStore.allFacts();
    const fact = facts.find((f) => f.object === "typescript");
    expect(fact).toBeDefined();
    expect(fact?.projectTag).toBeUndefined();
  });
});

describe("MemorySystem.ingestSessionFile with projectTag (stamps projectTag end-to-end)", () => {
  it("accepts opts.projectTag and threads it to the pipeline", async () => {
    const dir = makeTmpDir();
    const semanticDir = path.join(dir, "store");
    fs.mkdirSync(semanticDir);
    const SESSION_ID = "cccccccc-0000-7000-8000-333333333333";
    const filePath = writeSessionFixture(semanticDir, SESSION_ID);

    const mem = MemorySystem.open({
      storeDir: semanticDir,
      factExtractor: new FakeExtractor() as unknown as FactExtractor,
    });

    try {
      // This should type-check and run without error
      const report = await mem.ingestSessionFile(filePath, { projectTag: "projects:ytsejam" });
      expect(report.turnsIngested).toBeGreaterThan(0);

      const facts = mem.listFacts();
      const fact = facts.find((f) => f.object === "typescript");
      expect(fact).toBeDefined();
      expect(fact?.projectTag).toBe("projects:ytsejam");
    } finally {
      mem.close();
    }
  });

  it("ingestSessionDir also forwards projectTag", async () => {
    const dir = makeTmpDir();
    const storeDir = path.join(dir, "store2");
    fs.mkdirSync(storeDir);
    const SESSION_ID = "dddddddd-0000-7000-8000-444444444444";
    writeSessionFixture(storeDir, SESSION_ID);

    const mem = MemorySystem.open({
      storeDir,
      factExtractor: new FakeExtractor() as unknown as FactExtractor,
    });

    try {
      const report = await mem.ingestSessionDir(storeDir, { projectTag: "projects:ytsejam" });
      expect(report.turnsIngested).toBeGreaterThan(0);

      const facts = mem.listFacts();
      const fact = facts.find((f) => f.object === "typescript");
      expect(fact).toBeDefined();
      expect(fact?.projectTag).toBe("projects:ytsejam");
    } finally {
      mem.close();
    }
  });
});
