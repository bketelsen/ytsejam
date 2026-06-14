import { describe, expect, it } from "vitest";
import {
  parseObservationLine,
  primaryTagFromObservationLine,
} from "../../src/memory/consolidated/observation-grammar.ts";

describe("observation grammar", () => {
  it("parses simple single-tag observations", () => {
    expect(parseObservationLine("- 2026-06-13 [tag]: simple")).toEqual({
      date: "2026-06-13",
      tags: ["tag"],
      text: "simple",
    });
  });

  it("flattens multi-bracket tags", () => {
    expect(parseObservationLine("- 2026-06-13 [a][b][c]: adjacent")?.tags).toEqual(["a", "b", "c"]);
  });

  it("flattens comma-separated tags", () => {
    expect(parseObservationLine("- 2026-06-13 [a, b, c]: comma")?.tags).toEqual(["a", "b", "c"]);
    expect(parseObservationLine("- 2026-06-13 [a,b,c,d]: many tags")?.tags).toEqual(["a", "b", "c", "d"]);
  });

  it("flattens mixed comma and multi-bracket tags", () => {
    expect(parseObservationLine("- 2026-06-13 [a, b][c]: mixed")?.tags).toEqual(["a", "b", "c"]);
  });

  it("trims tag entries and trailing text whitespace", () => {
    expect(parseObservationLine("- 2026-06-13 [  a  ][ b ]:   spaced text  ")).toEqual({
      date: "2026-06-13",
      tags: ["a", "b"],
      text: "spaced text",
    });
  });

  it("returns an empty tag list for whitespace-only tag blocks, deferring rejection to consumers", () => {
    expect(parseObservationLine("- 2026-06-13 [   ]: no real tags")?.tags).toEqual([]);
  });

  it("returns null for semantically invalid calendar dates", () => {
    expect(parseObservationLine("- 2026-13-99 [x]: bad month and day")).toBeNull();
    expect(parseObservationLine("- 2026-02-30 [x]: feb 30")).toBeNull();
    expect(parseObservationLine("- 2026-13-01 [x]: bad month")).toBeNull();
    expect(parseObservationLine("- 2024-02-29 [x]: leap day")).not.toBeNull();
  });

  it("returns null when the observation line shape does not match", () => {
    expect(parseObservationLine("2026-06-13 [tag]: missing dash")).toBeNull();
    expect(parseObservationLine("- 2026-06-13: missing tags")).toBeNull();
    expect(parseObservationLine("- 2026-06-13 []: empty bracket")).toBeNull();
  });

  it("extracts the primary tag through the shared parser", () => {
    expect(primaryTagFromObservationLine("- 2026-06-13 [a, b][c]: mixed")).toBe("a");
  });

  it("preserves the primary-tag fallback for empty first entries", () => {
    expect(primaryTagFromObservationLine("- 2026-06-13 [ , b][c]: mixed")).toBe("(untagged)");
  });
});
