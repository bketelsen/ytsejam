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
import { tokenize } from "../embedding/embedder.ts";

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
  const p = fact.predicate;
  if (p === "name") return `The user's name is ${fact.object}.`;
  if (p === "role") return `The user is a ${fact.object}.`;
  if (p === "works_at") return `The user works at ${fact.object}.`;
  if (p === "works_on") return `The user is working on ${fact.object}.`;
  if (p === "lives_in") return `The user lives in ${fact.object}.`;
  if (p === "allergic_to") return `The user is allergic to ${fact.object}.`;
  if (p.startsWith("rel_")) return `The user's ${p.slice(4)} is named ${fact.object}.`;
  if (p === "uses") return `The user uses ${fact.object}.`;
  if (p === "directive") return `${fact.polarity > 0 ? "Always" : "Never"} ${fact.object}.`;
  if (p === "prefers") return `The user ${fact.polarity > 0 ? "likes" : "dislikes"} ${fact.object}.`;
  return `The user's ${p}: ${fact.object}.`;
}

/** Stale facts carry their age so consumers phrase them as historical. */
function renderStale(fact: SemanticFact): string {
  return `${renderFact(fact).replace(/\.$/, "")} (last mentioned ${fact.lastSeenAt.slice(0, 10)}).`;
}

const MAX_PROMOTED = 3;

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

  const toPromoted = (fact: SemanticFact, stale: boolean): PromotedFact => ({
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
  });

  return [
    ...aboveFloor.map((f) => toPromoted(f, false)),
    ...dormantPicks.map((f) => toPromoted(f, true)),
  ].slice(0, MAX_PROMOTED);
}
