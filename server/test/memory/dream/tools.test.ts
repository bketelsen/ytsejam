// server/test/memory/dream/tools.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { MemorySystem } from "ltm";
import { ProposalStore } from "../../../src/memory/dream/proposal-store.ts";
import { createDreamTools } from "../../../src/memory/dream/tools.ts";

let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-tools-")));

describe("createDreamTools", () => {
  it("returns tools only for the maintenance session", () => {
    const root = tmp();
    const ltm = MemorySystem.open({ storeDir: path.join(root, "ltm") });
    try {
      const store = new ProposalStore(path.join(root, "dream"));
      const deps = { apply: { ltm, store, now: () => "2026-06-20T03:00:00Z" }, maintenanceSessionId: () => "maint" };
      expect(createDreamTools(deps, "other")).toHaveLength(0);
      const tools = createDreamTools(deps, "maint");
      expect(tools.map((t) => t.name).sort()).toEqual(["ltm_apply_proposals", "ltm_dismiss_proposals"]);
    } finally { ltm.close(); }
  });

  it("apply tool applies a pending proposal", async () => {
    const root = tmp();
    const ltm = MemorySystem.open({ storeDir: path.join(root, "ltm") });
    try {
      await ltm.recordObservation({ text: "I work at Initech", timestamp: "2026-06-20T03:00:00Z", learnFacts: true });
      const fid = ltm.listFacts().find((f) => f.predicate === "works_at")!.id;
      const store = new ProposalStore(path.join(root, "dream"));
      store.save([{ id: "p1", kind: "drop", factIds: [fid], rationale: "x", confidence: 0.9, status: "pending" }]);
      const tools = createDreamTools({ apply: { ltm, store, now: () => "2026-06-20T03:00:00Z" }, maintenanceSessionId: () => "maint" }, "maint");
      const apply = tools.find((t) => t.name === "ltm_apply_proposals")!;
      await apply.execute("call-1", { ids: ["p1"] });
      expect(store.get("p1")!.status).toBe("applied");
    } finally { ltm.close(); }
  });
});
