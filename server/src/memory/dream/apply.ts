// server/src/memory/dream/apply.ts
import type { MemorySystem } from "ltm";
import { factPhrase } from "ltm";
import type { ProposalStore } from "./proposal-store.ts";
import type { Proposal } from "./types.ts";

export interface ApplyDeps { ltm: MemorySystem; store: ProposalStore; now: () => string; }

// Re-export so callers can use it without re-importing from ltm.
export { factPhrase };

/**
 * Build the first-person observation text for an approved add/merge proposal.
 *
 * The regex fact-extractor (used in tests and offline) only matches first-person
 * sentences ("I like …", "I work at …"). `factPhrase` produces third-person
 * "The user …" text intended for the LLM-backed extractor. We use first-person
 * phrasing here so the round-trip works with both extractors.
 */
function obsPhrase(predicate: string, object: string, polarity: 1 | -1): string {
  if (predicate === "name") return `My name is ${object}.`;
  if (predicate === "role") return `I am a ${object}.`;
  if (predicate === "works_at") return `I work at ${object}.`;
  if (predicate === "works_on") return `I am working on ${object}.`;
  if (predicate === "lives_in") return `I live in ${object}.`;
  if (predicate === "allergic_to") return `I am allergic to ${object}.`;
  if (predicate.startsWith("rel_")) return `My ${predicate.slice(4)} is named ${object}.`;
  if (predicate === "uses") return `I use ${object}.`;
  if (predicate === "directive") return `${polarity > 0 ? "Please always" : "Please never"} ${object}.`;
  if (predicate === "prefers") return polarity > 0 ? `I like ${object}.` : `I dislike ${object}.`;
  return `My ${predicate}: ${object}.`;
}

async function applyOne(deps: ApplyDeps, p: Proposal): Promise<void> {
  if (p.kind === "drop") {
    if (p.factIds[0]) deps.ltm.redactFact(p.factIds[0]);
  } else if (p.kind === "resolve") {
    // convention: factIds[0] = keep, factIds[1] = drop
    if (p.factIds[1]) deps.ltm.redactFact(p.factIds[1]);
  } else if (p.kind === "merge") {
    for (const id of p.factIds) deps.ltm.redactFact(id);
    if (p.canonical) {
      await deps.ltm.recordObservation({
        text: obsPhrase(p.canonical.predicate, p.canonical.object, p.canonical.polarity),
        timestamp: deps.now(),
        origin: "dream:approved",
        learnFacts: true,
      });
    }
  } else if (p.kind === "add" && p.add) {
    await deps.ltm.recordObservation({
      text: obsPhrase(p.add.predicate, p.add.object, p.add.polarity),
      timestamp: deps.now(),
      origin: "dream:approved",
      learnFacts: true,
    });
  }
}

export async function applyProposals(
  deps: ApplyDeps,
  ids: string[],
): Promise<{ applied: string[]; skipped: string[] }> {
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const id of ids) {
    const p = deps.store.get(id);
    if (!p || p.status !== "pending") { skipped.push(id); continue; }
    await applyOne(deps, p);
    deps.store.setStatus(id, "applied");
    applied.push(id);
  }
  return { applied, skipped };
}

export function dismissProposals(deps: ApplyDeps, ids: string[]): { dismissed: string[] } {
  const dismissed: string[] = [];
  for (const id of ids) {
    const p = deps.store.get(id);
    if (!p || p.status !== "pending") continue;
    deps.store.setStatus(id, "dismissed");
    dismissed.push(id);
  }
  return { dismissed };
}
