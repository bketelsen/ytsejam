import { describe, it, expect } from "vitest";
import { factId } from "../src/semantic/extract.ts";

const c = { kind: "directive" as const, predicate: "uses", polarity: 1 as const };

describe("factId project scoping", () => {
  it("is byte-identical to the legacy form when no projectTag (back-compat)", () => {
    expect(factId(c, "gate.sh before commit")).toBe("fact-directive-uses-gate-sh-before-commit-p");
  });
  it("appends @<tag> when a projectTag is present", () => {
    expect(factId(c, "gate.sh before commit", "projects:ytsejam"))
      .toBe("fact-directive-uses-gate-sh-before-commit-p@projects-ytsejam");
  });
  it("distinguishes a global and a project fact with the same predicate/object", () => {
    expect(factId(c, "gate.sh")).not.toBe(factId(c, "gate.sh", "projects:ytsejam"));
  });
});
