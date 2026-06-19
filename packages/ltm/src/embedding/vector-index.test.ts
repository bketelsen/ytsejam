import { describe, expect, it } from "vitest";
import { VectorIndex } from "./vector-index.ts";

describe("VectorIndex", () => {
  it("adds vectors and returns top-k cosine hits in descending score order", () => {
    const index = new VectorIndex();

    index.set("north", [1, 0]);
    index.set("east", [0, 1]);
    index.set("northeast", [0.6, 0.8]);

    const hits = index.search([1, 0], 2);

    expect(hits).toEqual([
      { id: "north", score: 1 },
      { id: "northeast", score: 0.6 },
    ]);
  });

  it("updates existing ids and deletes vectors from subsequent searches", () => {
    const index = new VectorIndex();

    index.set("record", [0, 1]);
    index.set("other", [1, 0]);
    index.set("record", [1, 0]);

    expect(index.size).toBe(2);
    expect(index.has("record")).toBe(true);
    expect(index.sampleDimension()).toBe(2);
    expect(index.search([1, 0], 2)).toEqual([
      { id: "record", score: 1 },
      { id: "other", score: 1 },
    ]);

    index.delete("record");

    expect(index.has("record")).toBe(false);
    expect(index.size).toBe(1);
    expect(index.search([1, 0], 10)).toEqual([{ id: "other", score: 1 }]);
  });

  it("returns null sampleDimension and empty search results when empty", () => {
    const index = new VectorIndex();

    expect(index.sampleDimension()).toBeNull();
    expect(index.search([1, 0], 5)).toEqual([]);
    expect(index.similarity("missing", [1, 0])).toBe(0);
  });

  it("refuses off-dimension vectors so search never compares across dimensions (D2)", () => {
    const index = new VectorIndex();

    index.set("short", [0, 1]); // establishes 2-dim
    index.set("long", [1, 0, 999]); // 3-dim — REFUSED, not truncated

    // The off-dimension vector was never stored, so search is safe and only
    // sees the 2-dim vector. The old behavior truncated [1,0,999] to [1,0]
    // and scored a garbage 1.0 — that silent truncation was D2.
    expect(index.size).toBe(1);
    expect(index.has("long")).toBe(false);
    expect(() => index.search([1, 0], 2)).not.toThrow();
    expect(index.search([1, 0], 2)).toEqual([{ id: "short", score: 0 }]);

    // similarity() against an off-dimension query throws rather than
    // truncating, because cosine now refuses unequal lengths.
    expect(() => index.similarity("short", [0, 1, 999])).toThrow(/dimension mismatch/);
  });
});
