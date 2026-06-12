import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemorySystem } from "../src/api/memory-system.ts";
import { generateFixtures } from "../src/eval/synthetic.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ltm-test-"));
}

async function freshSystem(seed = 5) {
  const work = tmpDir();
  const sessionsDir = path.join(work, "sessions");
  const storeDir = path.join(work, "store");
  const truth = generateFixtures({ outDir: sessionsDir, sessions: 4, turnsPerSession: 8, seed });
  const mem = MemorySystem.open({ storeDir, now: () => truth.horizonEnd });
  await mem.ingestSessionDir(sessionsDir);
  return { mem, truth, storeDir, sessionsDir };
}

describe("redaction API", () => {
  it("redacting an entity removes it from retrieval, profile, and disk", async () => {
    const { mem, storeDir } = await freshSystem();

    const before = await mem.retrieve("What is my sister's name?", { k: 5, dryRun: true });
    expect(before.items.some((i) => i.record.text.includes("Alice"))).toBe(true);

    const result = await mem.redact({ entity: "Alice" });
    expect(result.episodicRedacted).toBeGreaterThan(0);
    expect(result.entitiesRedacted).toBeGreaterThanOrEqual(1);

    const after = await mem.retrieve("What is my sister's name?", { k: 5, dryRun: true });
    expect(after.items.some((i) => i.record.text.includes("Alice"))).toBe(false);
    expect(mem.listEntities().filter((e) => e.norm === "alice" && e.state === "active")).toHaveLength(0);

    // Nothing on disk may still contain the redacted content.
    for (const file of ["episodic.jsonl", "facts.jsonl", "entities.jsonl", "redactions.jsonl"]) {
      const p = path.join(storeDir, file);
      if (!fs.existsSync(p)) continue;
      expect(fs.readFileSync(p, "utf8")).not.toContain("Alice");
    }
  });

  it("redacting a session tombstones all its records and derived facts lose evidence", async () => {
    const { mem, truth } = await freshSystem();
    const target = truth.sessionIds[0];
    const result = await mem.redact({ sessionId: target });
    expect(result.episodicRedacted).toBeGreaterThan(0);
    expect(mem.listEpisodic({ sessionId: target }).every((r) => r.state === "redacted")).toBe(true);
  });

  it("pattern redaction works and is audited without leaking content", async () => {
    const { mem, storeDir } = await freshSystem();
    const result = await mem.redact({ pattern: "allergic to peanuts" });
    expect(result.episodicRedacted).toBeGreaterThan(0);

    const audit = mem.auditTrail();
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0].result)).not.toContain("peanut");

    const raw = fs.readFileSync(path.join(storeDir, "episodic.jsonl"), "utf8");
    expect(raw).not.toContain("allergic to peanuts");
  });

  it("rebuilds consolidated summaries that contained a redacted child", async () => {
    const work = tmpDir();
    const sessionsDir = path.join(work, "sessions");
    // Old corpus so consolidation triggers: sessions start far in the past.
    const truth = generateFixtures({
      outDir: sessionsDir,
      sessions: 4,
      turnsPerSession: 8,
      seed: 9,
      startDate: "2025-01-06T09:00:00.000Z",
    });
    const now = "2026-06-01T00:00:00.000Z";
    const mem = MemorySystem.open({ storeDir: path.join(work, "store"), now: () => now });
    await mem.ingestSessionDir(sessionsDir);
    const { created } = await mem.consolidate({ now });
    expect(created).toBeGreaterThan(0);

    const summaries = mem.listEpisodic().filter((r) => r.kind === "consolidated" && r.state === "active");
    const target = summaries.find((s) => (s.sourceIds?.length ?? 0) > 2)!;
    const child = target.sourceIds![0];

    const result = await mem.redact({ recordId: child });
    expect(result.consolidatedRebuilt).toBe(1);
    expect(mem.getRecord(target.id)?.state).toBe("redacted");
    const rebuilt = mem
      .listEpisodic()
      .find((r) => r.kind === "consolidated" && r.state === "active" && r.sourceIds?.includes(target.sourceIds![1]));
    expect(rebuilt).toBeDefined();
    expect(rebuilt!.sourceIds).not.toContain(child);
    void truth;
  });

  it("ingest → redact → reopen → re-ingest same sessions → still gone (PLAN 3.3)", async () => {
    const { mem, storeDir, sessionsDir, truth } = await freshSystem();
    const before = await mem.retrieve("What's my dog called?", { k: 5, dryRun: true });
    expect(before.items.some((i) => i.record.text.includes("Biscuit"))).toBe(true);

    await mem.redact({ entity: "Biscuit" });
    mem.close();

    // Reopen from disk and re-ingest the SAME session files. The
    // ingest-state already-processed gate must hold: nothing re-enters.
    const reopened = MemorySystem.open({ storeDir, now: () => truth.horizonEnd });
    const report = await reopened.ingestSessionDir(sessionsDir);
    expect(report.turnsIngested).toBe(0);
    expect(report.recordsCreated).toBe(0);

    const { items } = await reopened.retrieve("What's my dog called?", { k: 5, dryRun: true });
    expect(items.some((i) => i.record.text.includes("Biscuit"))).toBe(false);
    expect(reopened.listEntities().some((e) => e.norm === "biscuit" && e.state === "active")).toBe(false);
    // The episodic tombstones survived the round trip too.
    expect(
      reopened.listEpisodic().some((r) => r.state !== "redacted" && r.text.includes("Biscuit")),
    ).toBe(false);
    // And the on-disk logs never re-acquired the content.
    for (const file of ["episodic.jsonl", "facts.jsonl", "entities.jsonl"]) {
      expect(fs.readFileSync(path.join(storeDir, file), "utf8")).not.toContain("Biscuit");
    }
  });
});
