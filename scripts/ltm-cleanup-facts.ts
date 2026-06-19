/**
 * One-time live fact-store cleanup (2026-06-19).
 *
 * The LLM/regex extractors minted ~69 "facts" that are mostly task- and
 * observation-residue (e.g. `do_not_mutate_files`, `define subagent checkpoint
 * before merge`, `performed_operation=...`) plus heavy duplicates
 * (`works_on`/`works_on_project`/`works_on_repo`/`uses_tool` = ytsejam six ways;
 * `github_handle`/`github_user`/`github_username` = bketelsen three ways). The
 * always-on profile block injects all of this into every prompt — the "context
 * garbage" behind the quality regression.
 *
 * This rewrites facts.jsonl to a curated, canonical keep-set and backfills
 * embeddings via the real embedder. Everything else is dropped (not tombstoned)
 * — a deliberate one-time curation, same approach as the prior remediation.
 * New facts accrue cleanly going forward (canonicalization + 0.75 floor + the
 * tighter extractor prompt shipped in #275).
 *
 * SAFETY:
 *   - Run with the ytsejam service STOPPED (single JSONL writer).
 *   - The CALLER takes a full ltm-dir backup first; this script ALSO snapshots
 *     facts.jsonl to facts.jsonl.bak.<ts> before writing.
 *   - Dry-run by default: prints the keep/drop decision and exits. Pass
 *     --commit to apply.
 *
 * USAGE (from repo root, service stopped):
 *   LTM_STORE_DIR=$HOME/.ytsejam/data/ltm node scripts/ltm-cleanup-facts.ts
 *   LTM_STORE_DIR=$HOME/.ytsejam/data/ltm node scripts/ltm-cleanup-facts.ts --commit
 */

import fs from "node:fs";
import path from "node:path";
import { canonicalizePredicate, normalizeObject, factId } from "../packages/ltm/src/semantic/extract.ts";
import { MemorySystem } from "../packages/ltm/src/api/memory-system.ts";
import type { SemanticFact } from "../packages/ltm/src/types.ts";
import { PiAuthStore } from "../server/src/pi-auth.ts";
import { createLtmEmbedder } from "../server/src/memory/embedder.ts";

const storeDir = process.env.LTM_STORE_DIR;
if (!storeDir) {
  console.error("set LTM_STORE_DIR (live ltm dir, e.g. $HOME/.ytsejam/data/ltm)");
  process.exit(2);
}
const commit = process.argv.includes("--commit");

/**
 * Curated keep-set: genuine, durable, first-person user facts. Matched against
 * the live ACTIVE facts by (predicate, exact object). Predicates are
 * canonicalized on write; everything not matched here is dropped.
 */
const KEEP: { kind: SemanticFact["kind"]; predicate: string; object: string }[] = [
  { kind: "identity", predicate: "name", object: "Brian" },
  { kind: "identity", predicate: "linux_username", object: "bjk" },
  { kind: "identity", predicate: "github_username", object: "bketelsen" },
  { kind: "preference", predicate: "prefers", object: "my own harness" },
  { kind: "preference", predicate: "prefers", object: "Go for programming tasks" },
  { kind: "attribute", predicate: "uses_operating_system", object: "Snow Linux" },
  { kind: "attribute", predicate: "works_on", object: "ytsejam" },
  { kind: "directive", predicate: "should_exclude_from_context", object: "omnius, hermes, conclave, chapterhouse, openclaw" },
];

function loadFacts(file: string): Map<string, SemanticFact> {
  const out = new Map<string, SemanticFact>();
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t) as SemanticFact;
      if (typeof r.id === "string" && r.id) out.set(r.id, r); // latest-wins
    } catch {
      // tolerate corrupt lines
    }
  }
  return out;
}

const factsPath = path.join(storeDir, "facts.jsonl");
const all = loadFacts(factsPath);
const active = [...all.values()].filter((f) => f.state === "active" && !f.supersededBy);

// Decide keep vs drop. A keep spec matches an active fact by canonical
// predicate + normalized object, so the works_on/works_on_repo variants all
// collapse onto the single works_on=ytsejam keep.
const keptRecords: SemanticFact[] = [];
const matchedKeep = new Set<number>();
const keep: SemanticFact[] = [];
const drop: SemanticFact[] = [];
for (const f of active) {
  const idx = KEEP.findIndex(
    (k, i) =>
      !matchedKeep.has(i) &&
      k.kind === f.kind &&
      canonicalizePredicate(k.predicate) === canonicalizePredicate(f.predicate) &&
      normalizeObject(k.object) === normalizeObject(f.object),
  );
  if (idx >= 0) {
    matchedKeep.add(idx);
    keep.push(f);
    // Canonicalize the kept record: collapse the predicate, drop projectTag so
    // identity/global facts are unscoped, recompute the id.
    const predicate = canonicalizePredicate(f.predicate);
    const rec: SemanticFact = {
      ...f,
      predicate,
      projectTag: undefined, // JSON.stringify omits undefined → unscoped/global
      id: factId({ kind: f.kind, predicate, polarity: f.polarity }, f.objectNorm),
      embedding: undefined, // re-embedded by backfill below
    };
    keptRecords.push(rec);
  } else {
    drop.push(f);
  }
}

console.log(`Active facts: ${active.length}  |  keep: ${keep.length}  |  drop: ${drop.length}`);
console.log("\n── KEEP ──");
for (const r of keptRecords) console.log(`  + ${r.kind}/${r.predicate} = ${JSON.stringify(r.object)}`);
const unmatched = KEEP.filter((_, i) => !matchedKeep.has(i));
if (unmatched.length) {
  console.log("\n⚠ keep specs with NO matching live fact (not fabricated):");
  for (const u of unmatched) console.log(`  ? ${u.predicate} = ${JSON.stringify(u.object)}`);
}
console.log("\n── DROP ──");
for (const r of drop.sort((a, b) => a.predicate.localeCompare(b.predicate)))
  console.log(`  - ${r.kind}/${r.predicate} = ${JSON.stringify(r.object)}`);

if (!commit) {
  console.log("\nDRY RUN — no changes written. Re-run with --commit to apply.");
  process.exit(0);
}

// Snapshot facts.jsonl, then rewrite to the keep-set only.
const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
const bak = `${factsPath}.bak.${ts}`;
fs.copyFileSync(factsPath, bak);
fs.writeFileSync(factsPath, keptRecords.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`\nWrote ${keptRecords.length} facts to ${factsPath} (backup: ${bak})`);

// Backfill embeddings with the real embedder. The keep-set is already written,
// so a backfill failure (embedder unreachable) is non-fatal — the store is
// clean and keyword/slot recall still works; embeddings accrue on next assert.
try {
  const authStore = new PiAuthStore(`${process.env.HOME}/.pi/agent/auth.json`);
  const mode = (process.env.YTSEJAM_LTM_EMBEDDER as "copilot" | "auto") ?? "copilot";
  const embedderResult = await createLtmEmbedder(authStore, {
    mode,
    cacheDir: path.join(storeDir, "embed-cache"),
    copilot: { model: process.env.YTSEJAM_LTM_COPILOT_MODEL, baseUrl: process.env.YTSEJAM_LTM_COPILOT_URL },
  });
  const mem = MemorySystem.open({ storeDir, embedder: embedderResult.embedder });
  try {
    const res = await mem.backfillFactEmbeddings();
    console.log(`Embedding backfill (${embedderResult.label}): embedded=${res.embedded} skipped=${res.skipped}`);
  } finally {
    mem.close();
  }
} catch (err) {
  console.warn(`⚠ embedding backfill skipped (${(err as Error).message}). Store is clean; embeddings will accrue on next assert.`);
}
console.log("Done. Restart ytsejam.service to load the cleaned store.");
