import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vectorPromoteFacts } from "../src/retrieval/promote.ts";
import { SemanticStore } from "../src/semantic/store.ts";
import type { Embedder } from "../src/embedding/embedder.ts";
import type { FactExtractor, FactCandidate } from "../src/semantic/fact-extractor.ts";
import type { SemanticFact, Turn } from "../src/types.ts";

function fact(over: Partial<SemanticFact>): SemanticFact {
  return {
    id: over.id ?? "fact-x",
    kind: over.kind ?? "preference",
    predicate: over.predicate ?? "prefers",
    object: over.object ?? "x",
    objectNorm: over.objectNorm ?? "x",
    polarity: over.polarity ?? 1,
    strength: over.strength ?? 0.8,
    mentionCount: over.mentionCount ?? 1,
    firstSeenAt: over.firstSeenAt ?? "2026-06-19T00:00:00Z",
    lastSeenAt: over.lastSeenAt ?? "2026-06-19T00:00:00Z",
    sources: over.sources ?? [{ sessionId: "s", entryId: "e" }],
    state: over.state ?? "active",
    ...over,
  };
}

/** Maps each text to a fixed vector so cosine is fully controlled. */
class StubEmbedder implements Embedder {
  readonly dimension = 3;
  map: Record<string, number[]>;
  fallback: number[];
  constructor(map: Record<string, number[]>, fallback: number[] = [0, 0, 1]) {
    this.map = map;
    this.fallback = fallback;
  }
  async embed(text: string): Promise<number[]> {
    return this.map[text] ?? this.fallback;
  }
}

describe("vectorPromoteFacts", () => {
  const embedder = new StubEmbedder({ q: [1, 0, 0] });
  const A = fact({ id: "A", object: "C", embedding: [1, 0, 0] }); // cosine 1 with q
  const B = fact({ id: "B", object: "Boulder", embedding: [0, 1, 0] }); // cosine 0
  const C = fact({ id: "C", object: "go", embedding: undefined }); // no embedding
  const D = fact({ id: "D", object: "vim", embedding: [1, 0, 0, 0] }); // 4-dim mismatch

  it("surfaces a close vector match and ignores weak/missing/off-dim facts", async () => {
    const out = await vectorPromoteFacts("q", [A, B, C, D], embedder, new Set());
    expect(out.map((p) => p.fact.id)).toEqual(["A"]);
    expect(out[0].kind).toBe("fact");
  });

  it("respects the exclude set (already keyword-promoted)", async () => {
    const out = await vectorPromoteFacts("q", [A, B], embedder, new Set(["A"]));
    expect(out).toEqual([]);
  });

  it("returns [] for an empty query without embedding", async () => {
    let called = false;
    const spy: Embedder = { dimension: 3, async embed() { called = true; return [1, 0, 0]; } };
    expect(await vectorPromoteFacts("", [A], spy, new Set())).toEqual([]);
    expect(called).toBe(false);
  });
});

let dir: string;
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});
const tmp = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltm-fact-embed-")));
const turn: Turn = { sessionId: "s", entryId: "e", role: "user", text: "x", timestamp: "2026-06-19T00:00:00Z" };

class Fake implements FactExtractor {
  out: FactCandidate[];
  constructor(out: FactCandidate[]) {
    this.out = out;
  }
  async extract(): Promise<FactCandidate[]> {
    return this.out;
  }
}

describe("SemanticStore fact embeddings", () => {
  it("embeds a new fact's rendered phrase when an embedder is present", async () => {
    const store = SemanticStore.open(
      tmp(),
      new Fake([{ kind: "preference", predicate: "prefers", object: "C", polarity: 1, initialStrength: 0.9 }]),
      new StubEmbedder({ "The user likes C.": [9, 9, 9] }),
    );
    await store.ingestTurn(turn);
    expect(store.activeFacts()[0].embedding).toEqual([9, 9, 9]);
  });

  it("skip-on-failure: a throwing embedder leaves the fact persisted but un-embedded", async () => {
    const throwing: Embedder = { dimension: 3, async embed() { throw new Error("down"); } };
    const store = SemanticStore.open(
      tmp(),
      new Fake([{ kind: "identity", predicate: "name", object: "Brian", polarity: 1, initialStrength: 0.9 }]),
      throwing,
    );
    await store.ingestTurn(turn);
    const f = store.activeFacts();
    expect(f).toHaveLength(1);
    expect(f[0].embedding).toBeUndefined();
  });

  it("backfillEmbeddings embeds un-embedded facts after reopening with an embedder", async () => {
    const d = tmp();
    // Ingest with no embedder -> fact persists without an embedding.
    const s1 = SemanticStore.open(
      d,
      new Fake([{ kind: "identity", predicate: "name", object: "Brian", polarity: 1, initialStrength: 0.9 }]),
    );
    await s1.ingestTurn(turn);
    expect(s1.activeFacts()[0].embedding).toBeUndefined();
    expect(await s1.backfillEmbeddings()).toEqual({ embedded: 0, skipped: 0 }); // no-op without embedder

    // Reopen the same store WITH an embedder and backfill.
    const s2 = SemanticStore.open(d, new Fake([]), new StubEmbedder({ "The user's name is Brian.": [5, 5, 5] }));
    expect(await s2.backfillEmbeddings()).toEqual({ embedded: 1, skipped: 0 });
    expect(s2.activeFacts()[0].embedding).toEqual([5, 5, 5]);
  });
});
