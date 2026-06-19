import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SemanticStore } from "../src/semantic/store.ts";
import type { FactCandidate, FactExtractor } from "../src/semantic/fact-extractor.ts";
import type { Turn } from "../src/types.ts";

class FakeFactExtractor {
  public calls: string[] = [];
  private readonly out: FactCandidate[];
  constructor(out: FactCandidate[]) { this.out = out; }
  async extract(text: string): Promise<FactCandidate[]> {
    this.calls.push(text);
    return this.out;
  }
}

// Structural typing: FakeFactExtractor satisfies FactExtractor without `implements`
const _check: FactExtractor = new FakeFactExtractor([]);
void _check;

let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

function tmp(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltm-sem-"));
  return dir;
}

const userTurn: Turn = { sessionId: "s1", entryId: "e1", role: "user", text: "I prefer vim", timestamp: "2026-06-18T00:00:00Z" };
const asstTurn: Turn = { sessionId: "s1", entryId: "e2", role: "assistant", text: "I prefer vim", timestamp: "2026-06-18T00:00:01Z" };

describe("SemanticStore with injected extractor", () => {
  it("uses the injected extractor on user turns and persists the fact", async () => {
    const fake = new FakeFactExtractor([
      { kind: "preference", predicate: "prefers", object: "vim", polarity: 1, initialStrength: 0.7 },
    ]);
    const store = SemanticStore.open(tmp(), fake);
    await store.ingestTurn(userTurn);
    expect(fake.calls).toEqual(["I prefer vim"]);
    expect(store.allFacts().some((f) => f.object === "vim" && f.state === "active")).toBe(true);
  });

  it("skips extraction entirely on non-user turns", async () => {
    const fake = new FakeFactExtractor([
      { kind: "preference", predicate: "prefers", object: "vim", polarity: 1, initialStrength: 0.7 },
    ]);
    const store = SemanticStore.open(tmp(), fake);
    await store.ingestTurn(asstTurn);
    expect(fake.calls).toEqual([]);
    expect(store.allFacts()).toEqual([]);
  });

  it("defaults to the regex extractor when none injected", async () => {
    const store = SemanticStore.open(tmp());
    await store.ingestTurn({ ...userTurn, text: "My name is Brian" });
    expect(store.allFacts().some((f) => f.predicate === "name" && f.object.toLowerCase().includes("brian"))).toBe(true);
  });
});
