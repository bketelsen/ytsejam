// packages/ltm/test/semantic-scope-stamp.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { SemanticStore } from "../src/semantic/store.ts";
import type { FactExtractor, FactCandidate } from "../src/semantic/fact-extractor.ts";
import type { Turn } from "../src/types.ts";

class Fake { out: FactCandidate[]; constructor(out: FactCandidate[]) { this.out = out; } async extract(): Promise<FactCandidate[]> { return this.out; } }
let dir: string; afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltm-scope-")));
const turn: Turn = { sessionId: "s", entryId: "e", role: "user", text: "x", timestamp: "2026-06-18T00:00:00Z" };

describe("scope stamping", () => {
  it("stamps projectTag when scope=project and a tag is active", async () => {
    const store = SemanticStore.open(tmp(), new Fake([{ kind: "directive", predicate: "uses", object: "gate.sh", polarity: 1, initialStrength: 0.8, scope: "project" }]) as unknown as FactExtractor);
    await store.ingestTurn(turn, "projects:ytsejam");
    const f = store.allFacts().find((x) => x.object === "gate.sh");
    expect(f?.projectTag).toBe("projects:ytsejam");
  });
  it("leaves global when scope=global", async () => {
    const store = SemanticStore.open(tmp(), new Fake([{ kind: "identity", predicate: "name", object: "Brian", polarity: 1, initialStrength: 0.9, scope: "global" }]) as unknown as FactExtractor);
    await store.ingestTurn(turn, "projects:ytsejam");
    expect(store.allFacts().find((x) => x.object === "Brian")?.projectTag).toBeUndefined();
  });
  it("stays global when scope=project but no active tag", async () => {
    const store = SemanticStore.open(tmp(), new Fake([{ kind: "directive", predicate: "uses", object: "gate.sh", polarity: 1, initialStrength: 0.8, scope: "project" }]) as unknown as FactExtractor);
    await store.ingestTurn(turn, undefined);
    expect(store.allFacts().find((x) => x.object === "gate.sh")?.projectTag).toBeUndefined();
  });
});
