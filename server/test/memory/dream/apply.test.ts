// server/test/memory/dream/apply.test.ts
import { describe, it, expect, afterEach, vi } from "vitest";
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
      const res = await applyProposals({ ltm, store, now }, ["p2"]);
      expect(res.applied).toEqual(["p2"]);
      expect(ltm.listFacts().some((f) => f.predicate === "prefers" && f.object === "Go")).toBe(true);
      expect(store.get("p2")!.status).toBe("applied");
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

  it("add with known predicate does not warn and learns the fact", async () => {
    const root = tmp();
    const ltm = MemorySystem.open({ storeDir: path.join(root, "ltm") });
    try {
      const store = new ProposalStore(path.join(root, "dream"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      store.save([{ id: "p4", kind: "add", factIds: [], add: { kind: "preference", predicate: "prefers", object: "Rust", polarity: 1 as const, sourceRef: { sessionId: "s", entryId: "e" } }, rationale: "known", confidence: 0.9, status: "pending" }]);
      const res = await applyProposals({ ltm, store, now }, ["p4"]);

      expect(warnSpy).not.toHaveBeenCalled();
      expect(ltm.listFacts().some((f) => f.predicate === "prefers" && f.object === "Rust")).toBe(true);
      expect(res.applied).toEqual(["p4"]);

      warnSpy.mockRestore();
    } finally { ltm.close(); }
  });

  it("add with unknown predicate warns and stays pending (fact does not round-trip)", async () => {
    const root = tmp();
    const ltm = MemorySystem.open({ storeDir: path.join(root, "ltm") });
    try {
      const store = new ProposalStore(path.join(root, "dream"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      store.save([{ id: "p5", kind: "add", factIds: [], add: { kind: "preference", predicate: "speaks_language", object: "Spanish", polarity: 1 as const, sourceRef: { sessionId: "s", entryId: "e" } }, rationale: "unknown", confidence: 0.9, status: "pending" }]);
      const res = await applyProposals({ ltm, store, now }, ["p5"]);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[dream] add proposal used a non-standard predicate "speaks_language"'));
      // Unknown predicate does not round-trip through the regex extractor →
      // proposal stays pending so the user can review it manually.
      expect(store.get("p5")!.status).toBe("pending");
      expect(res.skipped).toContain("p5");
      expect(res.applied).not.toContain("p5");

      warnSpy.mockRestore();
    } finally { ltm.close(); }
  });

  it("merge records canonical, verifies round-trip, then redacts originals", async () => {
    const root = tmp();
    const ltm = MemorySystem.open({ storeDir: path.join(root, "ltm") });
    try {
      // Seed two preference facts that the merge will fold.
      // The canonical ("I like TypeScript") is NEW — it is deliberately NOT one of the originals
      // so that after the merge, the canonical survives as an active fact.
      await ltm.recordObservation({ text: "I like ts", timestamp: now(), learnFacts: true });
      await ltm.recordObservation({ text: "I like typescript lang", timestamp: now(), learnFacts: true });
      const origIds = ltm.listFacts().filter((f) => f.predicate === "prefers").map((f) => f.id);
      expect(origIds.length).toBeGreaterThanOrEqual(2);

      const store = new ProposalStore(path.join(root, "dream"));
      // Canonical uses a distinct object so its fact id won't collide with the originals.
      store.save([{
        id: "pm1",
        kind: "merge",
        factIds: origIds,
        canonical: { kind: "preference", predicate: "prefers", object: "TypeScript", polarity: 1 as const },
        rationale: "fold duplicate typescript preference facts",
        confidence: 0.95,
        status: "pending",
      }]);

      const res = await applyProposals({ ltm, store, now }, ["pm1"]);

      expect(res.applied).toContain("pm1");
      expect(store.get("pm1")!.status).toBe("applied");

      const allFacts = ltm.listFacts();

      // Canonical fact must exist as active (its id was not in origIds)
      expect(allFacts.some((f) => f.predicate === "prefers" && f.object === "TypeScript" && f.state === "active")).toBe(true);

      // All originals are redacted
      for (const id of origIds) {
        const f = allFacts.find((f) => f.id === id);
        if (f) expect(f.state).toBe("redacted");
      }
    } finally { ltm.close(); }
  });

  it("merge whose canonical does not round-trip leaves originals intact and proposal pending", async () => {
    const root = tmp();
    const ltm = MemorySystem.open({ storeDir: path.join(root, "ltm") });
    try {
      // Seed a fact to use as "original" for the merge
      await ltm.recordObservation({ text: "I work at Acme", timestamp: now(), learnFacts: true });
      const origFact = ltm.listFacts().find((f) => f.predicate === "works_at")!;
      expect(origFact).toBeDefined();

      const store = new ProposalStore(path.join(root, "dream"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Use an unknown predicate for canonical so it cannot round-trip
      store.save([{
        id: "pm2",
        kind: "merge",
        factIds: [origFact.id],
        canonical: { kind: "preference", predicate: "speaks_language", object: "English", polarity: 1 as const },
        rationale: "merge test with unparseable canonical",
        confidence: 0.9,
        status: "pending",
      }]);

      const res = await applyProposals({ ltm, store, now }, ["pm2"]);

      expect(res.skipped).toContain("pm2");
      expect(res.applied).not.toContain("pm2");
      expect(store.get("pm2")!.status).toBe("pending");

      // Original fact is still intact
      const stillActive = ltm.listFacts().find((f) => f.id === origFact.id);
      expect(stillActive?.state).toBe("active");

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("merge skipped"));

      warnSpy.mockRestore();
    } finally { ltm.close(); }
  });

  it("merge carries the originals' source turns onto the canonical fact", async () => {
    const root = tmp();
    const ltm = MemorySystem.open({ storeDir: path.join(root, "ltm") });
    try {
      // Two originals from distinct source origins.
      await ltm.recordObservation({ text: "I am working on alpha", timestamp: now(), origin: "cog:alpha", learnFacts: true });
      await ltm.recordObservation({ text: "I am working on beta", timestamp: now(), origin: "cog:beta", learnFacts: true });
      const ids = ltm.listFacts().filter((f) => f.predicate === "works_on" && f.state === "active").map((f) => f.id);
      expect(ids.length).toBe(2);

      const store = new ProposalStore(path.join(root, "dream"));
      store.save([{ id: "pm3", kind: "merge", factIds: ids,
        canonical: { kind: "attribute", predicate: "works_on", object: "ytsejam", polarity: 1 as const },
        rationale: "dupes", confidence: 0.9, status: "pending" }]);

      await applyProposals({ ltm, store, now }, ["pm3"]);

      const canon = ltm.listFacts().find((f) => f.state === "active" && f.object === "ytsejam");
      expect(canon).toBeDefined();
      const sessionIds = new Set(canon!.sources.map((s) => s.sessionId));
      // inherited both originals' provenance (plus its own synthetic dream source)
      expect(sessionIds.has("cog:alpha")).toBe(true);
      expect(sessionIds.has("cog:beta")).toBe(true);
    } finally { ltm.close(); }
  });
});
