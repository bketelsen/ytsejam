import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import { MemorySystem } from "../src/api/memory-system.ts";
import { retention } from "../src/episodic/decay.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ltm-obs-"));
}

const NOW = "2026-06-01T00:00:00.000Z";

function openMem(dir = tmpDir()): MemorySystem {
  return MemorySystem.open({ storeDir: dir, now: () => NOW });
}

describe("recordObservation (SEAM 4)", () => {
  it("round-trips: a recorded observation is retrievable", async () => {
    const mem = openMem();
    await mem.recordObservation({
      text: "fold-cogmemory cutover shipped to ytsejam production",
      timestamp: "2026-05-15T09:00:00.000Z",
    });
    const { items } = await mem.retrieve("when did the fold-cogmemory cutover ship?", { dryRun: true });
    expect(items.some((i) => i.record.text.includes("fold-cogmemory"))).toBe(true);
    expect(items.find((i) => i.record.text.includes("fold-cogmemory"))!.record.kind).toBe("observation");
    mem.close();
  });

  it("is idempotent: same text+timestamp re-ingests to the same record", async () => {
    const mem = openMem();
    const a = await mem.recordObservation({ text: "pi-harness ships v0.1", timestamp: "2026-05-01T00:00:00.000Z" });
    const b = await mem.recordObservation({ text: "pi-harness ships v0.1", timestamp: "2026-05-01T00:00:00.000Z" });
    expect(b.id).toBe(a.id);
    expect(mem.listEpisodic().filter((r) => r.id === a.id)).toHaveLength(1);
    // A different timestamp is a different observation.
    const c = await mem.recordObservation({ text: "pi-harness ships v0.1", timestamp: "2026-05-02T00:00:00.000Z" });
    expect(c.id).not.toBe(a.id);
    mem.close();
  });

  it("feeds the semantic extractor with origin-based provenance", async () => {
    const mem = openMem();
    await mem.recordObservation({
      text: "I work at Initech.",
      timestamp: "2026-05-01T00:00:00.000Z",
      origin: "cog:personal/observations.md#2026-05-01:abc123def456",
    });
    const fact = mem.listFacts().find((f) => f.predicate === "works_at");
    expect(fact).toBeDefined();
    expect(fact!.sources[0].sessionId).toBe("cog:personal/observations.md#2026-05-01:abc123def456");
    mem.close();
  });

  it("observations decay on the slow per-kind half-life", () => {
    const twoYearsLater = "2028-05-01T00:00:00.000Z";
    const shape = { timestamp: "2026-05-01T00:00:00.000Z", salience: 0.5, accessCount: 0 };
    const obs = retention({ ...shape, kind: "observation" }, twoYearsLater, DEFAULT_CONFIG.decay);
    const turn = retention({ ...shape, kind: "turn" }, twoYearsLater, DEFAULT_CONFIG.decay);
    // 730d base at salience 0.5 → halfLife 730 → 2^(-730/730) = 0.5.
    expect(obs).toBeCloseTo(0.5, 2);
    expect(turn).toBeLessThan(0.01); // 30d base — long gone
  });

  it("carries tags into retrieval scoping", async () => {
    const mem = openMem();
    await mem.recordObservation({
      text: "ytsejam deploy pipeline moved to forgejo actions",
      timestamp: "2026-05-20T00:00:00.000Z",
      tags: ["projects:ytsejam"],
    });
    const scoped = await mem.retrieve("deploy pipeline", { filterTags: ["projects"], dryRun: true });
    expect(scoped.items.some((i) => i.record.text.includes("forgejo"))).toBe(true);
    const other = await mem.retrieve("deploy pipeline", { filterTags: ["infra"], dryRun: true });
    expect(other.items.some((i) => i.record.text.includes("forgejo"))).toBe(false);
    mem.close();
  });
});

describe("observation redaction + consolidation exemption (SEAM 5)", () => {
  it("originPrefix redaction tombstones observations and cascades to their facts", async () => {
    const mem = openMem();
    await mem.recordObservation({
      text: "I work at Initech.",
      timestamp: "2026-05-01T00:00:00.000Z",
      origin: "cog:personal/observations.md#2026-05-01:aaa111",
    });
    await mem.recordObservation({
      text: "ytsejam deploy moved to forgejo.",
      timestamp: "2026-05-02T00:00:00.000Z",
      origin: "cog:projects/ytsejam/dev-log.md#2026-05-02:bbb222",
    });

    const res = await mem.redact({ originPrefix: "cog:personal/" });
    expect(res.episodicRedacted).toBe(1);
    expect(res.factsRedacted).toBeGreaterThanOrEqual(1); // works_at cascaded

    // The personal observation and its fact are gone; the ytsejam one survives.
    const { items } = await mem.retrieve("where do I work", { dryRun: true });
    expect(items.every((i) => !i.record.text.includes("Initech"))).toBe(true);
    expect(mem.listFacts().some((f) => f.predicate === "works_at" && f.state === "active")).toBe(false);
    expect(mem.listEpisodic().some((r) => r.text.includes("forgejo"))).toBe(true);
    mem.close();
  });

  it("the audit trail keeps the origin prefix verbatim (a pointer, not content)", async () => {
    const mem = openMem();
    await mem.recordObservation({ text: "note", timestamp: "2026-05-01T00:00:00.000Z", origin: "cog:work/x.md#d:1" });
    await mem.redact({ originPrefix: "cog:work/" });
    const last = mem.auditTrail().at(-1)!;
    expect(last.selector).toEqual({ type: "originPrefix", ref: "cog:work/" });
    mem.close();
  });

  it("consolidation never folds observation records (SEAM 5)", async () => {
    const mem = openMem();
    // A long-decayed observation: old timestamp, but slow half-life keeps it
    // alive; even if it dipped below the floor, kind!=="turn" exempts it.
    await mem.recordObservation({ text: "ancient deliberate note", timestamp: "2022-01-01T00:00:00.000Z" });
    const { created, folded } = await mem.consolidate();
    expect(created).toBe(0);
    expect(folded).toBe(0);
    expect(mem.listEpisodic().some((r) => r.kind === "observation" && r.state === "active")).toBe(true);
    mem.close();
  });
});

describe("recordObservation re-ingest is fact-idempotent (SEAM 5 review)", () => {
  it("re-recording the same observation does not inflate fact mentionCount/strength", async () => {
    const mem = openMem();
    const args = { text: "I work at Initech.", timestamp: "2026-05-01T00:00:00.000Z" };
    await mem.recordObservation(args);
    const first = mem.listFacts().find((f) => f.predicate === "works_at")!;
    const m0 = first.mentionCount;
    const s0 = first.strength;
    await mem.recordObservation(args);
    await mem.recordObservation(args);
    const again = mem.listFacts().find((f) => f.predicate === "works_at")!;
    expect(again.mentionCount).toBe(m0); // not 3
    expect(again.strength).toBe(s0); // no reinforcement drift
    expect(mem.listEpisodic().filter((r) => r.kind === "observation")).toHaveLength(1);
    mem.close();
  });

  it("re-recording with new metadata updates the record latest-wins without re-learning", async () => {
    const mem = openMem();
    const base = { text: "ytsejam deploy moved to forgejo.", timestamp: "2026-05-02T00:00:00.000Z" };
    await mem.recordObservation(base);
    await mem.recordObservation({ ...base, tags: ["projects:ytsejam"] });
    const rec = mem.listEpisodic().find((r) => r.text.includes("forgejo"))!;
    expect(rec.tags).toEqual(["projects:ytsejam"]); // metadata updated
    mem.close();
  });
});


describe("MemorySystem.hasObservation", () => {
  it("returns false before record, true after", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ltm-has-"));
    const mem = await MemorySystem.open({ storeDir: dir });
    try {
      const origin = "cog:personal/observations.md#abc123def456";
      expect(mem.hasObservation(origin)).toBe(false);
      await mem.recordObservation({
        text: "hello",
        timestamp: "2026-06-13T00:00:00.000Z",
        origin,
      });
      expect(mem.hasObservation(origin)).toBe(true);
    } finally {
      mem.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns false for origins from other records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ltm-has-"));
    const mem = await MemorySystem.open({ storeDir: dir });
    try {
      await mem.recordObservation({
        text: "hello",
        timestamp: "2026-06-13T00:00:00.000Z",
        origin: "cog:personal/observations.md#aaa",
      });
      expect(mem.hasObservation("cog:personal/observations.md#bbb")).toBe(false);
    } finally {
      mem.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("survives a close/reopen cycle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ltm-has-"));
    const origin = "cog:projects/ytsejam/observations.md#deadbeef1234";
    let mem = await MemorySystem.open({ storeDir: dir });
    try {
      await mem.recordObservation({
        text: "persisted",
        timestamp: "2026-06-13T00:00:00.000Z",
        origin,
      });
    } finally {
      mem.close();
    }
    mem = await MemorySystem.open({ storeDir: dir });
    try {
      expect(mem.hasObservation(origin)).toBe(true);
    } finally {
      mem.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
