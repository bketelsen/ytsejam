import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemorySystem } from "../src/api/memory-system.ts";
import type { FactCandidate, FactExtractor } from "../src/semantic/fact-extractor.ts";

class FakeFactExtractor {
  public calls = 0;
  async extract(_text: string): Promise<FactCandidate[]> {
    this.calls++;
    return [{ kind: "attribute", predicate: "uses", object: "nixos", polarity: 1, initialStrength: 0.7 }];
  }
}

// Structural typing: FakeFactExtractor satisfies FactExtractor without `implements`
const _check: FactExtractor = new FakeFactExtractor();
void _check;

let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

describe("MemorySystem factExtractor injection", () => {
  it("routes observation ingestion through the injected extractor", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltm-ms-"));
    const fake = new FakeFactExtractor();
    const mem = MemorySystem.open({ storeDir: dir, factExtractor: fake });
    try {
      // learnFacts opt-in: observations are episodic-only by default; this test
      // exercises the injected extractor on the explicit fact-learning path.
      await mem.recordObservation({ text: "I run nixos", timestamp: "2026-06-18T00:00:00Z", tags: ["x"], learnFacts: true });
      expect(fake.calls).toBeGreaterThan(0);
      expect(mem.profile().attributes.some((a) => a.object === "nixos")).toBe(true);
    } finally {
      mem.close();
    }
  });
});
