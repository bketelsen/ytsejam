import { describe, expect, it } from "vitest";
import { extractFacts } from "../src/semantic/extract.ts";

describe("extractFacts shrapnel regression (#263)", () => {
  it("extracts no facts from historical noise task chatter", () => {
    const defer = extractFacts("I think we should defer right now and revisit Friday");
    expect(defer).toHaveLength(0);
    expect(defer.some((f) => /defer right/i.test(f.object))).toBe(false);

    expect(extractFacts("use the current state")).toHaveLength(0);

    const twist = extractFacts("make a margarita, but a with a twist");
    expect(twist).toHaveLength(0);
    expect(twist.some((f) => /with a twist/i.test(f.object))).toBe(false);

    const bedtime = extractFacts(
      "I want to fire these off before I go to bed and let you do the work",
    );
    expect(bedtime).toHaveLength(0);
    expect(bedtime.some((f) => f.predicate === "prefers")).toBe(false);

    const agents = extractFacts("I'd prefer that the agents update that one file");
    expect(agents).toHaveLength(0);
    expect(agents.some((f) => f.object.toLowerCase().includes("that"))).toBe(false);
  });

  it("still extracts clear preferences and identity controls", () => {
    expect(extractFacts("I prefer my own harness over hosted tools")).toContainEqual(
      expect.objectContaining({
        kind: "preference",
        predicate: "prefers",
        object: "my own harness",
        polarity: 1,
      }),
    );

    const identity = extractFacts("my name is Brian and I'm a Linux developer");
    expect(identity).toContainEqual(
      expect.objectContaining({ kind: "identity", predicate: "name", object: "Brian" }),
    );
    expect(identity).toContainEqual(
      expect.objectContaining({
        kind: "identity",
        predicate: "role",
        object: "Linux developer",
      }),
    );
  });
});
