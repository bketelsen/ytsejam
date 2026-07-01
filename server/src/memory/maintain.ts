import fs from "node:fs";
import path from "node:path";
import type { MemorySystem } from "ltm";

/**
 * Deterministic, reversible LTM maintenance — the "mechanical pass".
 *
 * This is the housekeeping that keeps the fact/episodic stores tidy without
 * ever consulting an LLM: it normalises predicate casing + folds synonym
 * predicates, consolidates decayed episodic memories into summaries, runs a
 * full reconcile (rebuild + prune orphan cog-origin observations), and
 * backfills any missing fact embeddings.
 *
 * It is invoked on demand by the `ltm maintain` CLI subcommand (see
 * `cli/ltm-commands.ts`). It is NOT scheduled — there is no autonomous nightly
 * run and no LLM in this path.
 *
 * facts.jsonl is snapshotted to a timestamped `.bak.*` before any mutation, so
 * every change here is trivially reversible with `cp`.
 */

export interface MaintainDeps {
  ltm: MemorySystem;
  /** Full reconcile tick. Callers pass a reconciler-backed implementation. */
  reconcile: (o: {
    force?: boolean;
    rebuild?: boolean;
    prune?: boolean;
  }) => Promise<{ pruned: number }>;
  /** LTM store dir (holds facts.jsonl). */
  storeDir: string;
  /** ISO clock; injectable for tests. Defaults to the wall clock. */
  now?: () => string;
}

export interface MaintainSummary {
  /** Path to the facts.jsonl snapshot written before mutating. */
  backup: string;
  canonicalized: number;
  merged: number;
  folded: number;
  pruned: number;
  embedded: number;
}

/** Run the deterministic maintenance pass. Backs up facts.jsonl first. */
export async function runMaintenance(deps: MaintainDeps): Promise<MaintainSummary> {
  const now = deps.now ?? (() => new Date().toISOString());
  const factsPath = path.join(deps.storeDir, "facts.jsonl");
  // YYYYMMDDHHmmss from the ISO clock (digits only — no trailing separator).
  const ts = now().replace(/\D/g, "").slice(0, 14);
  const backup = `${factsPath}.bak.${ts}`;
  if (fs.existsSync(factsPath)) fs.copyFileSync(factsPath, backup);

  const { canonicalized, merged } = deps.ltm.canonicalizeFacts();
  const consolidated = await deps.ltm.consolidate();
  const { pruned } = await deps.reconcile({ force: true, rebuild: true, prune: true });
  const { embedded } = await deps.ltm.backfillFactEmbeddings();

  return { backup, canonicalized, merged, folded: consolidated.folded, pruned, embedded };
}
