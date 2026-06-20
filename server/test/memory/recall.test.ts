import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySystem } from "ltm";
import * as memory from "../../src/memory/index.ts";
import { attachLtm, recordObservation } from "../../src/memory/index.ts";
import { recall } from "../../src/memory/recall.ts";

let memRoot = "";
let ltmDir = "";
let ltm: MemorySystem | null = null;

async function setupMemRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ytsejam-recall-"));
  process.env.YTSEJAM_MEMORY_DIR = root;
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "root"], { cwd: root });
  return root;
}

beforeEach(async () => {
  attachLtm(null);
  memRoot = await setupMemRoot();
  ltmDir = await mkdtemp(join(tmpdir(), "ltm-recall-"));
  ltm = MemorySystem.open({ storeDir: ltmDir });
  attachLtm(ltm);
});

afterEach(async () => {
  attachLtm(null);
  if (ltm) {
    ltm.close();
    ltm = null;
  }
  delete process.env.YTSEJAM_MEMORY_DIR;
  if (memRoot) await rm(memRoot, { recursive: true, force: true });
  if (ltmDir) await rm(ltmDir, { recursive: true, force: true });
});

describe("recall", () => {
  // Case 1
  it("alternates cog and ltm hits in strict order when both have results", async () => {
    for (let i = 0; i < 3; i++) {
      await recordObservation({
        domainPath: "cog-meta",
        text: `recall-test alpha ${i}`,
        tags: ["recall-test"],
      });
    }
    for (let i = 0; i < 3; i++) {
      await ltm!.recordObservation({
        origin: `cog:ltm-only/observations.md#fake${i}`,
        text: `recall-test alpha ltmonly ${i}`,
        tags: ["recall-test", "ltm-only"],
        timestamp: new Date().toISOString(),
      });
    }
    const result = await recall("alpha");
    expect(result.hits.length).toBeGreaterThanOrEqual(2);
    expect(result.hits[0].from).toBe("cog");
    if (result.hits.length >= 2) expect(result.hits[1].from).toBe("ltm");
    if (result.hits.length >= 3) expect(result.hits[2].from).toBe("cog");
    if (result.hits.length >= 4) expect(result.hits[3].from).toBe("ltm");
  });

  // Case 2
  it("dedupes the ltm hit when its origin matches a cog hit's path", async () => {
    await recordObservation({
      domainPath: "cog-meta",
      text: "unique-dedupe-marker-2026 something to find",
      tags: ["dedupe-test"],
    });
    const result = await recall("unique-dedupe-marker-2026");
    expect(result.hits.length).toBe(1);
    expect(result.hits[0].from).toBe("cog");
    expect(result.dropped).toBe(1);
  });

  // Case 3
  it("passes the stale flag through from LTM dormant facts", async () => {
    // Direct test of pass-through: stale=true on the LTM retrieve item must
    // surface as stale=true on the recall hit, and stale=false/absent must
    // surface as stale absent on the hit.
    //
    // We mock ltm.retrieve to inject the stale flag deterministically — the
    // real resurrection gate (record.state === "consolidated" path in
    // retriever.ts) is exercised by LTM's own test suite. Here we only need
    // to prove recall() forwards the flag.
    const spy = vi.spyOn(ltm!, "retrieve").mockResolvedValueOnce({
      items: [
        {
          record: {
            id: "obs-stalefake",
            kind: "observation",
            sessionId: "stale-test",
            entryId: "stalefake",
            role: "user",
            text: "stale-marker mocked dormant",
            timestamp: "2025-01-01T00:00:00.000Z",
            salience: 0.1,
            accessCount: 0,
            state: "consolidated",
            origin: "cog:stale-test/observations.md#stalefake",
            tags: ["stale-test"],
          } as any,
          score: 0.5,
          breakdown: { vector: 0, lexical: 0, recency: 0, salience: 0, decay: 1, total: 0.5 } as any,
          stale: true,
        },
      ],
      profile: { facts: [], byPredicate: {}, dormant: [] } as any,
    });
    const result = await recall("stale-marker");
    const ltmHit = result.hits.find((h) => h.from === "ltm");
    expect(ltmHit).toBeDefined();
    expect(ltmHit?.stale).toBe(true);
    spy.mockRestore();
  });

  // Case 3b — companion: stale=false/absent must surface as absent (not stale=false)
  it("OMITS stale on the recall hit when LTM item is not stale (mutant-kill via 'stale' in hit)", async () => {
    const spy = vi.spyOn(ltm!, "retrieve").mockResolvedValueOnce({
      items: [
        {
          record: {
            id: "obs-freshfake",
            kind: "observation",
            sessionId: "fresh-test",
            entryId: "freshfake",
            role: "user",
            text: "fresh-marker mocked active",
            timestamp: new Date().toISOString(),
            salience: 0.85,
            accessCount: 0,
            state: "active",
            origin: "cog:fresh-test/observations.md#freshfake",
            tags: ["fresh-test"],
          } as any,
          score: 0.9,
          breakdown: { vector: 0, lexical: 0, recency: 0, salience: 0, decay: 1, total: 0.9 } as any,
          // stale absent — fresh active item
        },
      ],
      profile: { facts: [], byPredicate: {}, dormant: [] } as any,
    });
    const result = await recall("fresh-marker");
    const ltmHit = result.hits.find((h) => h.from === "ltm");
    expect(ltmHit).toBeDefined();
    // Mutant-kill: 'stale' must NOT be a property of the hit (even undefined or false).
    expect("stale" in (ltmHit as object)).toBe(false);
    spy.mockRestore();
  });

  // Case 4
  it("returns ltm-only hits when cog has no matches", async () => {
    await ltm!.recordObservation({
      origin: "cog:ltm-only/observations.md#abc",
      text: "uniqueltmonlymarker something distinctive",
      tags: ["ltm-only"],
      timestamp: new Date().toISOString(),
    });
    const result = await recall("uniqueltmonlymarker");
    expect(result.cogCount).toBe(0);
    expect(result.hits.length).toBeGreaterThanOrEqual(1);
    expect(result.hits.every((h) => h.from === "ltm")).toBe(true);
  });

  // Case 5
  it("returns cog-only hits when LTM is not attached", async () => {
    attachLtm(null); // detach mid-test
    await recordObservation({
      domainPath: "cog-meta",
      text: "cog-only-marker-9876 looking for this",
      tags: ["cog-only"],
    });
    const result = await recall("cog-only-marker-9876");
    expect(result.ltmCount).toBe(0);
    expect(result.hits.length).toBeGreaterThanOrEqual(1);
    expect(result.hits.every((h) => h.from === "cog")).toBe(true);
  });

  // Case 6
  it("returns empty envelope when both substrates miss", async () => {
    const result = await recall("nonexistent-query-no-match-12345");
    expect(result.hits).toEqual([]);
    expect(result.cogCount).toBe(0);
    expect(result.ltmCount).toBe(0);
    expect(result.dropped).toBe(0);
  });

  // MEM-M3: empty/whitespace query must NOT fan out — cog search("") matches
  // every line of every file, so without the guard recall("") would inject 5
  // arbitrary cog lines into the prompt.
  it("returns an empty envelope for an empty or whitespace query without scanning", async () => {
    // Seed real content that a "" cog search would otherwise match on every line.
    for (let i = 0; i < 4; i++) {
      await recordObservation({
        domainPath: "cog-meta",
        text: `empty-guard filler line ${i}`,
        tags: ["empty-guard"],
      });
    }
    await ltm!.recordObservation({
      origin: "cog:ltm-only/observations.md#eg",
      text: "empty-guard ltm filler",
      tags: ["empty-guard"],
      timestamp: new Date().toISOString(),
    });

    // Spy on cog search to prove the guard short-circuits before fan-out.
    const searchSpy = vi.spyOn(memory, "search");
    for (const q of ["", "   ", "\n\t"]) {
      const result = await recall(q);
      expect(result.hits).toEqual([]);
      expect(result.cogCount).toBe(0);
      expect(result.ltmCount).toBe(0);
      expect(result.dropped).toBe(0);
    }
    expect(searchSpy).not.toHaveBeenCalled();
    searchSpy.mockRestore();
  });

  // Case 7
  it("populates tags on cog hits parsed as observations", async () => {
    await recordObservation({
      domainPath: "cog-meta",
      text: "tag-extract-marker abcdef",
      tags: ["alpha", "beta"],
    });
    const result = await recall("tag-extract-marker");
    const cogHit = result.hits.find((h) => h.from === "cog");
    expect(cogHit).toBeDefined();
    expect(cogHit?.tags).toEqual(["alpha", "beta"]);
  });

  // Case 8
  it("OMITS tags on cog hits that don't parse as observations (mutant-kill via 'tags' in hit)", async () => {
    await memory.append(
      "wiki/projects/recall-test/notes.md",
      "# notes\n\nwiki-page-marker some plain prose without observation shape.\n",
    );
    const result = await recall("wiki-page-marker");
    const cogHit = result.hits.find((h) => h.from === "cog");
    expect(cogHit).toBeDefined();
    // Mutant-kill: 'tags' must NOT be a property of the hit, even undefined.
    expect("tags" in (cogHit as object)).toBe(false);
  });

  // Case 9
  it("swallows substrate errors and returns results from the working substrate", async () => {
    const spy = vi.spyOn(memory, "search").mockRejectedValueOnce(new Error("synthetic search failure"));
    await ltm!.recordObservation({
      origin: "cog:err-test/observations.md#err",
      text: "error-swallow-marker still findable",
      tags: ["err-test"],
      timestamp: new Date().toISOString(),
    });
    const result = await recall("error-swallow-marker");
    expect(result.cogCount).toBe(0);
    expect(result.hits.some((h) => h.from === "ltm")).toBe(true);
    spy.mockRestore();
  });

  // Case 10
  it("over-drops LTM hits from the same cog file (documents the path-prefix trade-off)", async () => {
    await recordObservation({
      domainPath: "cog-meta",
      text: "trade-off-marker first observation",
      tags: ["trade-off"],
    });
    await ltm!.recordObservation({
      origin: "cog:cog-meta/observations.md#differentsha",
      text: "trade-off-marker totally distinct ltm content",
      tags: ["trade-off"],
      timestamp: new Date().toISOString(),
    });
    const result = await recall("trade-off-marker");
    expect(result.dropped).toBeGreaterThanOrEqual(1);
    expect(result.hits.find((h) => h.text.includes("totally distinct"))).toBeUndefined();
  });
});
