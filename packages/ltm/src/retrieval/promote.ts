/**
 * Profile-fact promotion (PLAN.md Task 4.3): a query that touches a
 * semantic-profile predicate surfaces the matching profile facts directly
 * as synthetic memory items, independent of lexical/vector overlap. This is
 * the slot-aware half of paraphrase robustness: "Where am I currently
 * employed?" shares no content words with "I work at Initech", but the
 * works_at slot answers it exactly.
 *
 * The keyword map is generic English (kinship terms, employment terms,
 * residence terms) — deliberately small and high-precision; broad words
 * like "use" are excluded because they'd promote on most queries.
 *
 * Strong-cue recall: when a slot question matches a predicate but no
 * above-floor fact covers it, the dormant section is searched for the
 * strongest matching fact. Dormant facts are rendered stale — carrying the
 * date last mentioned — so callers can phrase them as historical context.
 */

import type { ProfileSummary, PromotedFact, SemanticFact } from "../types.ts";
import { tokenize, cosine, type Embedder } from "../embedding/embedder.ts";
import { factPhrase } from "../semantic/extract.ts";

/** Query keyword → profile predicates it addresses. */
const PREDICATE_KEYWORDS: Record<string, string[]> = {
  name: ["name"],
  called: ["name"],
  employer: ["works_at"],
  employed: ["works_at"],
  employment: ["works_at"],
  work: ["works_at"],
  works: ["works_at"],
  job: ["works_at", "role"],
  company: ["works_at"],
  profession: ["role"],
  occupation: ["role"],
  role: ["role"],
  allergic: ["allergic_to"],
  allergy: ["allergic_to"],
  allergies: ["allergic_to"],
  eat: ["allergic_to"],
  food: ["allergic_to"],
  city: ["lives_in"],
  town: ["lives_in"],
  live: ["lives_in"],
  lives: ["lives_in"],
  living: ["lives_in"],
  based: ["lives_in"],
  hometown: ["lives_in"],
  sibling: ["rel_sister", "rel_brother"],
  siblings: ["rel_sister", "rel_brother"],
  sister: ["rel_sister"],
  brother: ["rel_brother"],
  parent: ["rel_mother", "rel_father"],
  parents: ["rel_mother", "rel_father"],
  mother: ["rel_mother"],
  mom: ["rel_mother"],
  father: ["rel_father"],
  dad: ["rel_father"],
  spouse: ["rel_wife", "rel_husband", "rel_partner"],
  wife: ["rel_wife"],
  husband: ["rel_husband"],
  partner: ["rel_partner"],
  pet: ["rel_dog", "rel_cat"],
  pets: ["rel_dog", "rel_cat"],
  dog: ["rel_dog"],
  canine: ["rel_dog"],
  puppy: ["rel_dog"],
  cat: ["rel_cat"],
  feline: ["rel_cat"],
  kitten: ["rel_cat"],
  project: ["works_on"],
  projects: ["works_on"],
  codebase: ["works_on"],
  hobby: ["works_on"],
};

function renderFact(fact: SemanticFact): string {
  return factPhrase(fact.predicate, fact.object, fact.polarity);
}

/** Stale facts carry their age so consumers phrase them as historical. */
function renderStale(fact: SemanticFact): string {
  return `${renderFact(fact).replace(/\.$/, "")} (last mentioned ${fact.lastSeenAt.slice(0, 10)}).`;
}

const MAX_PROMOTED = 3;

/** A profile fact as a synthetic, retrieval-only item (never persisted). */
function toPromoted(fact: SemanticFact, stale: boolean): PromotedFact {
  return {
    id: `fact/${fact.id}`,
    kind: "fact",
    fact,
    sessionId: fact.sources[0]?.sessionId ?? "profile",
    entryId: fact.sources[0]?.entryId,
    role: "summary",
    text: stale ? renderStale(fact) : renderFact(fact),
    timestamp: fact.lastSeenAt,
    salience: fact.strength,
    accessCount: 0,
    ...(stale ? { stale: true } : {}),
  };
}

/** Cosine floor for semantic fact recall — high-precision so a paraphrase
 *  surfaces a fact but loosely-related chatter does not re-pollute context. */
const VECTOR_FACT_FLOOR = 0.6;
/** Most facts the vector channel may add beyond the keyword/slot matches. */
const MAX_VECTOR_PROMOTED = 2;

/**
 * Semantic fact recall: facts whose embedding is a close match to the query,
 * independent of keyword/slot overlap. Complements promoteFacts() (the
 * keyword-precise path) for paraphrases its small keyword map misses
 * ("which language am I into?" → the `prefers C` fact).
 *
 * Conservative by design: a high cosine floor and a small cap, so this never
 * becomes a noise source. Facts without an embedding, or one off the query's
 * dimension (legacy/un-embedded), are skipped — graceful degrade to keyword
 * recall. `exclude` carries ids already promoted by promoteFacts so the same
 * fact isn't surfaced twice.
 */
export async function vectorPromoteFacts(
  query: string,
  facts: SemanticFact[],
  embedder: Embedder,
  exclude: Set<string>,
): Promise<PromotedFact[]> {
  if (!query.trim()) return [];
  const candidates = facts.filter(
    (f) => f.embedding && f.embedding.length > 0 && !exclude.has(f.id),
  );
  if (candidates.length === 0) return [];

  const qv = await embedder.embed(query);
  const scored: { fact: SemanticFact; score: number }[] = [];
  for (const f of candidates) {
    // Dimension guard (mirrors the episodic D2 rule): never compare across
    // dimensions — an off-dimension fact contributes nothing rather than
    // reaching the now-throwing cosine.
    if (f.embedding!.length !== qv.length) continue;
    const score = cosine(qv, f.embedding!);
    if (score >= VECTOR_FACT_FLOOR) scored.push({ fact: f, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_VECTOR_PROMOTED).map((s) => toPromoted(s.fact, false));
}

/**
 * Profile facts the query addresses, as synthetic retrieval-only items.
 * PromotedFact is NOT an EpisodicRecord: it is re-derived from facts.jsonl
 * on every call and must never reach the episodic store.
 */
export function promoteFacts(query: string, profile: ProfileSummary): PromotedFact[] {
  const predicates = new Set<string>();
  for (const token of tokenize(query)) {
    for (const p of PREDICATE_KEYWORDS[token] ?? []) predicates.add(p);
  }
  if (predicates.size === 0) return [];

  const aboveFloor = [
    ...profile.identity,
    ...profile.attributes,
    ...profile.directives,
    ...profile.preferences,
  ].filter((f) => predicates.has(f.predicate));
  aboveFloor.sort((a, b) => b.strength - a.strength);

  // Strong-cue recall: a slot question reaches past the floor. Only
  // predicates with NO above-floor answer fall back to the dormant section
  // (strongest first — profile.dormant is pre-sorted), one fact each.
  // Generic identity predicates (name/role) join the fallback only when
  // they are the query's SOLE match: "What's my dog called?" matches
  // rel_dog + name, and promoting the stale user-name there displaced real
  // answers (measured: long-band MRR 0.88 → 0.81). "What is my name?"
  // matches name alone and still recalls. Known blind spot, accepted as
  // rare: a compound query naming two generic predicates ("my name and
  // role?") recalls neither from dormancy — above-floor facts still answer.
  const GENERIC_PREDICATES = new Set(["name", "role"]);
  const covered = new Set(aboveFloor.map((f) => f.predicate));
  const dormantPicks: SemanticFact[] = [];
  for (const f of profile.dormant) {
    if (!predicates.has(f.predicate) || covered.has(f.predicate)) continue;
    if (GENERIC_PREDICATES.has(f.predicate) && predicates.size > 1) continue;
    covered.add(f.predicate);
    dormantPicks.push(f);
  }

  return [
    ...aboveFloor.map((f) => toPromoted(f, false)),
    ...dormantPicks.map((f) => toPromoted(f, true)),
  ].slice(0, MAX_PROMOTED);
}
