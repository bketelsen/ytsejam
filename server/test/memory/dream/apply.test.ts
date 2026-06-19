// server/test/memory/dream/apply.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { MemorySystem } from "ltm";
import { ProposalStore } from "../../../src/memory/dream/proposal-store.ts";
import { applyProposals, dismissProposals } from "../../../src/memory/dream/apply.ts";

let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-apply-")));
const now = () => "2026-06-20T03:00:00.000Z";

describe("applyProposals", () => {
  it("drop tombstones a fact and marks the proposal applied", async () => {
    const root = tmp();
    const ltm = MemorySystem.open({ storeDir: path.join(root, "ltm") });
    try {
      await ltm.recordObservation({ text: "I work at Initech", timestamp: now(), learnFacts: true });
      const fid = ltm.listFacts().find((f) => f.predicate === "works_at")!.id;
      const store = new ProposalStore(path.join(root, "dream"));
      store.save([{ id: "p1", kind: "drop", factIds: [fid], rationale: "junk", confidence: 0.9, status: "pending" }]);
      const res = await applyProposals({ ltm, store, now }, ["p1"]);
      expect(res.applied).toEqual(["p1"]);
      expect(ltm.listFacts().find((f) => f.id === fid)!.state).toBe("redacted");
      expect(store.get("p1")!.status).toBe("applied");
    } finally { ltm.close(); }
  });

  it("add learns a user-confirmed fact via the learnFacts path", async () => {
    const root = tmp();
    const ltm = MemorySystem.open({ storeDir: path.join(root, "ltm") });
    try {
      const store = new ProposalStore(path.join(root, "dream"));
      store.save([{ id: "p2", kind: "add", factIds: [], add: { kind: "preference", predicate: "prefers", object: "Go", polarity: 1 as const, sourceRef: { sessionId: "s", entryId: "e" } }, rationale: "stated", confidence: 0.9, status: "pending" }]);
      await applyProposals({ ltm, store, now }, ["p2"]);
      expect(ltm.listFacts().some((f) => f.predicate === "prefers" && f.object === "Go")).toBe(true);
    } finally { ltm.close(); }
  });

  it("dismiss marks dismissed", () => {
    const root = tmp();
    const ltm = MemorySystem.open({ storeDir: path.join(root, "ltm") });
    try {
      const store = new ProposalStore(path.join(root, "dream"));
      store.save([{ id: "p3", kind: "drop", factIds: ["f"], rationale: "", confidence: 0.9, status: "pending" }]);
      expect(dismissProposals({ ltm, store, now }, ["p3"]).dismissed).toEqual(["p3"]);
      expect(store.get("p3")!.status).toBe("dismissed");
    } finally { ltm.close(); }
  });
});
