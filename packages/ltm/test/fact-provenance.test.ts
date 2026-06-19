import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SemanticStore } from "../src/semantic/store.ts";
import type { FactExtractor, FactCandidate } from "../src/semantic/fact-extractor.ts";
import type { Turn } from "../src/types.ts";

/**
 * The provenance invariant (PR: cog observations episodic-only):
 *
 *   A durable user fact may enter LTM only from a user-authored turn. Assistant
 *   turns and (by default) assistant-authored cog observations are retrievable
 *   memories, not evidence of the user's preferences.
 *
 * recordObservation's default-off gate is covered in observation.test.ts; this
 * locks the role gate in the session-ingest path (the legitimate fact channel).
 */
class Always implements FactExtractor {
  out: FactCandidate[];
  constructor(out: FactCandidate[]) {
    this.out = out;
  }
  async extract(): Promise<FactCandidate[]> {
    return this.out;
  }
}

let dir: string;
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});
const tmp = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltm-prov-")));
const candidate: FactCandidate = {
  kind: "preference",
  predicate: "prefers",
  object: "Go",
  polarity: 1,
  initialStrength: 0.9,
};
const turn = (role: Turn["role"]): Turn => ({
  sessionId: "s",
  entryId: "e-" + role,
  role,
  text: "I prefer Go",
  timestamp: "2026-06-19T00:00:00Z",
});

describe("fact provenance: session-ingest role gate", () => {
  it("learns a fact from a USER turn", async () => {
    const store = SemanticStore.open(tmp(), new Always([candidate]));
    await store.ingestTurn(turn("user"));
    expect(store.activeFacts().map((f) => f.object)).toContain("Go");
  });

  it("does NOT learn a fact from an ASSISTANT turn", async () => {
    const store = SemanticStore.open(tmp(), new Always([candidate]));
    await store.ingestTurn(turn("assistant"));
    expect(store.activeFacts()).toHaveLength(0);
  });
});
