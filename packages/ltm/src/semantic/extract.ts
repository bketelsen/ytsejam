/**
 * Preference-learning heuristics.
 *
 * Deliberately lexical and deterministic: regex patterns over user turns
 * yield candidate facts; the semantic store handles reinforcement, decay,
 * and contradiction. An LLM extractor can be layered on later behind the
 * same FactCandidate shape.
 */

import type { FactKind } from "../types.ts";

export interface FactCandidate {
  kind: FactKind;
  predicate: string;
  object: string;
  polarity: 1 | -1;
  /** Initial belief for a first sighting; reinforcement raises it. */
  initialStrength: number;
  /** Scope of this fact; absent/undefined is treated as "global". */
  scope?: "global" | "project";
}

// ---------------------------------------------------------------------------
// Normalization

export function normalizeObject(s: string): string {
  return s
    .toLowerCase()
    .replace(/^(?:to|the|a|an|using|working with|writing|my)\s+/g, "")
    .replace(/[.,!?;:]+$/g, "")
    // Trailing adverbs don't change what the preference is about — and they
    // must not defeat contradiction matching ("...tabs" vs "...tabs now").
    .replace(
      /\s+(?:now|these days|anymore|any more|again|lately|though|to be honest|honestly|after all|anyway|instead|for me|tbh)$/g,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

export function slug(s: string): string {
  return s.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

/**
 * Collapse predicate synonyms to one canonical slot so the same fact stated
 * different ways shares a single id. The LLM extractor in particular mints
 * `works_on` / `works_on_project` / `works_on_repo` as three separate facts;
 * canonicalizing here makes them reinforce one fact instead of cluttering the
 * profile. Idempotent — a predicate already canonical maps to itself.
 */
const PREDICATE_CANONICAL: Record<string, string> = {
  works_on_project: "works_on",
  works_on_repo: "works_on",
  works_on_repository: "works_on",
  working_on: "works_on",
  works_at_company: "works_at",
  works_for: "works_at",
  employed_at: "works_at",
  employer: "works_at",
  occupation: "role",
  profession: "role",
  job: "role",
  job_title: "role",
  full_name: "name",
};

export function canonicalizePredicate(predicate: string): string {
  const key = predicate.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return PREDICATE_CANONICAL[key] ?? key;
}

export function factId(
  c: Pick<FactCandidate, "kind" | "predicate" | "polarity">,
  objectNorm: string,
  projectTag?: string,
): string {
  const predicate = canonicalizePredicate(c.predicate);
  const base = `fact-${c.kind}-${predicate}-${slug(objectNorm)}-${c.polarity > 0 ? "p" : "n"}`;
  return projectTag ? `${base}@${slug(projectTag)}` : base;
}

function clean(s: string): string {
  return s.replace(/[.,!?;:]+$/g, "").replace(/\s+/g, " ").trim();
}

/**
 * The natural-language phrase for a fact, derived from its raw fields (not a
 * stored SemanticFact) so the write path can embed the exact text retrieval
 * renders and matches against. retrieval/promote.ts:renderFact delegates here.
 */
export function factPhrase(predicate: string, object: string, polarity: 1 | -1): string {
  const p = predicate;
  if (p === "name") return `The user's name is ${object}.`;
  if (p === "role") return `The user is a ${object}.`;
  if (p === "works_at") return `The user works at ${object}.`;
  if (p === "works_on") return `The user is working on ${object}.`;
  if (p === "lives_in") return `The user lives in ${object}.`;
  if (p === "allergic_to") return `The user is allergic to ${object}.`;
  if (p.startsWith("rel_")) return `The user's ${p.slice(4)} is named ${object}.`;
  if (p === "uses") return `The user uses ${object}.`;
  if (p === "directive") return `${polarity > 0 ? "Always" : "Never"} ${object}.`;
  if (p === "prefers") return `The user ${polarity > 0 ? "likes" : "dislikes"} ${object}.`;
  return `The user's ${p}: ${object}.`;
}

// ---------------------------------------------------------------------------
// Preference / identity / directive extraction (user turns only)

interface PatternSpec {
  re: RegExp;
  make: (m: RegExpMatchArray) => FactCandidate | undefined;
}

const OBJ = "([^,.!?;\\n]+)";
const NAME = "([A-Z][\\w'-]*(?:\\s+[A-Z][\\w'-]*)?)";

const PATTERNS: PatternSpec[] = [
  // Identity. Lead-ins are case-tolerant by spelling out [Mm] etc. — the
  // NAME capture itself must stay case-sensitive (names are capitalized),
  // so a blanket "i" flag would be wrong here.
  {
    re: new RegExp(`\\b[Mm]y name is ${NAME}`, "g"),
    make: (m) => ({ kind: "identity", predicate: "name", object: clean(m[1]), polarity: 1, initialStrength: 0.9 }),
  },
  {
    re: new RegExp(`\\b(?:[Pp]lease )?[Cc]all me ${NAME}`, "g"),
    make: (m) => ({ kind: "identity", predicate: "name", object: clean(m[1]), polarity: 1, initialStrength: 0.9 }),
  },
  {
    re: /\bi(?:'m| am) (?:a|an) ([a-z][\w-]+(?:\s+[a-z][\w-]+){0,2}?(?:\s+(?:developer|engineer|designer|manager|researcher|writer|student|scientist)))\b/gi,
    make: (m) => ({ kind: "identity", predicate: "role", object: clean(m[1]), polarity: 1, initialStrength: 0.7 }),
  },
  // Preferences
  {
    re: new RegExp(`\\bmy favou?rite [\\w ]+? is ${OBJ}`, "gi"),
    make: (m) => ({ kind: "preference", predicate: "prefers", object: clean(m[1]), polarity: 1, initialStrength: 0.7 }),
  },
  {
    re: new RegExp(
      `\\bi (?:really |absolutely |strongly |still |definitely |genuinely |honestly )?(?:prefer|love|like|enjoy|favou?r)\\s+(?:using\\s+|working with\\s+|writing\\s+)?${OBJ}`,
      "gi",
    ),
    make: (m) => {
      // "I prefer X over Y" learns only +X, deliberately NOT -Y (PLAN.md
      // Task 2.5, Option A): comparisons are context-bound — "TypeScript
      // over plain JavaScript for new services" ranks the two for one
      // purpose, it does not assert a general dislike of Y. A dislike must
      // be stated independently ("I hate Y") to be learned.
      const object = clean(m[1].split(/\s+(?:over|rather than|instead of)\s+/i)[0]);
      if (!object) return undefined;
      return { kind: "preference", predicate: "prefers", object, polarity: 1, initialStrength: 0.6 };
    },
  },
  {
    re: new RegExp(
      `\\bi (?:really )?(?:hate|dislike|can'?t stand|cannot stand|don'?t like|do not like|loathe)\\s+${OBJ}`,
      "gi",
    ),
    make: (m) => ({ kind: "preference", predicate: "prefers", object: clean(m[1]), polarity: -1, initialStrength: 0.6 }),
  },
  // Directives (how the assistant should behave)
  {
    re: new RegExp(`\\bfrom now on,?\\s*(?:please\\s+)?${OBJ}`, "gi"),
    make: (m) => ({ kind: "directive", predicate: "directive", object: clean(m[1]), polarity: 1, initialStrength: 0.75 }),
  },
  {
    re: new RegExp(`\\bplease always\\s+${OBJ}`, "gi"),
    make: (m) => ({ kind: "directive", predicate: "directive", object: clean(m[1]), polarity: 1, initialStrength: 0.75 }),
  },
  {
    re: new RegExp(`\\bplease (?:never|don'?t|do not|stop)\\s+${OBJ}`, "gi"),
    make: (m) => ({ kind: "directive", predicate: "directive", object: clean(m[1]), polarity: -1, initialStrength: 0.75 }),
  },
  {
    re: new RegExp(`\\bi'?d rather you\\s+${OBJ}`, "gi"),
    make: (m) => ({ kind: "directive", predicate: "directive", object: clean(m[1]), polarity: 1, initialStrength: 0.7 }),
  },
  // Attributes
  {
    re: new RegExp(`\\bi (?:use|code in|develop in|write)\\s+${OBJ}\\b`, "gi"),
    make: (m) => {
      const object = clean(m[1].split(/\s+(?:for|to|when|at|because)\b/i)[0]);
      if (!object) return undefined;
      return { kind: "attribute", predicate: "uses", object, polarity: 1, initialStrength: 0.55 };
    },
  },
  {
    re: new RegExp(`\\b[Ii] work (?:at|for)\\s+${NAME}`, "g"),
    make: (m) => ({ kind: "attribute", predicate: "works_at", object: clean(m[1]), polarity: 1, initialStrength: 0.7 }),
  },
  {
    re: new RegExp(`\\bi(?:'m| am) working on\\s+${OBJ}`, "gi"),
    make: (m) => ({ kind: "attribute", predicate: "works_on", object: clean(m[1]), polarity: 1, initialStrength: 0.55 }),
  },
  // Health constraints are durable and high-stakes; learned eagerly.
  {
    re: new RegExp(`\\bi(?:'m| am) allergic to\\s+${OBJ}`, "gi"),
    make: (m) => ({ kind: "attribute", predicate: "allergic_to", object: clean(m[1]), polarity: 1, initialStrength: 0.75 }),
  },
  // Residence: "I live in Boulder" and the inverted "in Boulder, where I live".
  {
    re: new RegExp(`\\b[Ii] live in ${NAME}`, "g"),
    make: (m) => ({ kind: "attribute", predicate: "lives_in", object: clean(m[1]), polarity: 1, initialStrength: 0.7 }),
  },
  {
    re: new RegExp(`\\bin ${NAME},?\\s+where i live\\b`, "gi"),
    make: (m) => ({ kind: "attribute", predicate: "lives_in", object: clean(m[1]), polarity: 1, initialStrength: 0.7 }),
  },
];

/**
 * Relationships are facts, not just entities: "my sister Alice" asserts
 * rel_sister=Alice. Multi-valued by design (two sisters is not a
 * contradiction). Only first-person ("my …") statements assert facts.
 */
function relationshipFacts(text: string): FactCandidate[] {
  const out: FactCandidate[] = [];
  RELATIONSHIP.lastIndex = 0;
  for (const m of text.matchAll(RELATIONSHIP)) {
    if (CAP_STOPLIST.has(m[2])) continue;
    const relation = RELATION_CANONICAL[m[1].toLowerCase()] ?? m[1].toLowerCase();
    out.push({
      kind: "attribute",
      predicate: `rel_${relation}`,
      object: clean(m[2]),
      polarity: 1,
      initialStrength: 0.7,
    });
  }
  return out;
}

export function extractFacts(text: string): FactCandidate[] {
  const out: FactCandidate[] = [];
  const seen = new Set<string>();
  const candidates: (FactCandidate | undefined)[] = [];
  for (const spec of PATTERNS) {
    spec.re.lastIndex = 0;
    for (const m of text.matchAll(spec.re)) {
      candidates.push(spec.make(m));
    }
  }
  candidates.push(...relationshipFacts(text));
  for (const candidate of candidates) {
    if (!candidate || !candidate.object) continue;
    const norm = normalizeObject(candidate.object);
    if (!norm || norm.length < 2 || norm.length > 80) continue;
    const key = factId(candidate, norm);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Relationship-extraction support (used by relationshipFacts above)

const CAP_STOPLIST = new Set(
  (
    "I The A An My We You It This That These Those If When What Why How Who Where " +
    "Yes No Ok Okay Please Thanks Thank Hello Hi Hey Also And But Or So Not Just " +
    "Can Could Would Should Do Does Did Is Are Was Were Let Maybe Sure Today Tomorrow " +
    "Yesterday Here There Now Then First Second Next Last Monday Tuesday Wednesday " +
    "Thursday Friday Saturday Sunday January February March April May June July " +
    "August September October November December " +
    // Sentence-opening conversational fillers ("Happy to help", "Good
    // question", "Got it", …). The set gates the person-name capture in the
    // relationship regex path (relationshipFacts) — a relationship name that
    // collides with a filler ("my dog Right") is dropped; we accept that
    // loss to keep filler noise out of learned facts. Consulted positionally
    // (leading word of a capture), so mid-span uses are unaffected.
    "Happy Good Great Absolutely Definitely Got Sounds Looks Glad Cool Right Awesome Welcome"
  ).split(" "),
);

const RELATIONSHIP =
  /\b[Mm]y\s+(sister|brother|mom|mother|dad|father|wife|husband|partner|friend|boss|manager|colleague|coworker|son|daughter|cousin|aunt|uncle|dog|cat)(?:'s)?(?:\s+(?:is\s+(?:named|called)\s+|name\s+is\s+)?)([A-Z][\w'-]*)/g;

const RELATION_CANONICAL: Record<string, string> = { mom: "mother", dad: "father" };
