import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemorySystem } from "../src/api/memory-system.ts";

describe("MemorySystem.indexDimension", () => {
  it("returns null when the system has no observations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ltm-index-dim-"));
    const mem = MemorySystem.open({ storeDir: dir });
    try {
      expect(mem.indexDimension()).toBeNull();
    } finally {
      mem.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns the embedder dimension after one observation is recorded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ltm-index-dim-"));
    const mem = MemorySystem.open({ storeDir: dir });
    try {
      await mem.recordObservation({
        text: "index dimension smoke observation",
        timestamp: "2026-06-14T00:00:00.000Z",
      });
      expect(mem.indexDimension()).toBe(256);
    } finally {
      mem.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
