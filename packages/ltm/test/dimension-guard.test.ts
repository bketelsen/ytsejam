import { describe, expect, it } from "vitest";
import { VectorIndex } from "../src/embedding/vector-index.ts";
import { cosine } from "../src/embedding/embedder.ts";

/**
 * D2 regression: a mixed-dimension index silently truncated via Math.min and
 * scored garbage. The index now refuses off-dimension vectors, and cosine
 * throws on a mismatch instead of truncating.
 */
describe("VectorIndex dimension guard (D2)", () => {
  it("establishes dimension from the first vector and refuses a different one", () => {
    const idx = new VectorIndex();
    idx.set("a", [1, 0, 0, 0]); // 4-dim establishes the index
    idx.set("b", [0, 1, 0, 0]); // same dim — accepted
    idx.set("c", [1, 1]); // 2-dim — REFUSED

    expect(idx.size).toBe(2);
    expect(idx.has("a")).toBe(true);
    expect(idx.has("b")).toBe(true);
    expect(idx.has("c")).toBe(false);
  });

  it("drops a stale same-id entry when a later write is off-dimension", () => {
    const idx = new VectorIndex();
    idx.set("x", [1, 0, 0, 0]); // good 4-dim
    expect(idx.has("x")).toBe(true);
    idx.set("x", [9, 9]); // re-write same id at wrong dim — must not linger as stale
    expect(idx.has("x")).toBe(false);
  });

  it("ignores empty vectors without establishing or corrupting the dimension", () => {
    const idx = new VectorIndex();
    idx.set("empty", []); // no-op, dimension still unset
    idx.set("real", [1, 0, 0]); // 3-dim establishes
    idx.set("real2", [0, 1, 0]);
    expect(idx.size).toBe(2);
    expect(idx.has("empty")).toBe(false);
  });

  it("search never compares across dimensions (only same-dim vectors are stored)", () => {
    const idx = new VectorIndex();
    idx.set("a", [1, 0, 0, 0]);
    idx.set("b", [0, 1, 0, 0]);
    idx.set("bad", [1, 1, 1, 1, 1, 1]); // refused
    // A 4-dim query searches without throwing because only 4-dim vectors exist.
    const hits = idx.search([1, 0, 0, 0], 5);
    expect(hits.map((h) => h.id).sort()).toEqual(["a", "b"]);
  });
});

describe("cosine dimension invariant (D2)", () => {
  it("throws on a dimension mismatch instead of truncating to the shorter length", () => {
    expect(() => cosine([1, 0, 0, 0], [1, 0])).toThrow(/dimension mismatch/);
    expect(() => cosine([1, 0], [1, 0, 0, 0])).toThrow(/dimension mismatch/);
  });

  it("computes the dot product for equal-length vectors", () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 10);
    expect(cosine([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 10);
  });
});
