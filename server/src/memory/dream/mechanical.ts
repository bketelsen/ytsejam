import fs from "node:fs"; import path from "node:path";
import type { MemorySystem } from "ltm";
import type { MechanicalSummary } from "./types.ts";

export interface MechanicalDeps {
  ltm: MemorySystem;
  reconcile: (o: { force?: boolean; rebuild?: boolean; prune?: boolean }) => Promise<{ pruned: number }>;
  storeDir: string;
  now: () => string;
}

/** Deterministic, reversible maintenance. Backs up facts.jsonl first. */
export async function runMechanicalPass(deps: MechanicalDeps): Promise<MechanicalSummary> {
  const factsPath = path.join(deps.storeDir, "facts.jsonl");
  // YYYYMMDDHHmmss from the ISO clock (digits only — no trailing separator).
  const ts = deps.now().replace(/\D/g, "").slice(0, 14);
  const backup = `${factsPath}.bak.${ts}`;
  if (fs.existsSync(factsPath)) fs.copyFileSync(factsPath, backup);

  const { canonicalized, merged } = deps.ltm.canonicalizeFacts();
  const consolidated = await deps.ltm.consolidate();
  const { pruned } = await deps.reconcile({ force: true, rebuild: true, prune: true });
  const { embedded } = await deps.ltm.backfillFactEmbeddings();

  return { backup, canonicalized, merged, folded: consolidated.folded, pruned, embedded };
}
