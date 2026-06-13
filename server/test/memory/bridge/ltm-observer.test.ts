import { describe, expect, it } from "vitest";
import {
  parseObservationLine,
  computeOrigin,
} from "../../../src/memory/bridge/ltm-observer.ts";

describe("parseObservationLine", () => {
  it("parses a tagged single-line observation", () => {
    const r = parseObservationLine("- 2026-06-13 [ltm,bridge]: shipped PR 1 today");
    expect(r).toEqual({
      text: "shipped PR 1 today",
      timestamp: "2026-06-13T00:00:00.000Z",
      tags: ["ltm", "bridge"],
    });
  });

  it("trims whitespace and tag entries", () => {
    const r = parseObservationLine("- 2026-06-13 [  ltm , bridge  ]:   spaced out  ");
    expect(r).toEqual({
      text: "spaced out",
      timestamp: "2026-06-13T00:00:00.000Z",
      tags: ["ltm", "bridge"],
    });
  });

  it("returns null on malformed date", () => {
    expect(parseObservationLine("- 26-6-13 [x]: bad date")).toBeNull();
  });

  it("returns null on missing dash prefix", () => {
    expect(parseObservationLine("2026-06-13 [x]: no dash")).toBeNull();
  });

  it("returns null on missing colon", () => {
    expect(parseObservationLine("- 2026-06-13 [x] no colon")).toBeNull();
  });

  it("returns null on empty text body", () => {
    expect(parseObservationLine("- 2026-06-13 [x]: ")).toBeNull();
  });

  it("handles multi-tag without spaces", () => {
    const r = parseObservationLine("- 2026-06-13 [a,b,c,d]: many tags");
    expect(r?.tags).toEqual(["a", "b", "c", "d"]);
  });

  it("returns null on untagged observation (tags required per cog SSOT)", () => {
    expect(parseObservationLine("- 2026-06-13: missing tags")).toBeNull();
  });

  it("returns null on empty tag block [  ]", () => {
    expect(parseObservationLine("- 2026-06-13 [  ]: tags spaces-only")).toBeNull();
  });

  it("returns null on empty tag block []", () => {
    expect(parseObservationLine("- 2026-06-13 []: no tags")).toBeNull();
  });

  it("returns null on whitespace-only tag entries [, ,]", () => {
    // split yields ["", " ", ""], all trimmed to "" and filtered -> tags.length === 0
    expect(parseObservationLine("- 2026-06-13 [, ,]: no real tags")).toBeNull();
  });

  it("returns null on structurally-valid but invalid date (2026-13-99)", () => {
    expect(parseObservationLine("- 2026-13-99 [x]: bad month and day")).toBeNull();
  });

  it("returns null on Feb 30", () => {
    expect(parseObservationLine("- 2026-02-30 [x]: not a real day")).toBeNull();
  });

  it("returns null on embedded newline in body (regex stops at \n)", () => {
    expect(parseObservationLine("- 2026-06-13 [x]: line one\nline two")).toBeNull();
  });
});

describe("computeOrigin", () => {
  it("produces a stable cog:<path>/<file>#<hash> shape", () => {
    const o = computeOrigin("personal", "observations.md", "- 2026-06-13 [x]: foo");
    expect(o).toMatch(/^cog:personal\/observations\.md#[0-9a-f]{12}$/);
  });

  it("distinguishes same line in two different files", () => {
    const a = computeOrigin("personal", "observations.md", "- 2026-06-13 [x]: foo");
    const b = computeOrigin("projects/ytsejam", "observations.md", "- 2026-06-13 [x]: foo");
    expect(a).not.toBe(b);
  });

  it("distinguishes two lines in the same file", () => {
    const a = computeOrigin("personal", "observations.md", "- 2026-06-13 [x]: foo");
    const b = computeOrigin("personal", "observations.md", "- 2026-06-13 [x]: bar");
    expect(a).not.toBe(b);
  });

  it("is deterministic across calls", () => {
    const a = computeOrigin("personal", "observations.md", "- 2026-06-13 [x]: foo");
    const b = computeOrigin("personal", "observations.md", "- 2026-06-13 [x]: foo");
    expect(a).toBe(b);
  });
});
