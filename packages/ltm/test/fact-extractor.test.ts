import { describe, it, expect } from "vitest";
import { RegexFactExtractor } from "../src/semantic/fact-extractor.ts";
import { extractFacts } from "../src/semantic/extract.ts";

describe("RegexFactExtractor", () => {
  it("returns exactly what extractFacts returns (parity)", async () => {
    const text = "My name is Brian. I prefer my own harness.";
    const ext = new RegexFactExtractor();
    expect(await ext.extract(text)).toEqual(extractFacts(text));
  });

  it("returns [] for text with no facts", async () => {
    const ext = new RegexFactExtractor();
    expect(await ext.extract("the build passed and we moved on")).toEqual([]);
  });
});
