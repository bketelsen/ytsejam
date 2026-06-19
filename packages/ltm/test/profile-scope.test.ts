// packages/ltm/test/profile-scope.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SemanticStore } from "../src/semantic/store.ts";
import type { FactExtractor, FactCandidate } from "../src/semantic/fact-extractor.ts";
import type { Turn } from "../src/types.ts";

let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltm-profile-scope-")));
const NOW = "2026-06-19T00:00:00Z";
const makeTurn = (id: string): Turn => ({ sessionId: "s", entryId: id, role: "user", text: "x", timestamp: NOW });

/** Mutable fake extractor — swap out `next` between ingestTurn calls. */
class MutableFake {
  next: FactCandidate[] = [];
  async extract(): Promise<FactCandidate[]> { return [...this.next]; }
}

async function buildScopedStore(): Promise<SemanticStore> {
  const fake = new MutableFake();
  const store = SemanticStore.open(tmp(), fake as unknown as FactExtractor);

  fake.next = [{ kind: "identity", predicate: "name", object: "Brian", polarity: 1, initialStrength: 0.9, scope: "global" }];
  await store.ingestTurn(makeTurn("e1"), undefined);

  fake.next = [{ kind: "directive", predicate: "uses", object: "gate.sh", polarity: 1, initialStrength: 0.8, scope: "project" }];
  await store.ingestTurn(makeTurn("e2"), "projects:ytsejam");

  fake.next = [{ kind: "preference", predicate: "likes", object: "dark-mode", polarity: 1, initialStrength: 0.7, scope: "project" }];
  await store.ingestTurn(makeTurn("e3"), "projects:other");

  return store;
}

function profileObjects(store: SemanticStore, tag?: string): string[] {
  const p = store.profile(NOW, undefined, tag);
  return [...p.identity, ...p.preferences, ...p.directives, ...p.attributes, ...p.dormant].map((f) => f.object);
}

describe("SemanticStore.profile scope filtering", () => {
  it("profile with activeProjectTag includes global + matching project facts, excludes others", async () => {
    const store = await buildScopedStore();
    expect(store.activeFacts()).toHaveLength(3);

    const objects = profileObjects(store, "projects:ytsejam");
    expect(objects).toContain("Brian");
    expect(objects).toContain("gate.sh");
    expect(objects).not.toContain("dark-mode");
  });

  it("profile with no activeProjectTag returns only globals", async () => {
    const store = await buildScopedStore();

    const objects = profileObjects(store);
    expect(objects).toContain("Brian");
    expect(objects).not.toContain("gate.sh");
    expect(objects).not.toContain("dark-mode");
  });
});
