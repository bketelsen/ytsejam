import { describe, it, expect, afterEach, vi } from "vitest";
import * as memory from "../src/memory/index.ts";

describe("memory.consolidateLtm()", () => {
  afterEach(() => {
    memory.attachLtm(null);
  });

  it("returns null when no LTM is attached", async () => {
    memory.attachLtm(null);
    const result = await memory.consolidateLtm();
    expect(result).toBeNull();
  });

  it("delegates to LTM.consolidate() and returns its result when attached", async () => {
    const fakeLtm = {
      consolidate: vi.fn(async () => ({ created: 2, folded: 5 })),
    };
    memory.attachLtm(fakeLtm as never);
    const result = await memory.consolidateLtm();
    expect(result).toEqual({ created: 2, folded: 5 });
    expect(fakeLtm.consolidate).toHaveBeenCalledTimes(1);
  });
});
