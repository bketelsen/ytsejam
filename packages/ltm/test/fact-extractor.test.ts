import { describe, it, expect } from "vitest";
import { RegexFactExtractor } from "../src/semantic/fact-extractor.ts";
import { extractFacts } from "../src/semantic/extract.ts";

describe("RegexFactExtractor", () => {
  it("returns the same core fields as extractFacts with scope:global added", async () => {
    const text = "My name is Brian. I prefer my own harness.";
    const ext = new RegexFactExtractor();
    const raw = extractFacts(text);
    const result = await ext.extract(text);
    // Core fields match the underlying extractFacts output
    expect(result.map(({ scope: _s, ...rest }) => rest)).toEqual(raw);
    // Every result has scope stamped as global
    for (const c of result) {
      expect(c.scope).toBe("global");
    }
  });

  it("returns [] for text with no facts", async () => {
    const ext = new RegexFactExtractor();
    expect(await ext.extract("the build passed and we moved on")).toEqual([]);
  });

  it("stamps scope:global on every extracted candidate", async () => {
    const ext = new RegexFactExtractor();
    const results = await ext.extract("my name is Brian");
    expect(results.length).toBeGreaterThan(0);
    for (const c of results) {
      expect(c.scope).toBe("global");
    }
  });
});
