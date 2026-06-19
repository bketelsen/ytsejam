/**
 * Restore the D3-wiped fact set from a store backup — VERBATIM, not re-derived.
 *
 * WHY THIS, NOT A TEXT-REBUILD:
 *   The earlier plan was to re-derive facts from the episodic text ($0, no
 *   embedder). Measurement killed it: chunkText hard-splits sentences >1500
 *   chars mid-word and drops the inter-chunk separator, so reconstruction is
 *   LOSSY for ~50% of multi-chunk turns (d-ltm-rebuild-lossy-FINDING). A store
 *   backup taken before the wipe holds the original ACTIVE records exactly, so
 *   restoring from it is byte-exact and trivially cheap. This script does that.
 *
 * WHAT IT RESTORES (conservative by construction):
 *   Only records that are `active` in the BACKUP and currently `redacted` or
 *   ABSENT in the LIVE store. A fact the live store legitimately changed since
 *   the backup (e.g. you re-stated a preference, superseding it) is NOT touched
 *   — restoring is scoped to the wipe damage, never a blanket overwrite.
 *   SemanticStore.restoreFacts appends the chosen records; latest-wins load
 *   resolves them live. Surviving active facts (ids absent from the restore
 *   set) are untouched.
 *
 * SAFETY:
 *   - Run with the ytsejam service STOPPED (single JSONL writer / no torn reads).
 *   - The CALLER takes a fresh full backup of the ltm dir first; this script
 *     does NOT back up. (The --backup-store it reads is your PRE-WIPE backup.)
 *   - Idempotent: re-running restores the same records to the same state.
 *
 * USAGE (from repo root, service stopped):
 *   LTM_STORE_DIR=$HOME/.ytsejam/data/ltm \
 *   LTM_BACKUP_DIR=$HOME/.ytsejam/data/ltm.bak.<ts> \
 *     node scripts/ltm-restore-facts.ts --dry-run
 *   ...then without --dry-run to apply.
 */

import fs from "node:fs";
import path from "node:path";
import { SemanticStore } from "../packages/ltm/src/semantic/store.ts";
import type { SemanticFact } from "../packages/ltm/src/types.ts";

const storeDir = process.env.LTM_STORE_DIR;
const backupDir = process.env.LTM_BACKUP_DIR;
if (!storeDir || !backupDir) {
  console.error("set LTM_STORE_DIR (live ltm dir) and LTM_BACKUP_DIR (pre-wipe backup ltm dir)");
  process.exit(2);
}
const dryRun = process.argv.includes("--dry-run");

function readFacts(file: string): Map<string, SemanticFact> {
  const out = new Map<string, SemanticFact>();
  if (!fs.existsSync(file)) return out;
  // facts.jsonl is small (KB); a plain line read is fine here.
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t) as SemanticFact;
      if (typeof r.id === "string" && r.id) out.set(r.id, r); // latest-wins per id
    } catch {
      // tolerate corrupt lines
    }
  }
  return out;
}

const live = readFacts(path.join(storeDir, "facts.jsonl"));
const backup = readFacts(path.join(backupDir, "facts.jsonl"));

// Select: active-in-backup AND (redacted-or-absent in live). This is exactly
// the wipe-damage set — never a fact the live store legitimately changed.
const toRestore: SemanticFact[] = [];
const skippedLiveChanged: string[] = [];
for (const [id, b] of backup) {
  if (b.state !== "active") continue;
  const l = live.get(id);
  if (!l || l.state === "redacted") {
    toRestore.push(b);
  } else if (l.state === "active") {
    // already active in live — nothing to do (not damage)
  } else {
    // live has some other non-redacted, non-active state (e.g. superseded):
    // a legitimate post-backup change. Do NOT clobber; report it.
    skippedLiveChanged.push(id);
  }
}

if (dryRun) {
  console.log(
    JSON.stringify(
      {
        mode: "dry-run",
        storeDir,
        backupDir,
        liveFacts: live.size,
        backupFacts: backup.size,
        wouldRestore: toRestore.length,
        restoreIds: toRestore.map((f) => f.id),
        skippedLiveChanged,
        note: "no writes performed; run without --dry-run to restore + compact",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const store = SemanticStore.open(storeDir);
const beforeActive = store.activeFacts().length;
const result = store.restoreFacts(toRestore);
const compacted = store.compactLogs();
const afterActive = store.activeFacts().length;

console.log(
  JSON.stringify(
    {
      mode: "restore",
      storeDir,
      backupDir,
      restored: result.restored,
      skipped: result.skipped,
      skippedLiveChanged,
      activeFacts: { before: beforeActive, after: afterActive },
      compacted,
    },
    null,
    2,
  ),
);
