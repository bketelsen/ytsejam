// server/test/memory/dream/e2e.test.ts
//
// End-to-end smoke test for the full dream pipeline:
//   MemorySystem → runDreamJob (mechanical + mine + report) → applyProposals → re-run dedup check
//
// Everything is deterministic: no real network calls (fetchImpl is stubbed),
// fixed timestamps via the `now` injection, temp dirs cleaned up after each test.

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemorySystem } from "ltm";
import { ProposalStore, keyOf } from "../../../src/memory/dream/proposal-store.ts";
import { runDreamJob } from "../../../src/memory/dream/dream-job.ts";
import { applyProposals } from "../../../src/memory/dream/apply.ts";

let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-e2e-")));

/** Build a stubbed fetch that returns a fixed propose_changes response. */
function fetchReturning(toolArgs: unknown): typeof fetch {
  const body = {
    choices: [{
      message: {
        tool_calls: [{
          function: {
            name: "propose_changes",
            arguments: JSON.stringify(toolArgs),
          },
        }],
      },
    }],
  };
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  ) as unknown as typeof fetch;
}

const NOW = "2026-06-20T03:00:00.000Z";
const now = () => NOW;

describe("dream pipeline e2e", () => {
  it("mechanical + mine + report + apply + re-run dedup", async () => {
    const root = tmp();
    const storeDir = path.join(root, "ltm");
    const dreamDir = path.join(root, "dream");

    // ── Step 1: seed the LTM store ──────────────────────────────────────────
    // Seed two observations that should both extract a `works_on` predicate
    // to create a synonym-predicate duplicate for the mechanical pass, plus
    // an un-embedded fact (embedded count may be >0 if embedder is hash).
    const ltm = MemorySystem.open({ storeDir });
    try {
      await ltm.recordObservation({
        text: "I work on ytsejam",
        timestamp: "2026-06-18T10:00:00Z",
        learnFacts: true,
      });
      await ltm.recordObservation({
        text: "I work on ytsejam repo",
        timestamp: "2026-06-18T11:00:00Z",
        learnFacts: true,
      });

      // Also seed a third fact we will use as the LLM drop target
      await ltm.recordObservation({
        text: "I work at Acme Corp",
        timestamp: "2026-06-18T12:00:00Z",
        learnFacts: true,
      });

      const allFacts = ltm.listFacts();
      const targetFact = allFacts.find((f) => f.predicate === "works_at");
      expect(targetFact).toBeDefined();
      const targetId = targetFact!.id;

      // ── Step 2: run runDreamJob ──────────────────────────────────────────
      const store = new ProposalStore(dreamDir);
      let postedSession = "";
      let postedText = "";
      let proposalId = "e2e-p1";

      const fetchImpl = fetchReturning({
        proposals: [
          {
            kind: "drop",
            factIds: [targetId],
            rationale: "Acme Corp is no longer the employer",
            confidence: 0.9,
          },
        ],
      });

      const out = await runDreamJob({
        ltm,
        // Real mechanical path, but reconcile is a stub (no cog files to replay)
        reconcile: async () => ({ pruned: 0 }),
        store,
        storeDir,
        dreamDir,
        gatherUserTurns: () => ({
          turns: [{ sessionId: "s1", entryId: "e1", text: "I no longer work at Acme." }],
          newCursorMs: 500,
        }),
        ensureMaintenanceSession: async () => "maint-session",
        postReport: async (sid, text) => { postedSession = sid; postedText = text; },
        getApiKey: async () => "tok",
        model: "m",
        minConfidence: 0.6,
        tokenBudget: 8000,
        proposeOnly: false,
        idFor: () => proposalId,
        now,
        fetchImpl,
      });

      // ── Step 3: assertions ───────────────────────────────────────────────

      // mechanical summary must be present (proposeOnly: false)
      expect(out.summary).not.toBeNull();
      // At least ONE mechanical metric is meaningful (canonicalized, merged,
      // folded, pruned, or embedded may all be 0 depending on what the seeded
      // facts produced — but backup path is always set).
      expect(typeof out.summary!.backup).toBe("string");

      // report posted to the maintenance session contains the header
      expect(postedSession).toBe("maint-session");
      expect(postedText).toContain("Memory maintenance");

      // report lists the drop proposal (by id or rationale)
      expect(postedText).toContain("e2e-p1");

      // proposal was persisted in the store
      const reloaded = new ProposalStore(dreamDir);
      const pending = reloaded.pending();
      expect(pending).toHaveLength(1);
      expect(pending[0].kind).toBe("drop");
      expect(pending[0].id).toBe("e2e-p1");

      // ── Step 4: applyProposals ────────────────────────────────────────────
      const applyResult = await applyProposals({ ltm, store: reloaded, now }, ["e2e-p1"]);
      expect(applyResult.applied).toContain("e2e-p1");
      expect(applyResult.skipped).not.toContain("e2e-p1");

      // targeted fact is tombstoned
      const afterFact = ltm.listFacts().find((f) => f.id === targetId);
      expect(afterFact?.state).toBe("redacted");

      // ── Step 5: re-run runDreamJob with the same stubbed LLM response ────
      //
      // The miner now excludes BOTH dismissed AND applied proposal keys
      // (via dismissedKeys() + appliedKeys()). Therefore, re-proposing the
      // same drop targeting the same (now-redacted) fact is excluded by the
      // anti-thrash guard (the applied key matches). No new pending proposal
      // is created.
      //
      // The redacted fact is also filtered out of `facts` inside runDreamJob
      // (it checks `f.state === "active"`), so the LLM stub's factIds
      // reference a non-active fact. But even if the miner received the drop
      // proposal again, it would be excluded by the appliedKeys() set.
      //
      // We assert the fixed behavior: no second pending proposal is created.

      proposalId = "e2e-p2"; // different id for second run
      const store2 = new ProposalStore(dreamDir); // reload to pick up applied status
      let postedText2 = "";

      const out2 = await runDreamJob({
        ltm,
        reconcile: async () => ({ pruned: 0 }),
        store: store2,
        storeDir,
        dreamDir,
        gatherUserTurns: () => ({
          turns: [{ sessionId: "s1", entryId: "e1", text: "I no longer work at Acme." }],
          newCursorMs: 600,
        }),
        ensureMaintenanceSession: async () => "maint-session",
        postReport: async (_sid, text) => { postedText2 = text; },
        getApiKey: async () => "tok",
        model: "m",
        minConfidence: 0.6,
        tokenBudget: 8000,
        proposeOnly: false,
        idFor: () => proposalId,
        now,
        fetchImpl, // same stub returning same drop targeting same targetId
      });

      // FIXED: applied proposals are now excluded from re-proposal via appliedKeys().
      // The anti-thrash guard now checks both dismissed and applied keys. Since
      // the same drop was already applied in step 4, it is now deduped by key,
      // and no second pending proposal is created.
      expect(out2.proposed).toBe(0);

      const store3 = new ProposalStore(dreamDir);
      const allPending = store3.pending();
      // The first proposal was applied (no longer pending), and the second one was excluded by anti-thrash
      expect(allPending).toHaveLength(0);

      // The second run's report still contains the header
      expect(postedText2).toContain("Memory maintenance");

    } finally {
      ltm.close();
    }
  });
});
