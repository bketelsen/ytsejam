import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemorySystem } from "../src/api/memory-system.ts";
import { HashEmbedder } from "../src/embedding/embedder.ts";
import { factId, normalizeObject } from "../src/semantic/extract.ts";
import type { SemanticFact } from "../src/types.ts";

/**
 * Regression for the D3 facts-wipe (commit 075fc1c). The original purge:
 *   1. scanned <sessions-dir> NON-recursively, but ytsejam stores sessions in
 *      per-kind subdirs (--chat--/, --subagent--/) — so 0 files were found;
 *   2. matched source entryId by strict equality, but stored refs are an
 *      8-char prefix of the full turn id — so even found turns never matched;
 *   3. treated "couldn't read the source" as "extractor no longer produces
 *      this" and tombstoned the fact.
 * Result: every active fact was redacted. These tests drive the real
 * MemorySystem.purgeStaleFacts wrapper against the REAL on-disk shape.
 */

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ltm-purge-real-"));
}

// Minimal valid pi-v3 session file: header line + one user message entry.
// Shape mirrors the reader (session/reader.ts): a "message" entry nests
// role+content under `message`; a user message's content may be a string.
function writeSession(
  file: string,
  sessionId: string,
  entryId: string,
  text: string,
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = { type: "session", version: 3, id: sessionId };
  const entry = {
    type: "message",
    id: entryId,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: text },
  };
  fs.writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`);
}

function openMem(storeDir: string): MemorySystem {
  return MemorySystem.open({ storeDir, embedder: new HashEmbedder(64) });
}

describe("purgeStaleFacts — real store shape (D3 regression)", () => {
  it("KEEPS a fact whose source lives in a subdir and carries a truncated entryId", async () => {
    const root = tmp();
    const storeDir = path.join(root, "ltm");
    const sessionsDir = path.join(root, "sessions");

    const fullEntryId = "019eccc1-8343-7329-8129-10a6395aba9a";
    const truncatedRef = fullEntryId.slice(0, 8); // "019eccc1" — what the store recorded
    const sessionId = "019ecc9e-8343-7329-8129-10a6395aba9a";
    const text = "I prefer dark mode";

    // Session lives UNDER a per-kind subdir, never at the top level.
    writeSession(
      path.join(sessionsDir, "--chat--", `${sessionId}.jsonl`),
      sessionId,
      fullEntryId,
      text,
    );
    // Sanity: nothing at top level, exactly the layout that broke the old scan.
    expect(fs.readdirSync(sessionsDir).filter((n) => n.endsWith(".jsonl"))).toEqual([]);

    // Seed an active fact that DOES reproduce from that turn's text, but whose
    // recorded source uses the truncated entryId.
    fs.mkdirSync(storeDir, { recursive: true });
    const id = factId(
      { kind: "preference", predicate: "prefers", polarity: 1 },
      normalizeObject("dark mode"),
    );
    const fact: SemanticFact = {
      id,
      kind: "preference",
      predicate: "prefers",
      object: "dark mode",
      objectNorm: normalizeObject("dark mode"),
      polarity: 1,
      strength: 0.6,
      mentionCount: 1,
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      sources: [{ sessionId, entryId: truncatedRef }],
      state: "active",
    };
    fs.writeFileSync(path.join(storeDir, "facts.jsonl"), `${JSON.stringify(fact)}\n`);

    const mem = openMem(storeDir);
    try {
      const result = await mem.purgeStaleFacts(sessionsDir);
      // The fact must survive: its source was found (recursive scan) and
      // matched (prefix) and reproduced (extractor still emits it).
      expect(result.aborted).toBeUndefined();
      expect(result.purged).toEqual([]);
      expect(result.kept).toBe(1);
      expect(mem.listFacts().find((f) => f.id === id)?.state).toBe("active");
    } finally {
      mem.close();
    }
  });

  it("ABORTS without mutating when the sessions dir is wrong (no readable sources)", async () => {
    const root = tmp();
    const storeDir = path.join(root, "ltm");
    fs.mkdirSync(storeDir, { recursive: true });

    // Five active facts, all with sources that point at a sessions tree that
    // does not exist — the exact systemic-failure shape that wiped the store.
    const ids: string[] = [];
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = factId(
        { kind: "preference", predicate: "prefers", polarity: 1 },
        normalizeObject(`thing ${i}`),
      );
      ids.push(id);
      const fact: SemanticFact = {
        id,
        kind: "preference",
        predicate: "prefers",
        object: `thing ${i}`,
        objectNorm: normalizeObject(`thing ${i}`),
        polarity: 1,
        strength: 0.6,
        mentionCount: 1,
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        sources: [{ sessionId: "gone", entryId: "00000000" }],
        state: "active",
      };
      lines.push(JSON.stringify(fact));
    }
    fs.writeFileSync(path.join(storeDir, "facts.jsonl"), `${lines.join("\n")}\n`);

    const mem = openMem(storeDir);
    try {
      // Point at an empty/nonexistent sessions dir.
      const result = await mem.purgeStaleFacts(path.join(root, "does-not-exist"));
      // Fail-safe keeps every fact (no readable source), so 0 would be purged
      // and the fraction guard never even trips — nothing changes either way.
      expect(result.purged).toEqual([]);
      for (const id of ids) {
        expect(mem.listFacts().find((f) => f.id === id)?.state).toBe("active");
      }
    } finally {
      mem.close();
    }
  });
});
