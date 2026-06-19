import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalizePredicate, factId } from "../src/semantic/extract.ts";
import { SemanticStore } from "../src/semantic/store.ts";
import type { FactExtractor, FactCandidate } from "../src/semantic/fact-extractor.ts";
import type { Turn } from "../src/types.ts";

class Fake implements FactExtractor {
  out: FactCandidate[];
  constructor(out: FactCandidate[]) {
    this.out = out;
  }
  async extract(): Promise<FactCandidate[]> {
    return this.out;
  }
}

/** Returns a different candidate set on each successive call (per turn). */
class Queue implements FactExtractor {
  private i = 0;
  batches: FactCandidate[][];
  constructor(batches: FactCandidate[][]) {
    this.batches = batches;
  }
  async extract(): Promise<FactCandidate[]> {
    return this.batches[Math.min(this.i++, this.batches.length - 1)];
  }
}

let dir: string;
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});
const tmp = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltm-canon-")));
const turn = (text: string, e = "e"): Turn => ({
  sessionId: "s",
  entryId: e,
  role: "user",
  text,
  timestamp: "2026-06-19T00:00:00Z",
});

describe("canonicalizePredicate", () => {
  it("collapses works_on synonyms to works_on", () => {
    expect(canonicalizePredicate("works_on_repo")).toBe("works_on");
    expect(canonicalizePredicate("works_on_project")).toBe("works_on");
    expect(canonicalizePredicate("working_on")).toBe("works_on");
    expect(canonicalizePredicate("works_on")).toBe("works_on");
  });
  it("normalizes spacing/casing and leaves unknown predicates alone", () => {
    expect(canonicalizePredicate("Works On Repo")).toBe("works_on");
    expect(canonicalizePredicate("favourite_colour")).toBe("favourite_colour");
  });
  it("makes factId collapse synonyms to one id", () => {
    const base = { kind: "attribute" as const, polarity: 1 as const };
    expect(factId({ ...base, predicate: "works_on_repo" }, "ytsejam")).toBe(
      factId({ ...base, predicate: "works_on" }, "ytsejam"),
    );
  });
});

describe("SemanticStore canonicalization + dedup", () => {
  it("collapses synonym predicates within one turn to a single fact", async () => {
    const store = SemanticStore.open(
      tmp(),
      new Fake([
        { kind: "attribute", predicate: "works_on", object: "ytsejam", polarity: 1, initialStrength: 0.6 },
        { kind: "attribute", predicate: "works_on_repo", object: "ytsejam", polarity: 1, initialStrength: 0.6 },
        { kind: "attribute", predicate: "works_on_project", object: "ytsejam", polarity: 1, initialStrength: 0.6 },
      ]),
    );
    await store.ingestTurn(turn("I work on ytsejam"));
    const active = store.activeFacts().filter((f) => f.object === "ytsejam");
    expect(active).toHaveLength(1);
    expect(active[0].predicate).toBe("works_on");
    // one turn => one mention, not three
    expect(active[0].mentionCount).toBe(1);
  });

  it("supersedes a single-valued slot when a new value arrives (name=Brian then bjk)", async () => {
    const store = SemanticStore.open(
      tmp(),
      new Queue([
        [{ kind: "identity", predicate: "name", object: "Brian", polarity: 1, initialStrength: 0.9 }],
        [{ kind: "identity", predicate: "name", object: "bjk", polarity: 1, initialStrength: 0.9 }],
      ]),
    );
    await store.ingestTurn(turn("my name is Brian", "e1"));
    await store.ingestTurn(turn("call me bjk", "e2"));
    const names = store.activeFacts().filter((f) => f.predicate === "name");
    expect(names).toHaveLength(1);
    expect(names[0].object).toBe("bjk");
  });
});
