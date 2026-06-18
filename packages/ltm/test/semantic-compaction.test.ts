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
  it("collapses repeated entity snapshots without losing latest-wins content", () => {
    const dir = tmpDir();
    const store = SemanticStore.open(dir);

    for (let i = 0; i < 50; i++) {
      const turn: Turn = {
        sessionId: "s-grafana",
        entryId: `e${i}`,
        role: "user",
        text: "I checked the Grafana dashboard.",
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      };
      store.ingestTurn(turn);
    }

    const entitiesPath = path.join(dir, "entities.jsonl");
    expect(lineCount(entitiesPath)).toBeGreaterThan(1);

    const before = store.allEntities().find((e) => e.norm === "grafana");
    expect(before).toBeDefined();
    expect(before!.mentionCount).toBe(50);
    expect(before!.sources).toHaveLength(50);

    const counts = store.compactLogs();
    expect(counts).toEqual({ facts: store.allFacts().length, entities: store.allEntities().length });

    const distinctEntityIds = new Set(store.allEntities().map((e) => e.id)).size;
    expect(lineCount(entitiesPath)).toBe(distinctEntityIds);

    const reopened = SemanticStore.open(dir);
    const after = reopened.allEntities().find((e) => e.norm === "grafana");
    expect(after).toBeDefined();
    expect(after!.mentionCount).toBe(50);
    expect(after!.sources).toHaveLength(50);
    expect(after!.sources.map((s) => s.entryId)).toEqual(
      Array.from({ length: 50 }, (_, i) => `e${i}`),
    );
  });
});
