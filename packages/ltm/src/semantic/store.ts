/**
 * Semantic memory store: durable facts about the user, persisted to
 * facts.jsonl (latest-wins snapshots).
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
  FactKind,
  ProfileFloors,
  ProfileSummary,
  SemanticFact,
  SourceRef,
  Turn,
} from "../types.ts";
import { JsonlLog } from "../store/jsonl-log.ts";
import {
  canonicalizePredicate,
  extractFacts,
  factId,
  factPhrase,
  normalizeObject,
  slug,
} from "./extract.ts";
import { RegexFactExtractor, type FactExtractor } from "./fact-extractor.ts";
import type { Embedder } from "../embedding/embedder.ts";

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

/** Half-life multiplier per dormant recall (mirrors episodic accessBonus). */
const RECALL_BONUS = 0.5;

export function effectiveStrength(fact: SemanticFact, now: string): number {
  const age = Math.max(0, Date.parse(now) - Date.parse(fact.lastSeenAt)) / DAY_MS;
  const halfLife =
    FACT_HALF_LIFE_DAYS[fact.kind] * (1 + RECALL_BONUS * (fact.recallCount ?? 0));
  return fact.strength * Math.pow(2, -age / halfLife);
}

export class SemanticStore {
  private facts: Map<string, SemanticFact>;
  private factLog: JsonlLog<SemanticFact>;
  private factExtractor: FactExtractor;
  private embedder?: Embedder;

  private constructor(
    factLog: JsonlLog<SemanticFact>,
    factExtractor: FactExtractor,
    embedder?: Embedder,
  ) {
    this.factLog = factLog;
    this.facts = factLog.load();
    this.factExtractor = factExtractor;
    this.embedder = embedder;
  }

  static open(
    storeDir: string,
    factExtractor: FactExtractor = new RegexFactExtractor(),
    embedder?: Embedder,
  ): SemanticStore {
    return new SemanticStore(
      new JsonlLog<SemanticFact>(path.join(storeDir, "facts.jsonl")),
      factExtractor,
      embedder,
    );
  }

  /**
   * Embed a fact's rendered phrase for semantic recall. Skip-on-failure: a
   * missing embedder or an embed error leaves the fact keyword-only rather
   * than blocking the write (facts must persist even when the embedding
   * backend is down — the same fail-open contract as the bridge).
   */
  private async embedFact(
    predicate: string,
    object: string,
    polarity: 1 | -1,
  ): Promise<number[] | undefined> {
    if (!this.embedder) return undefined;
    try {
      const v = await this.embedder.embed(factPhrase(predicate, object, polarity));
      return v.length ? v : undefined;
    } catch {
      return undefined;
    }
  }

  // -- ingestion -----------------------------------------------------------

  /** Learn facts from one turn. Facts come from user turns only. */
  async ingestTurn(turn: Turn, projectTag?: string): Promise<void> {
    const source: SourceRef = { sessionId: turn.sessionId, entryId: turn.entryId };
    if (turn.rootSessionId && turn.rootSessionId !== turn.sessionId) {
      source.rootSessionId = turn.rootSessionId;
    }

    if (turn.role === "user") {
      // Canonicalize predicates and dedupe within the turn so the LLM emitting
      // e.g. works_on + works_on_repo for the same project asserts one fact,
      // not several near-duplicates.
      const seen = new Set<string>();
      for (const candidate of await this.factExtractor.extract(turn.text)) {
        const tag = candidate.scope === "project" && projectTag ? projectTag : undefined;
        const predicate = canonicalizePredicate(candidate.predicate);
        const id = factId({ kind: candidate.kind, predicate, polarity: candidate.polarity }, normalizeObject(candidate.object), tag);
        if (seen.has(id)) continue;
        seen.add(id);
        await this.assertFact(candidate.kind, predicate, candidate.object, candidate.polarity, candidate.initialStrength, source, turn.timestamp, tag);
      }
    }
  }

  private async assertFact(
    kind: FactKind,
    predicate: string,
    object: string,
    polarity: 1 | -1,
    initialStrength: number,
    source: SourceRef,
    at: string,
    projectTag?: string,
  ): Promise<void> {
    predicate = canonicalizePredicate(predicate);
    const objectNorm = normalizeObject(object);
    const id = factId({ kind, predicate, polarity }, objectNorm, projectTag);
    const existing = this.facts.get(id);

    if (existing && existing.state !== "redacted") {
      // Re-embed only when the surface object changed or the fact had no
      // embedding yet (e.g. learned before an embedder was configured).
      const embedding =
        existing.object !== object || !existing.embedding
          ? (await this.embedFact(predicate, object, polarity)) ?? existing.embedding
          : existing.embedding;
      const updated: SemanticFact = {
        ...existing,
        object,
        strength: 1 - (1 - existing.strength) * (1 - REINFORCE),
        mentionCount: existing.mentionCount + 1,
        lastSeenAt: at,
        sources: dedupeSources([...existing.sources, source]),
        // Re-assertion revives a superseded fact: it wins again by recency.
        supersededBy: undefined,
        ...(embedding ? { embedding } : {}),
      };
      this.facts.set(id, updated);
      this.factLog.append(updated);
      this.supersedeContradictions(updated, at);
      return;
    }

    const embedding = await this.embedFact(predicate, object, polarity);
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
      ...(projectTag !== undefined ? { projectTag } : {}),
      ...(embedding ? { embedding } : {}),
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

  // -- reads ----------------------------------------------------------------

  allFacts(): SemanticFact[] {
    return [...this.facts.values()];
  }

  activeFacts(): SemanticFact[] {
    return this.allFacts().filter((f) => f.state === "active" && !f.supersededBy);
  }

  profile(
    now: string,
    floors: ProfileFloors = { floor: 0.3, identityFloor: 0.3, directiveFloor: 0.3 },
    activeProjectTag?: string,
  ): ProfileSummary {
    const floorFor = (f: SemanticFact): number =>
      f.kind === "identity" ? floors.identityFloor : f.kind === "directive" ? floors.directiveFloor : floors.floor;
    const scoped = this.activeFacts().filter(
      (f) => !f.projectTag || f.projectTag === activeProjectTag,
    );
    const all = scoped.sort(
      (a, b) => effectiveStrength(b, now) - effectiveStrength(a, now),
    );
    const facts = all.filter((f) => effectiveStrength(f, now) >= floorFor(f));
    const dormant = all.filter((f) => effectiveStrength(f, now) < floorFor(f));
    return {
      identity: facts.filter((f) => f.kind === "identity"),
      preferences: facts.filter((f) => f.kind === "preference"),
      directives: facts.filter((f) => f.kind === "directive"),
      attributes: facts.filter((f) => f.kind === "attribute"),
      dormant,
    };
  }

  /**
   * Rehearsal: a dormant fact was recalled by a direct slot question.
   * In-memory count always updates; the log snapshot is appended only at
   * powers of two, mirroring EpisodicStore.bumpAccess — recall counts are a
   * decay heuristic, not accounting. Unlike bumpAccess, this does not
   * advance lastSeenAt — recall is rehearsal, not a fresh user assertion.
   */
  recordRecall(id: string): void {
    const fact = this.facts.get(id);
    if (!fact || fact.state !== "active" || fact.supersededBy) return;
    const updated = { ...fact, recallCount: (fact.recallCount ?? 0) + 1 };
    this.facts.set(id, updated);
    const c = updated.recallCount;
    if ((c & (c - 1)) === 0) this.factLog.append(updated);
  }

  // -- maintenance -----------------------------------------------------------

  /**
   * Restore exact fact records, overwriting whatever the store currently holds
   * for those ids. Used to recover from a faulty redaction/purge (D3): the
   * caller supplies the pre-damage records (e.g. from a store backup) and this
   * appends them verbatim, so the log's latest-wins load resolves them as the
   * live state. Facts NOT named here are untouched — restoring the wiped set
   * cannot clobber surviving facts whose ids are absent from `records`.
   *
   * This is a verbatim restore, NOT a re-derivation: strength, mentionCount,
   * sources, and timestamps are taken from the supplied record as-is. Records
   * missing a string id are skipped (and counted) rather than corrupting the log.
   */
  restoreFacts(records: Iterable<SemanticFact>): { restored: number; skipped: number } {
    let restored = 0;
    let skipped = 0;
    for (const fact of records) {
      if (typeof fact.id !== "string" || !fact.id) {
        skipped++;
        continue;
      }
      this.facts.set(fact.id, fact);
      this.factLog.append(fact);
      restored++;
    }
    return { restored, skipped };
  }

  /**
   * Embed active facts that have no embedding yet (e.g. learned before the
   * embedder existed, or restored from a backup). Skip-on-failure per fact:
   * an embed error leaves that fact keyword-only. Returns how many gained an
   * embedding. Compacts the log when anything changed. No-op without an
   * embedder.
   */
  async backfillEmbeddings(): Promise<{ embedded: number; skipped: number }> {
    if (!this.embedder) return { embedded: 0, skipped: 0 };
    let embedded = 0;
    let skipped = 0;
    for (const fact of this.facts.values()) {
      if (fact.state !== "active" || fact.supersededBy) continue;
      if (fact.embedding && fact.embedding.length > 0) continue;
      const embedding = await this.embedFact(fact.predicate, fact.object, fact.polarity);
      if (!embedding) {
        skipped++;
        continue;
      }
      const updated = { ...fact, embedding };
      this.facts.set(fact.id, updated);
      this.factLog.append(updated);
      embedded++;
    }
    if (embedded > 0) this.factLog.compact(this.facts.values());
    return { embedded, skipped };
  }

  /** Collapse the semantic append-only log to one latest-wins snapshot per id. */
  compactLogs(): { facts: number } {
    this.factLog.compact(this.facts.values());
    return { facts: this.facts.size };
  }

  /**
   * Redact active facts the extractor no longer reproduces from their sources.
   *
   * Two-phase: a read-only decision pass computes the redaction set, then a
   * guarded commit pass applies it. `maxPurgeFraction` (default 0.5) is a
   * circuit-breaker — if the decision pass would redact more than this share
   * of active facts, the purge ABORTS without mutating anything and returns
   * `aborted` with the offending fraction. A systemic resolver failure (no
   * readable sources) looks like "everything is stale"; the fraction guard,
   * together with the per-fact fail-safe below, prevents that from wiping the
   * store. Pass `dryRun: true` to compute the set without committing.
   */
  purgeStaleFacts(
    readTurnText: (sessionId: string, entryId: string) => string | undefined,
    now: string,
    opts: { maxPurgeFraction?: number; dryRun?: boolean } = {},
  ): {
    kept: number;
    purged: string[];
    aborted?: { reason: "fraction"; fraction: number; limit: number; active: number };
  } {
    const maxPurgeFraction = opts.maxPurgeFraction ?? 0.5;
    const active: SemanticFact[] = [];
    const toPurge: string[] = [];

    // Decision pass — read-only, no mutation.
    for (const fact of this.facts.values()) {
      if (fact.state !== "active" || fact.supersededBy) continue;
      active.push(fact);
      const reproduced = new Set<string>();
      let anySourceReadable = false;
      for (const source of fact.sources) {
        const text = readTurnText(source.sessionId, source.entryId);
        if (text === undefined) continue;
        anySourceReadable = true;
        for (const candidate of extractFacts(text)) {
          reproduced.add(factId(candidate, normalizeObject(candidate.object)));
        }
      }
      // Fail-safe: only redact when we actually read at least one source and
      // the extractor no longer produces this fact from it. If NO source was
      // readable (missing file, unreachable session dir, truncated/unmatched
      // entryId), we have no evidence either way — keep the fact. Treating
      // "couldn't verify" as "doesn't reproduce" is what wiped the whole
      // active set under a non-recursive session scan.
      if (!reproduced.has(fact.id) && anySourceReadable) {
        toPurge.push(fact.id);
      }
    }

    // Circuit-breaker: refuse to commit a mass redaction.
    const fraction = active.length === 0 ? 0 : toPurge.length / active.length;
    if (toPurge.length > 0 && fraction > maxPurgeFraction) {
      return {
        kept: active.length,
        purged: [],
        aborted: { reason: "fraction", fraction, limit: maxPurgeFraction, active: active.length },
      };
    }

    if (opts.dryRun) {
      return { kept: active.length - toPurge.length, purged: [...toPurge] };
    }

    // Commit pass.
    const purgeSet = new Set(toPurge);
    for (const fact of active) {
      if (!purgeSet.has(fact.id)) continue;
      const tombstone: SemanticFact = {
        ...fact,
        object: "",
        objectNorm: "",
        sources: [],
        strength: 0,
        state: "redacted",
      };
      this.facts.set(fact.id, tombstone);
      this.factLog.append(tombstone);
    }

    if (toPurge.length > 0) this.factLog.compact(this.facts.values());
    void now;
    return { kept: active.length - toPurge.length, purged: [...toPurge] };
  }

  // -- redaction -------------------------------------------------------------

  /**
   * Remove knowledge derived from the given source turns. A fact loses the
   * matching sources; one with no remaining evidence is redacted outright.
   * The log is compacted so removed evidence doesn't linger on disk.
   */
  redactBySources(match: (s: SourceRef) => boolean): { facts: number } {
    let factsRedacted = 0;

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

    this.factLog.compact(this.facts.values());
    return { facts: factsRedacted };
  }

  /** Tombstone a single active fact by id. Returns false if absent/already redacted. */
  redactFactById(id: string): boolean {
    const fact = this.facts.get(id);
    if (!fact || fact.state === "redacted") return false;
    const tombstone: SemanticFact = {
      ...fact, object: "", objectNorm: "", sources: [], strength: 0, state: "redacted",
    };
    this.facts.set(id, tombstone);
    this.factLog.append(tombstone);
    this.factLog.compact(this.facts.values());
    return true;
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
