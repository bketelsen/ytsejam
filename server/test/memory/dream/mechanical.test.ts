import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { MemorySystem } from "ltm";
import { runMechanicalPass } from "../../../src/memory/dream/mechanical.ts";

let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-mech-")));

describe("runMechanicalPass", () => {
  it("snapshots facts.jsonl, runs the ops, and is a no-op the second time", async () => {
    const storeDir = path.join(tmp(), "ltm");
    const ltm = MemorySystem.open({ storeDir });
    try {
      await ltm.recordObservation({ text: "I prefer dark mode", timestamp: "2026-06-19T00:00:00Z", tags: ["x"], learnFacts: true });
      const reconcile = async () => ({ pruned: 0 });
      const now = () => "2026-06-19T03:00:00.000Z";
      const first = await runMechanicalPass({ ltm, reconcile, storeDir, now });
      expect(fs.existsSync(first.backup)).toBe(true);
      const second = await runMechanicalPass({ ltm, reconcile, storeDir, now });
      expect(second.canonicalized).toBe(0);
      expect(second.merged).toBe(0);
    } finally { ltm.close(); }
  });
});
