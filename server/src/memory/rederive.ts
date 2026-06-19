// server/src/memory/rederive.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EpisodicStore, SemanticStore, type FactExtractor } from "ltm";

/** Facts we expect a correct extraction to reproduce; absence aborts the wipe. */
export const KNOWN_GOOD: { label: string; predicate: string; match: (object: string) => boolean }[] = [
  { label: "name=Brian", predicate: "name", match: (o) => o.toLowerCase().includes("brian") },
  { label: "prefers own harness", predicate: "prefers", match: (o) => o.toLowerCase().includes("harness") },
];

export interface FreshFactView { kind: string; predicate: string; object: string; polarity: number; }

export interface BuildFreshFactsOptions {
  storeDir: string;
  extractor: FactExtractor;
  /** Optional: write the fresh facts.jsonl into this dir (defaults to a temp dir; caller copies on commit). */
  outDir?: string;
}

export interface BuildFreshFactsResult {
  facts: FreshFactView[];
  knownGood: { ok: boolean; missing: string[] };
  /** Path to the freshly-written facts.jsonl (in outDir) — caller copies over live on a real run. */
  freshFactsPath: string;
}

export async function buildFreshFacts(opts: BuildFreshFactsOptions): Promise<BuildFreshFactsResult> {
  const episodic = EpisodicStore.open(opts.storeDir);
  const outDir = opts.outDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ltm-fresh-facts-"));
  const fresh = SemanticStore.open(outDir, opts.extractor); // empty facts.jsonl in outDir

  for (const rec of episodic.all()) {
    if (rec.state !== "active" || rec.role !== "user" || !rec.text) continue;
    await fresh.ingestTurn({
      sessionId: rec.sessionId,
      entryId: rec.entryId ?? rec.id,
      role: "user",
      text: rec.text,
      timestamp: rec.timestamp,
    });
  }

  const all = fresh.allFacts().filter((f) => f.state === "active");
  const facts: FreshFactView[] = all.map((f) => ({ kind: f.kind, predicate: f.predicate, object: f.object, polarity: f.polarity }));
  const missing = KNOWN_GOOD.filter((g) => !all.some((f) => f.predicate === g.predicate && g.match(f.object))).map((g) => g.label);

  return {
    facts,
    knownGood: { ok: missing.length === 0, missing },
    freshFactsPath: path.join(outDir, "facts.jsonl"),
  };
}
