/**
 * Semantic memory store: durable facts about the user plus an entity store,
 * persisted to facts.jsonl / entities.jsonl (latest-wins snapshots).
 *
 * Belief dynamics:
 * - Reinforcement: re-asserting a fact raises strength asymptotically toward
 *   1 (strength' = 1 - (1 - strength) * (1 - REINFORCE)).
 * - Contradiction: an opposite-polarity assertion about the same object (or
 *   a new value for a single-valued identity slot) supersedes the old fact —
 *   newest statement wins, the old fact is kept but marked superseded.
 * - Disuse decay is applied at read time in profile(): facts not reasserted
 *   for a long time surface with reduced effective strength.
 */

import path from "node:path";
import type {
  EntityRecord,
  FactKind,
  ProfileFloors,
  ProfileSummary,
  SemanticFact,
  SourceRef,
  Turn,
} from "../types.ts";
import { JsonlLog } from "../store/jsonl-log.ts";
import {
  extractEntities,
  extractFacts,
  factId,
  normalizeObject,
  slug,
} from "./extract.ts";

const REINFORCE = 0.4;
/** Identity predicates that hold a single value; a new value supersedes. */
const SINGLE_VALUED = new Set(["name", "role", "works_at"]);
/**
 * Disuse half-life per fact kind. Identity and standing directives are
 * slot-like and low-churn — users state them once and expect them to stick —
 * while casual preferences should fade if never reasserted.
 */
const FACT_HALF_LIFE_DAYS: Record<FactKind, number> = {
  preference: 120,
  attribute: 180,
  directive: 365,
  identity: 365,
};
const DAY_MS = 24 * 60 * 60 * 1000;

export function effectiveStrength(fact: SemanticFact, now: string): number {
  const age = Math.max(0, Date.parse(now) - Date.parse(fact.lastSeenAt)) / DAY_MS;
  return fact.strength * Math.pow(2, -age / FACT_HALF_LIFE_DAYS[fact.kind]);
}

export class SemanticStore {
  private facts: Map<string, SemanticFact>;
  private entities: Map<string, EntityRecord>;
  private factLog: JsonlLog<SemanticFact>;
  private entityLog: JsonlLog<EntityRecord>;

  private constructor(
    factLog: JsonlLog<SemanticFact>,
    entityLog: JsonlLog<EntityRecord>,
  ) {
    this.factLog = factLog;
    this.entityLog = entityLog;
    this.facts = factLog.load();
    this.entities = entityLog.load();
  }

  static open(storeDir: string): SemanticStore {
    return new SemanticStore(
      new JsonlLog<SemanticFact>(path.join(storeDir, "facts.jsonl")),
      new JsonlLog<EntityRecord>(path.join(storeDir, "entities.jsonl")),
    );
  }

  // -- ingestion -----------------------------------------------------------

  /** Learn facts and entities from one turn. Facts come from user turns only. */
  ingestTurn(turn: Turn): void {
    const source: SourceRef = { sessionId: turn.sessionId, entryId: turn.entryId };

    if (turn.role === "user") {
      for (const candidate of extractFacts(turn.text)) {
        this.assertFact(candidate.kind, candidate.predicate, candidate.object, candidate.polarity, candidate.initialStrength, source, turn.timestamp);
      }
    }

    for (const candidate of extractEntities(turn.text)) {
      this.observeEntity(candidate.name, candidate.kind, source, turn.timestamp);
    }
  }

  private assertFact(
    kind: FactKind,
    predicate: string,
    object: string,
    polarity: 1 | -1,
    initialStrength: number,
    source: SourceRef,
    at: string,
  ): void {
    const objectNorm = normalizeObject(object);
    const id = factId({ kind, predicate, polarity }, objectNorm);
    const existing = this.facts.get(id);

    if (existing && existing.state !== "redacted") {
      const updated: SemanticFact = {
        ...existing,
        object,
        strength: 1 - (1 - existing.strength) * (1 - REINFORCE),
        mentionCount: existing.mentionCount + 1,
        lastSeenAt: at,
        sources: dedupeSources([...existing.sources, source]),
        // Re-assertion revives a superseded fact: it wins again by recency.
        supersededBy: undefined,
      };
      this.facts.set(id, updated);
      this.factLog.append(updated);
      this.supersedeContradictions(updated, at);
      return;
    }

    const fact: SemanticFact = {
      id,
      kind,
      predicate,
      object,
      objectNorm,
      polarity,
      strength: initialStrength,
      mentionCount: 1,
      firstSeenAt: at,
      lastSeenAt: at,
      sources: [source],
      state: "active",
    };
    this.facts.set(id, fact);
    this.factLog.append(fact);
    this.supersedeContradictions(fact, at);
  }

  /** Newest statement wins: mark conflicting older facts as superseded. */
  private supersedeContradictions(winner: SemanticFact, at: string): void {
    for (const fact of this.facts.values()) {
      if (fact.id === winner.id || fact.state === "redacted" || fact.supersededBy) continue;
      if (fact.kind !== winner.kind || fact.predicate !== winner.predicate) continue;
      if (Date.parse(fact.lastSeenAt) > Date.parse(at)) continue;

      const opposite = fact.objectNorm === winner.objectNorm && fact.polarity !== winner.polarity;
      const slotConflict =
        SINGLE_VALUED.has(winner.predicate) && fact.objectNorm !== winner.objectNorm;
      if (opposite || slotConflict) {
        const superseded = { ...fact, supersededBy: winner.id };
        this.facts.set(fact.id, superseded);
        this.factLog.append(superseded);
      }
    }
  }

  private observeEntity(
    name: string,
    kind: EntityRecord["kind"],
    source: SourceRef,
    at: string,
  ): void {
    const norm = name.toLowerCase();
    const id = `ent-${slug(norm)}`;
    const existing = this.entities.get(id);
    if (existing && existing.state !== "redacted") {
      const updated: EntityRecord = {
        ...existing,
        kind: existing.kind === "other" && kind !== "other" ? kind : existing.kind,
        mentionCount: existing.mentionCount + 1,
        lastSeenAt: at,
        sessionIds: existing.sessionIds.includes(source.sessionId)
          ? existing.sessionIds
          : [...existing.sessionIds, source.sessionId],
        sources: dedupeSources([...existing.sources, source]),
      };
      this.entities.set(id, updated);
      this.entityLog.append(updated);
      return;
    }
    if (existing?.state === "redacted") return; // stays forgotten
    const record: EntityRecord = {
      id,
      name,
      norm,
      kind,
      mentionCount: 1,
      firstSeenAt: at,
      lastSeenAt: at,
      sessionIds: [source.sessionId],
      sources: [source],
      state: "active",
    };
    this.entities.set(id, record);
    this.entityLog.append(record);
  }

  // -- reads ----------------------------------------------------------------

  allFacts(): SemanticFact[] {
    return [...this.facts.values()];
  }

  allEntities(): EntityRecord[] {
    return [...this.entities.values()];
  }

  activeFacts(): SemanticFact[] {
    return this.allFacts().filter((f) => f.state === "active" && !f.supersededBy);
  }

  activeEntities(): EntityRecord[] {
    return this.allEntities().filter((e) => e.state === "active");
  }

  profile(
    now: string,
    floors: ProfileFloors = { floor: 0.3, identityFloor: 0.3, directiveFloor: 0.3 },
  ): ProfileSummary {
    const floorFor = (f: SemanticFact): number =>
      f.kind === "identity" ? floors.identityFloor : f.kind === "directive" ? floors.directiveFloor : floors.floor;
    const facts = this.activeFacts()
      .filter((f) => effectiveStrength(f, now) >= floorFor(f))
      .sort((a, b) => effectiveStrength(b, now) - effectiveStrength(a, now));
    return {
      identity: facts.filter((f) => f.kind === "identity"),
      preferences: facts.filter((f) => f.kind === "preference"),
      directives: facts.filter((f) => f.kind === "directive"),
      attributes: facts.filter((f) => f.kind === "attribute"),
      topEntities: this.activeEntities()
        .sort((a, b) => b.mentionCount - a.mentionCount)
        .slice(0, 12),
    };
  }

  // -- redaction -------------------------------------------------------------

  /**
   * Remove knowledge derived from the given source turns. A fact or entity
   * loses the matching sources; one with no remaining evidence is redacted
   * outright. Logs are compacted so removed evidence doesn't linger on disk.
   */
  redactBySources(match: (s: SourceRef) => boolean): { facts: number; entities: number } {
    let factsRedacted = 0;
    let entitiesRedacted = 0;

    for (const fact of this.facts.values()) {
      if (fact.state === "redacted") continue;
      const remaining = fact.sources.filter((s) => !match(s));
      if (remaining.length === fact.sources.length) continue;
      if (remaining.length === 0) {
        this.facts.set(fact.id, {
          ...fact,
          object: "",
          objectNorm: "",
          sources: [],
          strength: 0,
          state: "redacted",
        });
        factsRedacted++;
      } else {
        this.facts.set(fact.id, { ...fact, sources: remaining, mentionCount: remaining.length });
      }
    }

    for (const entity of this.entities.values()) {
      if (entity.state === "redacted") continue;
      const remaining = entity.sources.filter((s) => !match(s));
      if (remaining.length === entity.sources.length) continue;
      if (remaining.length === 0) {
        this.entities.set(entity.id, {
          ...entity,
          name: "",
          norm: "",
          sources: [],
          sessionIds: [],
          mentionCount: 0,
          state: "redacted",
        });
        entitiesRedacted++;
      } else {
        this.entities.set(entity.id, {
          ...entity,
          sources: remaining,
          mentionCount: remaining.length,
          sessionIds: [...new Set(remaining.map((s) => s.sessionId))],
        });
      }
    }

    this.factLog.compact(this.facts.values());
    this.entityLog.compact(this.entities.values());
    return { facts: factsRedacted, entities: entitiesRedacted };
  }

  /** Redact a specific entity by name (and facts referencing it). */
  redactEntity(name: string): { facts: number; entities: number } {
    const norm = name.toLowerCase().trim();
    let factsRedacted = 0;
    let entitiesRedacted = 0;
    for (const entity of this.entities.values()) {
      if (entity.state === "redacted" || entity.norm !== norm) continue;
      this.entities.set(entity.id, {
        ...entity,
        name: "",
        norm: "",
        sources: [],
        sessionIds: [],
        mentionCount: 0,
        state: "redacted",
      });
      entitiesRedacted++;
    }
    for (const fact of this.facts.values()) {
      if (fact.state === "redacted") continue;
      if (fact.objectNorm === norm || fact.objectNorm.includes(norm)) {
        this.facts.set(fact.id, {
          ...fact,
          object: "",
          objectNorm: "",
          sources: [],
          strength: 0,
          state: "redacted",
        });
        factsRedacted++;
      }
    }
    this.factLog.compact(this.facts.values());
    this.entityLog.compact(this.entities.values());
    return { facts: factsRedacted, entities: entitiesRedacted };
  }
}

function dedupeSources(sources: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const s of sources) {
    const key = `${s.sessionId}/${s.entryId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
