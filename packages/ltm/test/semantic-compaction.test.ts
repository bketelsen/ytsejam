import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SemanticStore } from "../src/semantic/store.ts";
import type { Turn } from "../src/types.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ltm-sem-compact-"));
}

function lineCount(file: string): number {
  const raw = fs.readFileSync(file, "utf8").trim();
  return raw.length === 0 ? 0 : raw.split("\n").length;
}

describe("semantic log compaction", () => {
  it("collapses repeated fact snapshots without losing latest-wins content", async () => {
    const dir = tmpDir();
    const store = SemanticStore.open(dir);

    for (let i = 0; i < 50; i++) {
      const turn: Turn = {
        sessionId: "s-coffee",
        entryId: `e${i}`,
        role: "user",
        text: "I love dark roast coffee.",
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      };
      await store.ingestTurn(turn);
    }

    const factsPath = path.join(dir, "facts.jsonl");
    // Reinforcement appends a fresh snapshot per re-assertion, so the log
    // grows past one line before compaction.
    expect(lineCount(factsPath)).toBeGreaterThan(1);

    const before = store.activeFacts().find((f) => f.objectNorm.includes("dark roast"));
    expect(before).toBeDefined();
    expect(before!.mentionCount).toBe(50);
    expect(before!.sources).toHaveLength(50);

    const counts = store.compactLogs();
    expect(counts).toEqual({ facts: store.allFacts().length });

    const distinctFactIds = new Set(store.allFacts().map((f) => f.id)).size;
    expect(lineCount(factsPath)).toBe(distinctFactIds);

    const reopened = SemanticStore.open(dir);
    const after = reopened.activeFacts().find((f) => f.objectNorm.includes("dark roast"));
    expect(after).toBeDefined();
    expect(after!.mentionCount).toBe(50);
    expect(after!.sources).toHaveLength(50);
    expect(after!.sources.map((s) => s.entryId)).toEqual(
      Array.from({ length: 50 }, (_, i) => `e${i}`),
    );
  });
});
