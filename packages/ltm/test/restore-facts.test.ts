import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SemanticStore } from "../src/semantic/store.ts";
import { factId, normalizeObject } from "../src/semantic/extract.ts";
import type { SemanticFact } from "../src/types.ts";

/**
 * Restore-from-backup repair for the D3 facts-wipe (commit 075fc1c).
 *
 * The purge bug redacted the active fact set and stripped each fact's sources.
 * A store backup taken before the wipe holds the original ACTIVE records. The
 * repair is a verbatim restore — append the backup records so the log's
 * latest-wins load resolves them as live — NOT a re-derivation (which is lossy
 * for ~50% of multi-chunk turns; see d-ltm-rebuild-lossy-FINDING). These tests
 * drive SemanticStore.restoreFacts against the real damaged shape: redacted +
 * sources-stripped, alongside a surviving fact that must NOT be touched.
 */

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ltm-restore-"));
}

function makeFact(over: Partial<SemanticFact> & { object: string; predicate: string }): SemanticFact {
  const kind = over.kind ?? "preference";
  const id = over.id ?? factId({ kind, predicate: over.predicate, polarity: over.polarity ?? 1 }, normalizeObject(over.object));
  return {
    id,
    kind,
    predicate: over.predicate,
    object: over.object,
    objectNorm: normalizeObject(over.object),
    polarity: over.polarity ?? 1,
    strength: over.strength ?? 0.6,
    mentionCount: over.mentionCount ?? 1,
    firstSeenAt: over.firstSeenAt ?? "2026-01-01T00:00:00.000Z",
    lastSeenAt: over.lastSeenAt ?? "2026-01-01T00:00:00.000Z",
    sources: over.sources ?? [{ sessionId: "s-1", entryId: "e-1" }],
    state: over.state ?? "active",
  };
}

function writeFacts(storeDir: string, facts: SemanticFact[]): void {
  fs.writeFileSync(
    path.join(storeDir, "facts.jsonl"),
    facts.map((f) => JSON.stringify(f)).join("\n") + "\n",
  );
}

describe("SemanticStore.restoreFacts", () => {
  it("revives a wiped fact to active with its original sources, leaving survivors untouched, and the revival persists across reopen", () => {
    const dir = tmp();

    // The wiped fact: redacted, sources stripped (exactly how D3 left it).
    const wiped = makeFact({ predicate: "prefers", object: "dark mode" });
    const liveWiped: SemanticFact = { ...wiped, state: "redacted", sources: [] };
    // A surviving active fact whose id is NOT in the backup — must be untouched.
    const survivor = makeFact({ predicate: "prefers", object: "typescript", strength: 0.9 });

    writeFacts(dir, [liveWiped, survivor]);

    // Pre-restore: the wiped fact is redacted with no sources; only the survivor is active.
    let store = SemanticStore.open(dir);
    expect(store.activeFacts().map((f) => f.id).sort()).toEqual([survivor.id]);
    expect(store.allFacts().find((f) => f.id === wiped.id)?.state).toBe("redacted");

    // The backup record: the pre-damage ACTIVE version, with its original sources.
    const backupRecord = makeFact({
      predicate: "prefers",
      object: "dark mode",
      state: "active",
      sources: [{ sessionId: "orig-session", entryId: "orig-entry" }],
      strength: 0.7,
    });
    const result = store.restoreFacts([backupRecord]);
    expect(result).toEqual({ restored: 1, skipped: 0 });
    store.compactLogs();

    // In-memory: wiped fact is active again with the backup's sources; survivor unchanged.
    const revived = store.allFacts().find((f) => f.id === wiped.id);
    expect(revived?.state).toBe("active");
    expect(revived?.sources).toEqual([{ sessionId: "orig-session", entryId: "orig-entry" }]);
    expect(revived?.strength).toBe(0.7);
    expect(store.allFacts().find((f) => f.id === survivor.id)).toEqual(survivor);

    // Persisted: reopen from disk proves it went through the append-only log, not just memory.
    store = SemanticStore.open(dir);
    expect(store.activeFacts().map((f) => f.id).sort()).toEqual([survivor.id, wiped.id].sort());
    const reloaded = store.allFacts().find((f) => f.id === wiped.id);
    expect(reloaded?.state).toBe("active");
    expect(reloaded?.sources).toEqual([{ sessionId: "orig-session", entryId: "orig-entry" }]);
  });

  it("skips records without a valid id rather than corrupting the log, and counts them", () => {
    const dir = tmp();
    writeFacts(dir, [makeFact({ predicate: "prefers", object: "keep me" })]);
    const store = SemanticStore.open(dir);
    const before = store.allFacts().length;

    const good = makeFact({ predicate: "prefers", object: "good record", state: "active" });
    const bad = { ...makeFact({ predicate: "prefers", object: "bad" }), id: "" } as SemanticFact;
    const result = store.restoreFacts([good, bad]);

    expect(result).toEqual({ restored: 1, skipped: 1 });
    expect(store.allFacts().length).toBe(before + 1); // only the good one added
    expect(store.allFacts().some((f) => f.id === good.id)).toBe(true);
  });
});
