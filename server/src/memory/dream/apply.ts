// server/src/memory/dream/apply.ts
import type { MemorySystem } from "ltm";
import { factPhrase, normalizeObject, canonicalizePredicate } from "ltm";
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

/**
 * Check whether a matching ACTIVE fact exists in the LTM store.
 * Uses the same canonicalization/normalization as the extractor so
 * predicate synonyms and object whitespace differences don't cause
 * false negatives.
 */
function factExists(ltm: MemorySystem, predicate: string, object: string): boolean {
  const cp = canonicalizePredicate(predicate);
  const no = normalizeObject(object);
  return ltm.listFacts().some(
    (f) => f.state === "active" && !f.supersededBy &&
      canonicalizePredicate(f.predicate) === cp &&
      normalizeObject(f.object) === no,
  );
}

async function applyOne(deps: ApplyDeps, p: Proposal): Promise<boolean> {
  if (p.kind === "drop") {
    return p.factIds[0] ? deps.ltm.redactFact(p.factIds[0]) : false;
  } else if (p.kind === "resolve") {
    // convention: factIds[0] = keep, factIds[1] = drop. Redact the drop, never
    // the keep. Guard against a malformed or LLM-inverted proposal that would
    // otherwise destroy the fact the user wanted to keep:
    //   - both ids must be present and distinct (a single shared id means
    //     "redact drop" would tombstone "keep")
    //   - both must resolve to a live (non-redacted) fact
    const keepId = p.factIds[0];
    const dropId = p.factIds[1];
    if (!keepId || !dropId || keepId === dropId) {
      console.warn(`[dream] resolve skipped: needs two distinct keep/drop fact ids (keep=${keepId ?? "∅"}, drop=${dropId ?? "∅"})`);
      return false;
    }
    const facts = deps.ltm.listFacts();
    const keep = facts.find((f) => f.id === keepId);
    const drop = facts.find((f) => f.id === dropId);
    if (!keep || keep.state === "redacted" || !drop || drop.state === "redacted") {
      console.warn(`[dream] resolve skipped: keep/drop fact missing or already redacted (keep=${keepId}, drop=${dropId})`);
      return false;
    }
    return deps.ltm.redactFact(dropId);
  } else if (p.kind === "add" && p.add) {
    const { predicate, object, polarity } = p.add;
    const isKnownPredicate =
      predicate === "name" ||
      predicate === "role" ||
      predicate === "works_at" ||
      predicate === "works_on" ||
      predicate === "lives_in" ||
      predicate === "allergic_to" ||
      predicate.startsWith("rel_") ||
      predicate === "uses" ||
      predicate === "directive" ||
      predicate === "prefers";

    if (!isKnownPredicate) {
      console.warn(`[dream] add proposal used a non-standard predicate "${predicate}"; the fact may not be re-extracted from the observation phrase`);
    }

    await deps.ltm.recordObservation({
      text: obsPhrase(predicate, object, polarity),
      timestamp: deps.now(),
      origin: "dream:approved",
      learnFacts: true,
    });

    // Verify the fact actually landed — unknown predicates produce an
    // observation phrase that the regex extractor cannot parse, so the
    // round-trip fails and the proposal should stay pending.
    return factExists(deps.ltm, predicate, object);
  } else if (p.kind === "merge") {
    if (!p.canonical) return false;
    const { predicate, object, polarity } = p.canonical;

    // Capture the originals' source turns BEFORE redacting, so the canonical
    // can inherit their provenance (a later source-based redaction then still
    // cascades to the merged fact).
    const carriedSources = p.factIds.flatMap(
      (id) => deps.ltm.listFacts().find((f) => f.id === id)?.sources ?? [],
    );

    // FIRST record the canonical observation and verify it round-trips.
    // Only redact the originals if the canonical fact actually landed —
    // this prevents data loss when the observation phrase is unparseable.
    await deps.ltm.recordObservation({
      text: obsPhrase(predicate, object, polarity),
      timestamp: deps.now(),
      origin: "dream:approved",
      learnFacts: true,
    });

    if (!factExists(deps.ltm, predicate, object)) {
      console.warn(`[dream] merge skipped: canonical fact (${predicate}=${object}) did not round-trip; originals left intact`);
      return false;
    }

    // Canonical landed: carry the originals' provenance onto it, then redact them.
    const canon = deps.ltm.listFacts().find(
      (f) => f.state === "active" && !f.supersededBy &&
        canonicalizePredicate(f.predicate) === canonicalizePredicate(predicate) &&
        normalizeObject(f.object) === normalizeObject(object),
    );
    if (canon && carriedSources.length > 0) deps.ltm.attachFactSources(canon.id, carriedSources);
    // Redact the originals — but NEVER the canonical itself. Fact ids are
    // content-addressed (kind+predicate+normalizedObject+polarity), so a
    // canonical whose normalized object matches one of the merged originals
    // shares that original's id. Redacting it unconditionally would tombstone
    // the very fact we just kept (e.g. merge "ytsejam" + "the ytsejam project"
    // with canonical "ytsejam"), silently destroying the survivor and marking
    // the proposal applied so it never resurfaces. Skip the canonical id.
    for (const id of p.factIds) {
      if (id === canon?.id) continue;
      deps.ltm.redactFact(id);
    }
    return true;
  }

  console.warn(`[dream] applyOne: unknown proposal kind "${(p as Proposal).kind}"`);
  return false;
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
    const ok = await applyOne(deps, p);
    if (ok) {
      deps.store.setStatus(id, "applied");
      applied.push(id);
    } else {
      skipped.push(id);
      // Leave status as "pending" so it resurfaces for review.
    }
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
