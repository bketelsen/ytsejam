import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemorySystem } from "../src/api/memory-system.ts";
import { generateFixtures } from "../src/eval/synthetic.ts";
import { summaryId } from "../src/episodic/consolidate.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ltm-test-"));
}

describe("consolidation summary ids (PLAN 2.3)", () => {
  it("is content-addressed: same children → same id, different children → different id", () => {
    expect(summaryId("s1", ["a", "b"])).toBe(summaryId("s1", ["b", "a"]));
    expect(summaryId("s1", ["a", "b"])).not.toBe(summaryId("s1", ["a", "b", "c"]));
    expect(summaryId("s1", ["a", "b"])).not.toBe(summaryId("s2", ["a", "b"]));
  });

  it("repeat consolidation + redaction rebuild yields three distinct coexisting summaries", async () => {
    const work = tmpDir();
    const sessionsDir = path.join(work, "sessions");
    generateFixtures({
      outDir: sessionsDir,
      sessions: 1,
      turnsPerSession: 8,
      seed: 9,
      startDate: "2025-01-06T09:00:00.000Z",
    });
    const now = "2026-06-01T00:00:00.000Z";
    const mem = MemorySystem.open({ storeDir: path.join(work, "store"), now: () => now });
    const sessionFile = fs.readdirSync(sessionsDir).find((f) => f.endsWith(".jsonl"))!;
    const filePath = path.join(sessionsDir, sessionFile);
    await mem.ingestSessionFile(filePath);

    // First consolidation.
    await mem.consolidate({ now });
    const first = mem.listEpisodic().find((r) => r.kind === "consolidated" && r.state === "active")!;
    expect(first).toBeDefined();

    // Redact one child → the summary is rebuilt from the survivors.
    await mem.redact({ recordId: first.sourceIds![0] });
    const second = mem
      .listEpisodic()
      .find((r) => r.kind === "consolidated" && r.state === "active")!;
    expect(second.id).not.toBe(first.id);
    expect(second.sourceIds).not.toContain(first.sourceIds![0]);

    // Append more (old) turns to the same session and consolidate again.
    const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    let parentId = (JSON.parse(lines[lines.length - 1]) as { id: string }).id;
    const extra: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = `eeee000${i}`;
      extra.push(
        JSON.stringify({
          type: "message",
          id,
          parentId,
          timestamp: `2025-02-0${i + 1}T09:00:00.000Z`,
          message: {
            role: "user",
            content: `I spent morning number ${i} birdwatching near the creek with my binoculars.`,
            timestamp: Date.parse(`2025-02-0${i + 1}T09:00:00.000Z`),
          },
        }),
      );
      parentId = id;
    }
    fs.appendFileSync(filePath, extra.join("\n") + "\n");
    await mem.ingestSessionFile(filePath);
    await mem.consolidate({ now });

    const all = mem.listEpisodic().filter((r) => r.kind === "consolidated");
    const ids = new Set(all.map((r) => r.id));
    // original (now redacted), rebuilt, and second-run summaries all coexist.
    expect(ids.has(first.id)).toBe(true);
    expect(ids.has(second.id)).toBe(true);
    expect(ids.size).toBeGreaterThanOrEqual(3);
    const third = all.find((r) => r.id !== first.id && r.id !== second.id)!;
    expect(third.text).toContain("birdwatching");
    expect(mem.getRecord(first.id)!.state).toBe("redacted");
    expect(mem.getRecord(second.id)!.state).toBe("active");
  });
});
