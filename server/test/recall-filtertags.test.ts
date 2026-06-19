import { describe, it, expect } from "vitest";
import { mergeRecallHits } from "../src/memory/recall.ts";

describe("mergeRecallHits", () => {
  it("boosts project-tagged hits ahead of globals and dedupes by where", () => {
    const globals = [{ from: "ltm", text: "g", where: "ltm:1", score: 0.5 }] as const;
    const project = [{ from: "ltm", text: "p", where: "ltm:2", score: 0.4, tags: ["projects:ytsejam"] }] as const;
    const merged = mergeRecallHits(globals as any, project as any);
    expect(merged[0].where).toBe("ltm:2"); // project first
    expect(merged.some((h) => h.where === "ltm:1")).toBe(true); // global still present
  });

  it("deduplicates hits that appear in both global and project by where", () => {
    const globals = [
      { from: "ltm", text: "shared", where: "ltm:1", score: 0.9 },
      { from: "ltm", text: "global-only", where: "ltm:2", score: 0.5 },
    ] as const;
    const project = [
      { from: "ltm", text: "shared", where: "ltm:1", score: 0.8, tags: ["projects:ytsejam"] },
    ] as const;
    const merged = mergeRecallHits(globals as any, project as any);
    expect(merged[0].where).toBe("ltm:1"); // project version first (deduped)
    expect(merged.length).toBe(2); // no duplicate
    expect(merged[1].where).toBe("ltm:2"); // global-only still present
  });

  it("returns global hits unchanged when project is empty", () => {
    const globals = [{ from: "ltm", text: "g", where: "ltm:1", score: 0.5 }] as const;
    const merged = mergeRecallHits(globals as any, []);
    expect(merged).toHaveLength(1);
    expect(merged[0].where).toBe("ltm:1");
  });

  it("returns project hits when global is empty", () => {
    const project = [{ from: "ltm", text: "p", where: "ltm:2", score: 0.4 }] as const;
    const merged = mergeRecallHits([], project as any);
    expect(merged).toHaveLength(1);
    expect(merged[0].where).toBe("ltm:2");
  });
});
