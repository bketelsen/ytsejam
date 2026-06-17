import { describe, expect, it } from "vitest";
import { normalizeUnit } from "../src/embedding/embedder.ts";

describe("normalizeUnit", () => {
  it("returns an L2-normalized vector", () => {
    expect(normalizeUnit([3, 4])).toEqual([0.6, 0.8]);
  });

  it("uses norm 1 for all-zero inputs", () => {
    expect(normalizeUnit([0, 0, 0])).toEqual([0, 0, 0]);
  });
});
