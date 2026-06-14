import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemorySystem } from "../src/api/memory-system.ts";
import { EpisodicStore } from "../src/episodic/store.ts";
import type { EpisodicRecord } from "../src/types.ts";

async function withMem<T>(
  fn: (mem: MemorySystem, dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ltm-memory-system-"));
  const mem = MemorySystem.open({ storeDir: dir });
  try {
    return await fn(mem, dir);
  } finally {
    mem.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function rawRecord(over: Partial<EpisodicRecord>): EpisodicRecord {
  return {
    id: over.id ?? "raw",
    kind: over.kind ?? "observation",
    sessionId: over.sessionId ?? "raw-session",
    entryId: over.entryId ?? over.id ?? "raw-entry",
    role: over.role ?? "user",
    text: over.text ?? "raw text",
    timestamp: over.timestamp ?? "2026-06-14T00:00:00.000Z",
    salience: over.salience ?? 0.5,
    accessCount: over.accessCount ?? 0,
    state: over.state ?? "active",
    embedding: over.embedding ?? [1, 0, 0],
    ...over,
  };
}

describe("MemorySystem.indexDimension", () => {
  it("returns null when the system has no observations", async () => {
    await withMem(async (mem) => {
      expect(mem.indexDimension()).toBeNull();
    });
  });

  it("returns the embedder dimension after one observation is recorded", async () => {
    await withMem(async (mem) => {
      await mem.recordObservation({
        text: "index dimension smoke observation",
        timestamp: "2026-06-14T00:00:00.000Z",
      });
      expect(mem.indexDimension()).toBe(256);
    });
  });
});

describe("MemorySystem.allObservationsByOrigin", () => {
  it("includes only live observation records with cog: origins", async () => {
    await withMem(async (mem) => {
      const included = await mem.recordObservation({
        text: "included cog observation",
        timestamp: "2026-06-14T00:00:00.000Z",
        origin: "cog:personal/observations.md#included",
      });
      const redacted = await mem.recordObservation({
        text: "redacted cog observation",
        timestamp: "2026-06-14T00:00:01.000Z",
        origin: "cog:personal/observations.md#redacted",
      });
      const nonCog = await mem.recordObservation({
        text: "external observation",
        timestamp: "2026-06-14T00:00:02.000Z",
        origin: "api:external",
      });
      await mem.recordObservation({
        text: "originless observation",
        timestamp: "2026-06-14T00:00:03.000Z",
      });

      mem.episodicRedactMany([redacted.id]);
      const store = (mem as unknown as { episodic: EpisodicStore }).episodic;
      store.upsert(
        rawRecord({
          id: "turn-cog",
          kind: "turn",
          origin: "cog:personal/observations.md#turn",
        }),
      );
      store.upsert(
        rawRecord({
          id: "consolidated-cog",
          kind: "consolidated",
          role: "summary",
          origin: "cog:personal/observations.md#summary",
        }),
      );

      const byOrigin = mem.allObservationsByOrigin();
      expect([...byOrigin.entries()]).toEqual([
        ["cog:personal/observations.md#included", included.id],
      ]);
      expect(byOrigin.has("cog:personal/observations.md#redacted")).toBe(false);
      expect([...byOrigin.values()]).not.toContain(nonCog.id);
    });
  });
});

describe("MemorySystem.episodicRedactMany", () => {
  it("tombstones records and rebuilds derived retrieval indexes", async () => {
    await withMem(async (mem) => {
      const keep = await mem.recordObservation({
        text: "keepable unique retrieval sentinel",
        timestamp: "2026-06-14T00:00:00.000Z",
        origin: "cog:personal/observations.md#keep",
      });
      const doomed = await mem.recordObservation({
        text: "doomed unique retrieval sentinel",
        timestamp: "2026-06-14T00:00:01.000Z",
        origin: "cog:personal/observations.md#doomed",
      });

      const before = await mem.retrieve("doomed unique retrieval sentinel", {
        k: 5,
        dryRun: true,
      });
      expect(before.items.map((i) => i.record.id)).toContain(doomed.id);

      expect(mem.episodicRedactMany([doomed.id])).toBe(1);
      const tombstone = mem.listEpisodic().find((r) => r.id === doomed.id)!;
      expect(tombstone.state).toBe("redacted");
      expect(tombstone.text).toBe("");
      expect(tombstone.salience).toBe(0);

      const after = await mem.retrieve("doomed unique retrieval sentinel", {
        k: 5,
        dryRun: true,
      });
      expect(after.items.map((i) => i.record.id)).not.toContain(doomed.id);
      expect(mem.listEpisodic().map((r) => r.id)).toContain(keep.id);
    });
  });
});
