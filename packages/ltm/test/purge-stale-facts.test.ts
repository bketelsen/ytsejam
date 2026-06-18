import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { factId, normalizeObject } from "../src/semantic/extract.ts";
import { SemanticStore } from "../src/semantic/store.ts";
import type { SemanticFact, Turn } from "../src/types.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ltm-purge-"));
}

function turn(text: string, entryId: string): Turn {
  return {
    sessionId: "s1",
    entryId,
    role: "user",
    text,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

describe("SemanticStore.purgeStaleFacts", () => {
  it("tombstones active facts the current extractor cannot reproduce from their source turns", () => {
    const dir = tmpDir();
    const store = SemanticStore.open(dir);
    const goodTurn = turn("I prefer dark mode", "e-good");
    store.ingestTurn(goodTurn);

    const staleObject = "defer right now";
    const staleFact: SemanticFact = {
      id: factId(
        { kind: "preference", predicate: "prefers", polarity: 1 },
        normalizeObject(staleObject),
      ),
      kind: "preference",
      predicate: "prefers",
      object: staleObject,
      objectNorm: normalizeObject(staleObject),
      polarity: 1,
      strength: 0.6,
      mentionCount: 1,
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      sources: [{ sessionId: "s1", entryId: "e-stale" }],
      state: "active",
    };
    fs.appendFileSync(path.join(dir, "facts.jsonl"), `${JSON.stringify(staleFact)}\n`);

    const seeded = SemanticStore.open(dir);
    const result = seeded.purgeStaleFacts(
      (sessionId, entryId) => {
        if (sessionId !== "s1") return undefined;
        if (entryId === "e-good") return goodTurn.text;
        if (entryId === "e-stale") return "I think we should defer right now and revisit Friday";
        return undefined;
      },
      "2026-06-18T00:00:00.000Z",
    );

    expect(result.kept).toBe(1);
    expect(result.purged).toEqual([staleFact.id]);
    expect(seeded.activeFacts().map((f) => f.object)).toEqual(["dark mode"]);

    const tombstone = seeded.allFacts().find((f) => f.id === staleFact.id);
    expect(tombstone).toMatchObject({
      id: staleFact.id,
      object: "",
      objectNorm: "",
      sources: [],
      strength: 0,
      state: "redacted",
    });

    const raw = fs.readFileSync(path.join(dir, "facts.jsonl"), "utf8");
    expect(raw).not.toContain(staleObject);
  });

  it("aggressively purges facts whose source turns are unreadable", () => {
    const dir = tmpDir();
    const store = SemanticStore.open(dir);
    store.ingestTurn(turn("I prefer dark mode", "e-missing"));

    const factId = store.activeFacts()[0].id;
    const result = store.purgeStaleFacts(() => undefined, "2026-06-18T00:00:00.000Z");

    expect(result).toEqual({ kept: 0, purged: [factId] });
    expect(store.allFacts().find((f) => f.id === factId)?.state).toBe("redacted");
  });
});
