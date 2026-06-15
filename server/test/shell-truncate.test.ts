import { describe, expect, test } from "vitest";
import { truncate } from "../src/tools/shell.ts";

describe("truncate", () => {
  test("returns text shorter than max unchanged", () => {
    expect(truncate("short", 10)).toBe("short");
  });

  test("returns text exactly at max unchanged", () => {
    expect(truncate("0123456789", 10)).toBe("0123456789");
  });

  test("returns sliced text with truncated suffix when over max", () => {
    expect(truncate("0123456789abcde", 10)).toBe("0123456789\n[truncated 5 chars]");
  });
});
