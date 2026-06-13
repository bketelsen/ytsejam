import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractEntities, extractFacts } from "../src/semantic/extract.ts";
import { effectiveStrength, SemanticStore } from "../src/semantic/store.ts";
import type { SemanticFact, Turn } from "../src/types.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ltm-test-"));
}

function turn(text: string, over: Partial<Turn> = {}): Turn {
  return {
    sessionId: "s1",
    entryId: `e${Math.abs(hash(text)) % 100000}`,
    role: "user",
    text,
    timestamp: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

describe("fact extraction heuristics", () => {
  it("extracts identity from name statements", () => {
    const facts = extractFacts("Hi there, my name is Brian.");
    expect(facts).toContainEqual(expect.objectContaining({ kind: "identity", predicate: "name", object: "Brian" }));
    expect(extractFacts("Please call me Bee.")).toContainEqual(
      expect.objectContaining({ predicate: "name", object: "Bee" }),
    );
  });

  it("extracts positive and negative preferences", () => {
    const like = extractFacts("I really love dark roast coffee in the morning.");
    expect(like).toContainEqual(
      expect.objectContaining({ kind: "preference", polarity: 1, object: "dark roast coffee in the morning" }),
    );
    const dislike = extractFacts("I can't stand meetings before noon.");
    expect(dislike).toContainEqual(expect.objectContaining({ kind: "preference", polarity: -1 }));
  });

  it("'I prefer X over Y' learns +X and deliberately NOT -Y (PLAN 2.5 Option A)", () => {
    const facts = extractFacts("I prefer TypeScript over plain JavaScript for services.");
    const prefs = facts.filter((f) => f.kind === "preference");
    expect(prefs).toHaveLength(1);
    expect(prefs[0].object).toBe("TypeScript");
    expect(prefs[0].polarity).toBe(1);
    // No negative fact about the compared-against side: comparisons are
    // context-bound and must not fabricate general dislikes.
    expect(facts.some((f) => f.polarity === -1)).toBe(false);
    expect(facts.some((f) => /javascript/i.test(f.object))).toBe(false);
  });

  it("extracts directives with polarity", () => {
    expect(extractFacts("Please always answer in metric units.")).toContainEqual(
      expect.objectContaining({ kind: "directive", polarity: 1 }),
    );
    expect(extractFacts("Please never use emojis in your replies.")).toContainEqual(
      expect.objectContaining({ kind: "directive", polarity: -1 }),
    );
  });

  it("extracts allergies, residence, and relationships as slot facts (PLAN 4.3)", () => {
    expect(extractFacts("Remember that I am allergic to peanuts when suggesting recipes.")).toContainEqual(
      expect.objectContaining({ predicate: "allergic_to", object: "peanuts when suggesting recipes" }),
    );
    expect(extractFacts("I live in Boulder these days.")).toContainEqual(
      expect.objectContaining({ predicate: "lives_in", object: "Boulder" }),
    );
    expect(extractFacts("Here in Boulder where I live, it snowed.")).toContainEqual(
      expect.objectContaining({ predicate: "lives_in", object: "Boulder" }),
    );
    expect(extractFacts("My sister Alice is visiting.")).toContainEqual(
      expect.objectContaining({ predicate: "rel_sister", object: "Alice" }),
    );
    expect(extractFacts("I took my dog Biscuit to the vet.")).toContainEqual(
      expect.objectContaining({ predicate: "rel_dog", object: "Biscuit" }),
    );
    // Third-person relationships are NOT user facts.
    expect(extractFacts("Her brother Tom called.").some((f) => f.predicate === "rel_brother")).toBe(false);
  });

  it("does not hallucinate facts from plain task chatter", () => {
    expect(extractFacts("Can you help me debug a flaky integration test?")).toEqual([]);
  });
});

describe("entity extraction heuristics", () => {
  it("finds people via relationship phrases", () => {
    const entities = extractEntities("My sister Alice is visiting next month.");
    expect(entities).toContainEqual(expect.objectContaining({ name: "Alice", kind: "person" }));
  });

  it("finds tech, code spans, paths, urls, and emails", () => {
    const entities = extractEntities(
      "I use TypeScript; see `loadConfig()` in ./src/config.ts or https://example.com/docs — mail me at bjk@example.com",
    );
    const kinds = new Map(entities.map((e) => [e.kind, e.name]));
    expect(kinds.get("tech")).toBeDefined();
    expect(kinds.get("code")).toBe("loadConfig()");
    expect(kinds.get("path")).toBe("./src/config.ts");
    expect(kinds.get("url")).toContain("https://example.com");
    expect(kinds.get("email")).toBe("bjk@example.com");
  });

  it("keys entities by normalized form, independent of surface-case order (PLAN 2.4)", () => {
    for (const text of [
      "TypeScript is great. i still write typescript every day.",
      "i still write typescript every day. TypeScript is great.",
    ]) {
      const candidates = extractEntities(text).filter((e) => e.key === "typescript");
      expect(candidates).toHaveLength(1);
      expect(candidates[0].name).toBe("TypeScript");
      expect(candidates[0].kind).toBe("tech");
    }
  });

  it("skips sentence-starting stopwords", () => {
    const entities = extractEntities("The Quick answer is yes. When I checked it worked.");
    expect(entities.map((e) => e.name)).not.toContain("The");
    expect(entities.map((e) => e.name)).not.toContain("When");
  });
});

describe("semantic store belief dynamics", () => {
  it("reinforces repeated facts and persists across reopen", () => {
    const dir = tmpDir();
    const store = SemanticStore.open(dir);
    store.ingestTurn(turn("I like dark roast coffee.", { entryId: "e1" }));
    const first = store.activeFacts().find((f) => f.objectNorm.includes("dark roast"))!;
    store.ingestTurn(
      turn("I really like dark roast coffee.", { entryId: "e2", timestamp: "2026-01-05T00:00:00.000Z" }),
    );
    const reinforced = store.activeFacts().find((f) => f.objectNorm.includes("dark roast"))!;
    expect(reinforced.strength).toBeGreaterThan(first.strength);
    expect(reinforced.mentionCount).toBe(2);
    expect(reinforced.sources).toHaveLength(2);

    const reopened = SemanticStore.open(dir);
    expect(reopened.activeFacts().some((f) => f.objectNorm.includes("dark roast"))).toBe(true);
  });

  it("resolves contradictions in favor of the newest statement", () => {
    const store = SemanticStore.open(tmpDir());
    store.ingestTurn(turn("I like tabs for indentation.", { entryId: "e1" }));
    store.ingestTurn(
      turn("I really dislike tabs for indentation now.", {
        entryId: "e2",
        timestamp: "2026-02-01T00:00:00.000Z",
      }),
    );
    const facts = store.activeFacts().filter((f) => f.objectNorm.includes("tabs"));
    expect(facts).toHaveLength(1);
    expect(facts[0].polarity).toBe(-1);
  });

  it("treats identity slots as single-valued, newest wins", () => {
    const store = SemanticStore.open(tmpDir());
    store.ingestTurn(turn("My name is Brian.", { entryId: "e1" }));
    store.ingestTurn(turn("Call me Bee.", { entryId: "e2", timestamp: "2026-03-01T00:00:00.000Z" }));
    const names = store.activeFacts().filter((f) => f.predicate === "name");
    expect(names).toHaveLength(1);
    expect(names[0].object).toBe("Bee");
  });

  it("only learns facts from user turns", () => {
    const store = SemanticStore.open(tmpDir());
    store.ingestTurn(turn("I prefer tabs over spaces.", { role: "assistant" }));
    expect(store.activeFacts()).toHaveLength(0);
  });

  it("profile floors are per fact kind and configurable (PLAN 2.1)", () => {
    const store = SemanticStore.open(tmpDir());
    store.ingestTurn(turn("My name is Brian.", { entryId: "e1", timestamp: "2024-01-01T00:00:00.000Z" }));
    // ~26 months later: effective strength ≈ 0.9·2^(-790/365) ≈ 0.20.
    const now = "2026-03-01T00:00:00.000Z";
    const defaultFloors = store.profile(now);
    expect(defaultFloors.identity).toHaveLength(0);
    const lowered = store.profile(now, { floor: 0.3, identityFloor: 0.15, directiveFloor: 0.3 });
    expect(lowered.identity.some((f) => f.object === "Brian")).toBe(true);
    // The generic floor did not move: a preference of the same age stays out.
    store.ingestTurn(turn("I love rye bread.", { entryId: "e2", timestamp: "2024-01-01T00:00:00.000Z" }));
    expect(
      store.profile(now, { floor: 0.3, identityFloor: 0.15, directiveFloor: 0.3 }).preferences,
    ).toHaveLength(0);
  });

  it("redacts facts when all their evidence is redacted", () => {
    const dir = tmpDir();
    const store = SemanticStore.open(dir);
    store.ingestTurn(turn("I love dark roast coffee.", { entryId: "e1" }));
    const result = store.redactBySources((s) => s.entryId === "e1");
    expect(result.facts).toBeGreaterThanOrEqual(1);
    expect(store.activeFacts().some((f) => f.objectNorm.includes("dark roast"))).toBe(false);
    const raw = fs.readFileSync(path.join(dir, "facts.jsonl"), "utf8");
    expect(raw).not.toContain("dark roast");
  });
});

describe("rehearsal-aware effective strength (RECALL 1)", () => {
  const fact: SemanticFact = {
    id: "fact-attribute-works_at-initech-p",
    kind: "attribute",
    predicate: "works_at",
    object: "Initech",
    objectNorm: "initech",
    polarity: 1,
    strength: 0.7,
    mentionCount: 1,
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    sources: [{ sessionId: "s1", entryId: "e1" }],
    state: "active",
  };
  // 270 days later: 0.7 * 2^(-270/180) ≈ 0.247 — below the 0.3 floor.
  const now = "2026-09-28T00:00:00.000Z";

  it("recallCount stretches the disuse half-life", () => {
    const dormant = effectiveStrength(fact, now);
    expect(dormant).toBeLessThan(0.3);
    // recallCount 2 → half-life 180 * (1 + 0.5*2) = 360d → 0.7 * 2^(-0.75) ≈ 0.416
    const rehearsed = effectiveStrength({ ...fact, recallCount: 2 }, now);
    expect(rehearsed).toBeGreaterThan(0.3);
    expect(rehearsed).toBeGreaterThan(dormant);
  });

  it("recallCount undefined behaves as zero", () => {
    expect(effectiveStrength(fact, now)).toBeCloseTo(
      effectiveStrength({ ...fact, recallCount: 0 }, now),
      12,
    );
  });
});

function userTurn(text: string, timestamp: string, entryId = "e1"): Turn {
  return { sessionId: "s-dormant", entryId, role: "user", text, timestamp };
}

describe("dormant profile section (RECALL 2)", () => {
  it("active facts below their floor land in dormant, sorted strongest-first", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltm-sem-"));
    const store = SemanticStore.open(dir);
    store.ingestTurn(userTurn("I work at Initech.", "2026-01-01T00:00:00.000Z"));
    const now = "2026-09-28T00:00:00.000Z"; // works_at attribute decayed below 0.3

    const profile = store.profile(now);
    expect(profile.attributes.find((f) => f.predicate === "works_at")).toBeUndefined();
    const dormant = profile.dormant.find((f) => f.predicate === "works_at");
    expect(dormant).toBeDefined();
    expect(dormant!.object).toBe("Initech");
  });

  it("above-floor facts never appear in dormant", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltm-sem-"));
    const store = SemanticStore.open(dir);
    store.ingestTurn(userTurn("I work at Initech.", "2026-01-01T00:00:00.000Z"));
    const profile = store.profile("2026-01-02T00:00:00.000Z"); // fresh
    expect(profile.attributes.some((f) => f.predicate === "works_at")).toBe(true);
    expect(profile.dormant.some((f) => f.predicate === "works_at")).toBe(false);
  });
});

describe("recordRecall rehearsal persistence (RECALL 3)", () => {
  it("bumps in memory and persists at powers of two (like bumpAccess)", () => {
    const dir = tmpDir();
    const store = SemanticStore.open(dir);
    store.ingestTurn(turn("I work at Initech.", { timestamp: "2026-01-01T00:00:00.000Z" }));
    const id = store.activeFacts().find((f) => f.predicate === "works_at")!.id;

    for (let i = 0; i < 3; i++) store.recordRecall(id);
    expect(store.allFacts().find((f) => f.id === id)!.recallCount).toBe(3);

    // 3 is not a power of two — the last persisted snapshot is recallCount 2.
    const reopened = SemanticStore.open(dir);
    expect(reopened.allFacts().find((f) => f.id === id)!.recallCount).toBe(2);
  });

  it("ignores unknown and non-active facts", () => {
    const store = SemanticStore.open(tmpDir());
    store.recordRecall("no-such-fact"); // must not throw
  });

  it("is a no-op for a superseded fact (RECALL 3)", () => {
    const store = SemanticStore.open(tmpDir());
    // "name" is a single-valued slot: the second ingest supersedes the first.
    store.ingestTurn(turn("My name is Brian.", { entryId: "e1", timestamp: "2026-01-01T00:00:00.000Z" }));
    store.ingestTurn(turn("My name is Bob.", { entryId: "e2", timestamp: "2026-02-01T00:00:00.000Z" }));

    const superseded = store.allFacts().find((f) => f.predicate === "name" && f.supersededBy);
    expect(superseded).toBeDefined();

    const countBefore = superseded!.recallCount ?? 0;
    store.recordRecall(superseded!.id);
    const countAfter = store.allFacts().find((f) => f.id === superseded!.id)!.recallCount ?? 0;
    expect(countAfter).toBe(countBefore);
  });
});
