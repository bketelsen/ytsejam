import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { SemanticStore } from "../src/semantic/store.ts";
import type { FactExtractor, FactCandidate } from "../src/semantic/fact-extractor.ts";
import type { Turn } from "../src/types.ts";

class Always implements FactExtractor {
  out: FactCandidate[];
  constructor(out: FactCandidate[]) { this.out = out; }
  async extract(): Promise<FactCandidate[]> { return this.out; }
}
let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltm-redact-")));
const turn: Turn = { sessionId: "s", entryId: "e", role: "user", text: "x", timestamp: "2026-06-19T00:00:00Z" };

describe("SemanticStore.redactFactById", () => {
  it("tombstones the fact and returns true; unknown id returns false", async () => {
    const store = SemanticStore.open(tmp(), new Always([
      { kind: "identity", predicate: "name", object: "Brian", polarity: 1, initialStrength: 0.9 },
    ]));
    await store.ingestTurn(turn);
    const id = store.activeFacts()[0].id;
    expect(store.redactFactById(id)).toBe(true);
    expect(store.activeFacts()).toHaveLength(0);
    expect(store.redactFactById("nope")).toBe(false);
    // survives reload (tombstone persisted)
    const reopened = SemanticStore.open(dir, new Always([]));
    expect(reopened.activeFacts()).toHaveLength(0);
  });
});
