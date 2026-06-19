// server/test/rederive.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EpisodicStore } from "ltm";
import type { FactExtractor, FactCandidate } from "ltm";
import { buildFreshFacts, KNOWN_GOOD } from "../src/memory/rederive.ts";

class ScriptedExtractor {
  private readonly map: Record<string, FactCandidate[]>;
  constructor(map: Record<string, FactCandidate[]>) { this.map = map; }
  async extract(text: string): Promise<FactCandidate[]> { return this.map[text] ?? []; }
}

// Structural typing: ScriptedExtractor satisfies FactExtractor without `implements`
const _typeCheck: FactExtractor = new ScriptedExtractor({});
void _typeCheck;

let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

function seedEpisodic(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltm-rederive-"));
  const ep = EpisodicStore.open(dir);
  ep.upsertMany([
    { id: "s/u1#0", kind: "turn", sessionId: "s", entryId: "u1", role: "user", text: "my name is Brian", timestamp: "2026-06-18T00:00:00Z", salience: 0.8, accessCount: 0, state: "active" },
    { id: "s/a1#0", kind: "turn", sessionId: "s", entryId: "a1", role: "assistant", text: "noted", timestamp: "2026-06-18T00:00:01Z", salience: 0.4, accessCount: 0, state: "active" },
  ]);
  return dir;
}

describe("buildFreshFacts", () => {
  it("re-derives facts from user turns only and reports known-good present", async () => {
    const store = seedEpisodic();
    const ext = new ScriptedExtractor({
      "my name is Brian": [{ kind: "identity", predicate: "name", object: "Brian", polarity: 1, initialStrength: 0.9 }],
    });
    const r = await buildFreshFacts({ storeDir: store, extractor: ext });
    expect(r.facts.some((f) => f.predicate === "name" && f.object === "Brian")).toBe(true);
    // assistant turn text was never extracted
    expect(r.facts.every((f) => f.object !== "noted")).toBe(true);
  });

  it("flags missing known-good facts so the caller can abort the wipe", async () => {
    const store = seedEpisodic();
    const ext = new ScriptedExtractor({}); // extracts nothing
    const r = await buildFreshFacts({ storeDir: store, extractor: ext });
    expect(r.knownGood.ok).toBe(false);
    expect(r.knownGood.missing).toContain(KNOWN_GOOD[0].label);
  });
});
