/**
 * Preference-learning and entity-extraction heuristics.
 *
 * Deliberately lexical and deterministic: regex patterns over user turns
 * yield candidate facts; the semantic store handles reinforcement, decay,
 * and contradiction (see graph.ts). An LLM extractor can be layered on later
 * behind the same FactCandidate/EntityCandidate shapes.
 */

import type { EntityKind, FactKind } from "../types.ts";

export interface FactCandidate {
  kind: FactKind;
  predicate: string;
  object: string;
  polarity: 1 | -1;
  /** Initial belief for a first sighting; reinforcement raises it. */
  initialStrength: number;
}

export interface EntityCandidate {
  /** Display form, preferring a capitalized surface form when one was seen. */
  name: string;
  /** Normalized lowercase identity — the ONLY thing entities are keyed by. */
  key: string;
  kind: EntityKind;
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
    .replace(/\s+(?:now|these days|anymore|any more|again|lately|though|to be honest|honestly)$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function slug(s: string): string {
  return s.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

export function factId(c: Pick<FactCandidate, "kind" | "predicate" | "polarity">, objectNorm: string): string {
  return `fact-${c.kind}-${c.predicate}-${slug(objectNorm)}-${c.polarity > 0 ? "p" : "n"}`;
}

function clean(s: string): string {
  return s.replace(/[.,!?;:]+$/g, "").replace(/\s+/g, " ").trim();
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
];

export function extractFacts(text: string): FactCandidate[] {
  const out: FactCandidate[] = [];
  const seen = new Set<string>();
  for (const spec of PATTERNS) {
    spec.re.lastIndex = 0;
    for (const m of text.matchAll(spec.re)) {
      const candidate = spec.make(m);
      if (!candidate || !candidate.object) continue;
      const norm = normalizeObject(candidate.object);
      if (!norm || norm.length < 2 || norm.length > 80) continue;
      const key = factId(candidate, norm);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(candidate);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entity extraction

const TECH_LEXICON = new Set(
  (
    "typescript javascript python rust go golang java kotlin swift ruby php c c++ c# " +
    "react vue svelte angular node nodejs deno bun vite vitest jest webpack postgres " +
    "postgresql sqlite mysql redis docker kubernetes linux macos windows git github " +
    "gitlab vscode vim emacs neovim tailwind hono express django flask rails graphql " +
    "rest grpc aws gcp azure terraform ansible nginx anthropic claude openai"
  ).split(" "),
);

const CAP_STOPLIST = new Set(
  (
    "I The A An My We You It This That These Those If When What Why How Who Where " +
    "Yes No Ok Okay Please Thanks Thank Hello Hi Hey Also And But Or So Not Just " +
    "Can Could Would Should Do Does Did Is Are Was Were Let Maybe Sure Today Tomorrow " +
    "Yesterday Here There Now Then First Second Next Last Monday Tuesday Wednesday " +
    "Thursday Friday Saturday Sunday January February March April May June July " +
    "August September October November December"
  ).split(" "),
);

const RELATIONSHIP =
  /\b(?:[Mm]y|[Hh]is|[Hh]er|[Tt]heir)\s+(?:sister|brother|mom|mother|dad|father|wife|husband|partner|friend|boss|manager|colleague|coworker|son|daughter|cousin|aunt|uncle|dog|cat)(?:'s)?(?:\s+(?:is\s+(?:named|called)\s+|name\s+is\s+)?)([A-Z][\w'-]*)/g;

export function extractEntities(text: string): EntityCandidate[] {
  const out = new Map<string, EntityCandidate>();
  // Candidates are indexed by normalized key only; the display name and the
  // kind upgrade independently of which pattern fired first, so the result
  // does not depend on regex execution order (PLAN.md Task 2.4):
  // - a specific kind (person/tech/…) beats the generic "other" guess;
  // - a capitalized surface form beats an all-lowercase one for display.
  const add = (name: string, kind: EntityKind) => {
    const trimmed = name.trim();
    if (trimmed.length < 2 || trimmed.length > 80) return;
    const key = trimmed.toLowerCase();
    const existing = out.get(key);
    if (!existing) {
      out.set(key, { name: trimmed, key, kind });
      return;
    }
    const betterKind = existing.kind === "other" && kind !== "other" ? kind : existing.kind;
    const betterName =
      existing.name === existing.key && trimmed !== key ? trimmed : existing.name;
    if (betterKind !== existing.kind || betterName !== existing.name) {
      out.set(key, { name: betterName, key, kind: betterKind });
    }
  };

  for (const m of text.matchAll(/`([^`\n]+)`/g)) add(m[1], "code");
  for (const m of text.matchAll(/https?:\/\/[^\s)>\]]+/g)) add(m[0].replace(/[.,;]+$/, ""), "url");
  for (const m of text.matchAll(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g)) add(m[0], "email");
  for (const m of text.matchAll(/(?:^|[\s("'])((?:~|\.{1,2})?\/[\w.-]+(?:\/[\w.-]+)+)/g)) add(m[1], "path");

  RELATIONSHIP.lastIndex = 0;
  for (const m of text.matchAll(RELATIONSHIP)) {
    if (!CAP_STOPLIST.has(m[1])) add(m[1], "person");
  }

  for (const m of text.matchAll(/\b([A-Z][a-zA-Z0-9+#.]{1,30}(?:\s+[A-Z][a-zA-Z0-9+#.]{1,30}){0,2})\b/g)) {
    const name = m[1];
    const first = name.split(/\s+/)[0];
    if (CAP_STOPLIST.has(first)) continue;
    add(name, TECH_LEXICON.has(name.toLowerCase()) ? "tech" : "other");
  }

  // Lowercase tech terms ("i use typescript") still count as tech entities;
  // add() upgrades kind/display if the term was already seen another way.
  for (const token of text.toLowerCase().match(/\b[a-z][a-z0-9+#.]{1,30}\b/g) ?? []) {
    if (TECH_LEXICON.has(token)) add(token, "tech");
  }

  return [...out.values()];
}
