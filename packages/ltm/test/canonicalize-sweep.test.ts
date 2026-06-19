import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { SemanticStore } from "../src/semantic/store.ts";
import type { FactExtractor, FactCandidate } from "../src/semantic/fact-extractor.ts";
import type { Turn } from "../src/types.ts";

class Queue implements FactExtractor {
  private i = 0; batches: FactCandidate[][];
  constructor(b: FactCandidate[][]) { this.batches = b; }
  async extract(): Promise<FactCandidate[]> { return this.batches[Math.min(this.i++, this.batches.length - 1)]; }
}
let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltm-canon-sweep-")));
const turn = (e: string): Turn => ({ sessionId: "s", entryId: e, role: "user", text: "x", timestamp: "2026-06-19T00:00:00Z" });

describe("SemanticStore.canonicalizeAndDedup", () => {
  it("collapses synonym predicates already on disk into one canonical fact", async () => {
    // ingestTurn canonicalizes on write, so to simulate legacy drift we ingest
    // via two turns whose extractor emits raw synonyms across separate calls.
    const store = SemanticStore.open(tmp(), new Queue([
      [{ kind: "attribute", predicate: "works_on_repo", object: "ytsejam", polarity: 1, initialStrength: 0.9 }],
      [{ kind: "attribute", predicate: "works_on_project", object: "ytsejam", polarity: 1, initialStrength: 0.6 }],
    ]));
    await store.ingestTurn(turn("e1"));
    await store.ingestTurn(turn("e2"));
    // Both already canonicalize to works_on on write -> one fact. Force a raw
    // straggler by writing a redundant variant through restoreFacts:
    const canon = store.activeFacts()[0];
    store.restoreFacts([{ ...canon, id: "fact-attribute-works_on_repo-ytsejam-p", predicate: "works_on_repo" }]);
    expect(store.activeFacts().length).toBe(2); // drift introduced

    const res = store.canonicalizeAndDedup("2026-06-19T01:00:00Z");
    expect(res.canonicalized + res.merged).toBeGreaterThan(0);
    const active = store.activeFacts().filter((f) => f.object === "ytsejam");
    expect(active).toHaveLength(1);
    expect(active[0].predicate).toBe("works_on");
  });

  it("is a no-op on an already-canonical store", async () => {
    const store = SemanticStore.open(tmp(), new Queue([
      [{ kind: "identity", predicate: "name", object: "Brian", polarity: 1, initialStrength: 0.9 }],
    ]));
    await store.ingestTurn(turn("e1"));
    expect(store.canonicalizeAndDedup("2026-06-19T01:00:00Z")).toEqual({ canonicalized: 0, merged: 0 });
  });
});
