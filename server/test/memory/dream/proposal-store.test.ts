import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { ProposalStore, keyOf } from "../../../src/memory/dream/proposal-store.ts";
import type { Proposal } from "../../../src/memory/dream/types.ts";

let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-ps-")));
const p = (over: Partial<Proposal>): Proposal => ({
  id: over.id ?? "p1", kind: over.kind ?? "drop", factIds: over.factIds ?? ["f1"],
  rationale: over.rationale ?? "junk", confidence: over.confidence ?? 0.9, status: over.status ?? "pending", ...over,
});

describe("ProposalStore", () => {
  it("persists, lists pending, sets status, and survives reload", () => {
    const d = tmp();
    const s = new ProposalStore(d);
    s.save([p({ id: "p1" }), p({ id: "p2", factIds: ["f2"] })]);
    expect(s.pending().map((x) => x.id).sort()).toEqual(["p1", "p2"]);
    s.setStatus("p1", "applied");
    s.setStatus("p2", "dismissed");
    const reopened = new ProposalStore(d);
    expect(reopened.pending()).toHaveLength(0);
    expect(reopened.dismissedKeys().has(keyOf(p({ id: "p2", factIds: ["f2"] })))).toBe(true);
  });
});
