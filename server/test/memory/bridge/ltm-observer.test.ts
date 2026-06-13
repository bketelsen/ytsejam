import { describe, expect, it } from "vitest";
import {
  parseObservationLine,
  computeOrigin,
} from "../../../src/memory/bridge/ltm-observer.js";

describe("parseObservationLine", () => {
  it("parses a tagged single-line observation", () => {
    const r = parseObservationLine("- 2026-06-13 [ltm,bridge]: shipped PR 1 today");
    expect(r).toEqual({
      text: "shipped PR 1 today",
      timestamp: "2026-06-13T00:00:00.000Z",
      tags: ["ltm", "bridge"],
    });
  });

  it("parses an untagged observation", () => {
    const r = parseObservationLine("- 2026-06-13: a thing happened");
    expect(r).toEqual({
      text: "a thing happened",
      timestamp: "2026-06-13T00:00:00.000Z",
      tags: [],
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
