import { describe, it, expect } from "vitest";
import { buildMemorySection } from "../src/memory/memory-section.ts";

const profile = () => ({
  identity: [{ predicate: "name", object: "Brian" }],
  preferences: [{ predicate: "prefers", object: "Go" }],
  directives: [], attributes: [],
}) as any;

describe("buildMemorySection", () => {
  it("composes profile + recalled hits into a labeled block", async () => {
    const recall = async () => ({ hits: [{ from: "ltm", text: "decided to use streaming JSONL", where: "ltm:1", score: 0.7 }], cogCount: 0, ltmCount: 1, dropped: 0 }) as any;
    const out = await buildMemorySection({ profile, recall, activeProjectTag: () => "projects:ytsejam" }, "s1", "how do we load logs?");
    expect(out).toContain("Brian");
    expect(out).toContain("streaming JSONL");
  });
  it("returns undefined when profile is empty and recall has no hits", async () => {
    const recall = async () => ({ hits: [], cogCount: 0, ltmCount: 0, dropped: 0 }) as any;
    const out = await buildMemorySection({ profile: () => undefined, recall, activeProjectTag: () => null }, "s1", "hi");
    expect(out).toBeUndefined();
  });
  it("never throws if recall rejects (best-effort) -> returns profile-only or undefined", async () => {
    const recall = async () => { throw new Error("boom"); };
    const out = await buildMemorySection({ profile, recall, activeProjectTag: () => null }, "s1", "hi");
    expect(out).toContain("Brian"); // profile still rendered
  });
});
