// server/test/memory/dream/dream-job.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemorySystem } from "ltm";
import { ProposalStore } from "../../../src/memory/dream/proposal-store.ts";
import { runDreamJob } from "../../../src/memory/dream/dream-job.ts";

let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-job-")));

function fetchReturning(toolArgs: unknown): typeof fetch {
  const body = { choices: [{ message: { tool_calls: [{ function: { name: "propose_changes", arguments: JSON.stringify(toolArgs) } }] } }] };
  return (async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
}

describe("runDreamJob", () => {
  it("runs mechanical, mines, saves proposals, posts a report, advances the cursor", async () => {
    const root = tmp();
    const storeDir = path.join(root, "ltm");
    const dreamDir = path.join(root, "dream");
    const ltm = MemorySystem.open({ storeDir });
    try {
      await ltm.recordObservation({ text: "I work at Initech", timestamp: "2026-06-19T00:00:00Z", learnFacts: true });
      const fid = ltm.listFacts().find((f) => f.predicate === "works_at")!.id;

      const store = new ProposalStore(dreamDir);
      let posted = "";
      let postedSession = "";

      // stub fetch to return one drop proposal targeting the seeded fact
      const fetchImpl = fetchReturning({
        proposals: [
          { kind: "drop", factIds: [fid], rationale: "user wants it gone", confidence: 0.9 },
        ],
      });

      const out = await runDreamJob({
        ltm,
        reconcile: async () => ({ pruned: 0 }),
        store,
        storeDir,
        dreamDir,
        gatherUserTurns: () => ({ turns: [{ sessionId: "s", entryId: "e", text: "drop the initech fact" }], newCursorMs: 123 }),
        ensureMaintenanceSession: async () => "maint",
        postReport: async (sid, text) => { postedSession = sid; posted = text; },
        getApiKey: async () => "tok",
        model: "m",
        minConfidence: 0.6,
        tokenBudget: 8000,
        proposeOnly: false,
        idFor: () => "p1",
        now: () => "2026-06-20T03:00:00.000Z",
        fetchImpl,
      });

      // report was posted to the right session
      expect(postedSession).toBe("maint");
      expect(posted).toContain("Memory maintenance");

      // dream-state.json written with advanced cursor
      const state = JSON.parse(fs.readFileSync(path.join(dreamDir, "dream-state.json"), "utf8"));
      expect(state.cursorMs).toBe(123);
      expect(state.maintenanceSessionId).toBe("maint");

      // mechanical summary is present (proposeOnly: false)
      expect(out.summary).not.toBeNull();

      // proposal was saved
      expect(out.proposed).toBe(1);
      const reloaded = new ProposalStore(dreamDir);
      expect(reloaded.pending()).toHaveLength(1);
      expect(reloaded.pending()[0].kind).toBe("drop");

      // dream-log.jsonl appended
      const log = fs.readFileSync(path.join(dreamDir, "dream-log.jsonl"), "utf8").trim();
      expect(log.length).toBeGreaterThan(0);
      const entry = JSON.parse(log);
      expect(entry.proposed).toBe(1);
      expect(entry.reportSessionId).toBe("maint");
    } finally {
      ltm.close();
    }
  });

  it("skips mechanical pass when proposeOnly is true", async () => {
    const root = tmp();
    const storeDir = path.join(root, "ltm");
    const dreamDir = path.join(root, "dream");
    const ltm = MemorySystem.open({ storeDir });
    try {
      let mechanicalCalled = false;
      let posted = "";
      const fetchImpl = fetchReturning({ proposals: [] });
      const out = await runDreamJob({
        ltm,
        reconcile: async () => { mechanicalCalled = true; return { pruned: 0 }; },
        store: new ProposalStore(dreamDir),
        storeDir,
        dreamDir,
        gatherUserTurns: () => ({ turns: [], newCursorMs: 0 }),
        ensureMaintenanceSession: async () => "maint2",
        postReport: async (_sid, text) => { posted = text; },
        getApiKey: async () => "tok",
        model: "m",
        minConfidence: 0.6,
        tokenBudget: 8000,
        proposeOnly: true,
        idFor: () => "px",
        now: () => "2026-06-20T04:00:00.000Z",
        fetchImpl,
      });
      expect(mechanicalCalled).toBe(false);
      expect(out.summary).toBeNull();
      expect(posted).toContain("skipped (propose-only)");
      expect(posted).not.toContain("canonicalized");
    } finally {
      ltm.close();
    }
  });
});
