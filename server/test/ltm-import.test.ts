import { describe, expect, it } from "vitest";

// PR 0 / phase 0.0 — packaging-only smoke test.
//
// If the LTM workspace's public API drops, renames, or breaks export
// shape, this test fails the ytsejam gate. The test is intentionally
// minimal — it proves only that the import resolves and that the symbols
// Bridge 1-3 will depend on are present. Behavioral testing of LTM lives
// in packages/ltm/test/.
//
// When Bridge 1 actually lands, this file gets extended to assert
// recordObservation exists as a method on a MemorySystem instance.
describe("ltm workspace import surface (phase 0.0 smoke)", () => {
  it("ltm workspace resolves and exports MemorySystem", async () => {
    const mod = await import("ltm");
    expect(typeof mod.MemorySystem).toBe("function");
    expect(typeof mod.MemorySystem.open).toBe("function");
  });

  it("DEFAULT_CONFIG is exported for MemorySystem.open callers", async () => {
    const mod = await import("ltm");
    expect(mod).toHaveProperty("DEFAULT_CONFIG");
    expect(typeof mod.DEFAULT_CONFIG).toBe("object");
  });
});
