import { describe, it, expect } from "vitest";
import { composeReport } from "../../../src/memory/dream/report.ts";
import type { Proposal, MechanicalSummary } from "../../../src/memory/dream/types.ts";

const summary: MechanicalSummary = { backup: "/x.bak", canonicalized: 2, merged: 1, folded: 0, pruned: 1, embedded: 3 };

describe("composeReport", () => {
  it("lists autonomous actions and numbered proposals with ids", () => {
    const proposals: Proposal[] = [
      { id: "p1", kind: "drop", factIds: ["f1"], rationale: "generic", confidence: 0.9, status: "pending" },
    ];
    const text = composeReport("2026-06-20", summary, proposals, (id) => (id === "f1" ? "uses=git" : undefined));
    expect(text).toContain("Memory maintenance");
    expect(text).toContain("canonicalized 2");
    expect(text).toContain("1."); // numbered
    expect(text).toContain("uses=git");
    expect(text).toContain("apply");
  });

  it("says nothing-to-review when there are no proposals", () => {
    const text = composeReport("2026-06-20", summary, [], () => undefined);
    expect(text.toLowerCase()).toContain("no proposals");
  });
});
