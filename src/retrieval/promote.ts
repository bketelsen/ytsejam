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
 */

import type { EpisodicRecord, ProfileSummary, SemanticFact } from "../types.ts";
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

export interface PromotedFact {
  fact: SemanticFact;
  record: EpisodicRecord;
}

const MAX_PROMOTED = 3;

/** Profile facts the query addresses, as synthetic episodic records. */
export function promoteFacts(query: string, profile: ProfileSummary): PromotedFact[] {
  const predicates = new Set<string>();
  for (const token of tokenize(query)) {
    for (const p of PREDICATE_KEYWORDS[token] ?? []) predicates.add(p);
  }
  if (predicates.size === 0) return [];

  const facts = [
    ...profile.identity,
    ...profile.attributes,
    ...profile.directives,
    ...profile.preferences,
  ].filter((f) => predicates.has(f.predicate));

  facts.sort((a, b) => b.strength - a.strength);
  return facts.slice(0, MAX_PROMOTED).map((fact) => ({
    fact,
    record: {
      id: `fact/${fact.id}`,
      kind: "fact",
      sessionId: fact.sources[0]?.sessionId ?? "profile",
      entryId: fact.sources[0]?.entryId,
      role: "summary",
      text: renderFact(fact),
      timestamp: fact.lastSeenAt,
      salience: fact.strength,
      accessCount: 0,
      state: "active",
    },
  }));
}
