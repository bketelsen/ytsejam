/**
 * Schema definitions for the LTM memory system.
 *
 * Persistence model mirrors ytsejam: JSONL event logs are the source of
 * truth, latest-wins per record id. Every record here is serialized as one
 * JSONL line; in-memory indexes (vectors, BM25, the preference graph) are
 * derived and rebuilt on load.
 */

// ---------------------------------------------------------------------------
// Provenance

/** Pointer back into the ytsejam session store an item was derived from. */
export interface SourceRef {
  sessionId: string;
  /** Session-tree entry id within the session JSONL (8-char uuidv7 prefix). */
  entryId: string;
  /**
   * Root of the fork chain when sessionId is a forked (subagent) session —
   * the session whose user this knowledge belongs to. Absent when the
   * session is itself the root.
   */
  rootSessionId?: string;
}

// ---------------------------------------------------------------------------
// Conversation turns (output of the session reader)

export type TurnRole = "user" | "assistant" | "summary";

/** One conversational unit extracted from a session's active branch. */
export interface Turn {
  sessionId: string;
  entryId: string;
  role: TurnRole;
  text: string;
  /** ISO-8601 timestamp of the underlying session entry. */
  timestamp: string;
  /** Root of the fork chain (subagent sessions); equals sessionId otherwise. */
  rootSessionId?: string;
}

/** A parsed session: metadata plus the turns on its active branch. */
export interface ParsedSession {
  sessionId: string;
  /** Session title from the latest session_info entry, when present. */
  title?: string;
  cwd: string;
  createdAt: string;
  /** Path of the session this one was forked from (subagent sessions). */
  parentSessionPath?: string;
  turns: Turn[];
  /** Non-fatal parse problems (skipped lines, unknown entry types). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Episodic memory

export type RecordState = "active" | "consolidated" | "redacted";

/**
 * The closed set of kinds that can appear in episodic.jsonl. Synthetic
 * retrieval-only items (promoted profile facts) are deliberately NOT part
 * of this union — see PromotedFact.
 */
export type EpisodicKind = "turn" | "consolidated";

/**
 * One episodic memory: a chunk of a conversation turn, or a consolidated
 * summary standing in for many decayed turn records.
 */
export interface EpisodicRecord {
  /** Stable id: `${sessionId}/${entryId}#${chunkIndex}` for turns, `con-…` for consolidations. */
  id: string;
  kind: EpisodicKind;
  sessionId: string;
  /** Set for kind "turn". */
  entryId?: string;
  /** Child record ids folded into this one. Set for kind "consolidated". */
  sourceIds?: string[];
  role: TurnRole;
  text: string;
  timestamp: string;
  /** Intrinsic importance in [0, 1], assigned at ingest. */
  salience: number;
  /** Times this record was surfaced by retrieval; slows decay. */
  accessCount: number;
  lastAccessedAt?: string;
  state: RecordState;
  /** Unit-norm embedding; absent on tombstones. */
  embedding?: number[];
}

// ---------------------------------------------------------------------------
// Semantic memory

export type FactKind = "preference" | "directive" | "identity" | "attribute";

/**
 * A durable fact about the user, learned heuristically from their turns.
 *
 * - preference: predicate "prefers", polarity +1 (likes) / -1 (dislikes)
 * - directive:  predicate "directive", polarity +1 (always) / -1 (never)
 * - identity:   slot-valued (predicate = slot, e.g. "name"); newer wins
 * - attribute:  predicate "uses" | "works_on" | "interest"
 */
export interface SemanticFact {
  /** Stable id derived from (kind, predicate, normalized object). */
  id: string;
  kind: FactKind;
  predicate: string;
  /** Object surface form as last stated by the user. */
  object: string;
  /** Normalized object used for matching and contradiction detection. */
  objectNorm: string;
  polarity: 1 | -1;
  /** Belief strength in (0, 1]; reinforced by repetition, decays with disuse. */
  strength: number;
  mentionCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Every turn that asserted this fact. Drives redaction propagation. */
  sources: SourceRef[];
  /** Set when a newer contradictory fact replaced this one. */
  supersededBy?: string;
  state: RecordState;
}

export type EntityKind =
  | "person"
  | "tech"
  | "path"
  | "url"
  | "email"
  | "code"
  | "other";

/** An entity observed in conversation; node of the preference graph. */
export interface EntityRecord {
  /** Stable id derived from the normalized name. */
  id: string;
  name: string;
  norm: string;
  kind: EntityKind;
  mentionCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  sessionIds: string[];
  sources: SourceRef[];
  state: RecordState;
}

/**
 * Derived (not persisted) edge of the preference graph. Fact edges connect
 * the user to entities; co-occurrence edges connect entities mentioned in
 * the same turn. Rebuilt from facts + active episodic text on load, so
 * redaction never leaves stale edges.
 */
export interface GraphEdge {
  from: string;
  to: string;
  relation: "prefers" | "dislikes" | "uses" | "works_on" | "interest" | "co_occurs";
  weight: number;
}

// ---------------------------------------------------------------------------
// Retrieval

/**
 * A profile fact promoted into retrieval results (retrieval/promote.ts).
 *
 * Synthetic and retrieval-only: NEVER persisted. The underlying fact lives
 * in facts.jsonl (the source of truth) and a PromotedFact is re-derived
 * from it on every retrieve() call. Its `kind: "fact"` is deliberately not
 * an EpisodicKind, so the type system rejects promoted items at every
 * persist boundary (episodic store writes take EpisodicRecord).
 */
export interface PromotedFact {
  /** `fact/${fact.id}` — namespaced so it can never collide with a store id. */
  id: string;
  kind: "fact";
  /** The semantic fact this item renders. */
  fact: SemanticFact;
  /** Provenance: the session/entry that first asserted the fact. */
  sessionId: string;
  entryId?: string;
  role: TurnRole;
  text: string;
  /** The fact's lastSeenAt. */
  timestamp: string;
  /** The fact's strength. */
  salience: number;
  /** Always 0 — promoted items are never access-bumped. */
  accessCount: number;
}

export interface ScoreBreakdown {
  vector: number;
  lexical: number;
  recency: number;
  salience: number;
  graph: number;
  /** Decay multiplier applied to salience (see decay.ts). */
  retention: number;
  total: number;
}

export interface RetrievedMemory {
  /** A stored episodic memory, or a synthetic promoted profile fact. */
  record: EpisodicRecord | PromotedFact;
  score: number;
  breakdown: ScoreBreakdown;
}

export interface ProfileSummary {
  identity: SemanticFact[];
  preferences: SemanticFact[];
  directives: SemanticFact[];
  attributes: SemanticFact[];
  topEntities: EntityRecord[];
}

export interface RetrievalResult {
  items: RetrievedMemory[];
  profile: ProfileSummary;
}

export interface RetrieveOptions {
  /** Max episodic items to return. Default 8. */
  k?: number;
  /** Approximate token budget for composeContext packing. Default 1200. */
  tokenBudget?: number;
  /** Clock override for decay math (ISO timestamp). Default: real now. */
  now?: string;
  /** Include records already consolidated into summaries. Default false. */
  includeConsolidated?: boolean;
  /** When true, retrieval does not bump accessCount. Default false. */
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Redaction / inspection

export type RedactionSelector =
  | { recordId: string }
  | { sessionId: string }
  | { entity: string }
  | { pattern: string };

export interface RedactionResult {
  episodicRedacted: number;
  factsRedacted: number;
  entitiesRedacted: number;
  consolidatedRebuilt: number;
}

/**
 * Audit log line. Never contains redacted content: record/session ids are
 * opaque and kept verbatim, but entity names and patterns — the very thing
 * the user asked to forget — are stored only as a hash digest.
 */
export interface RedactionEvent {
  at: string;
  selector: { type: "recordId" | "sessionId" | "entity" | "pattern"; ref: string };
  result: RedactionResult;
}

// ---------------------------------------------------------------------------
// Configuration

export interface DecayConfig {
  /** Base half-life in days for a salience-0.5, never-accessed record. */
  halfLifeDays: number;
  /** Additional half-life multiplier per access. */
  accessBonus: number;
}

export interface ConsolidationConfig {
  /** Only records older than this are eligible. */
  olderThanDays: number;
  /** Only records whose retention fell below this are eligible. */
  retentionFloor: number;
  /** Max characters of an extractive session summary. */
  maxSummaryChars: number;
}

/**
 * Minimum effective strength (post disuse-decay) for a fact to surface in
 * the profile, per fact family. Lowering identityFloor/directiveFloor keeps
 * slot-like facts surfacing longer at the cost of more stale positives —
 * a user-visible tradeoff, hence config rather than constant.
 */
export interface ProfileFloors {
  floor: number;
  identityFloor: number;
  directiveFloor: number;
}

export interface RetrievalWeights {
  vector: number;
  lexical: number;
  recency: number;
  salience: number;
  graph: number;
}

export interface LtmConfig {
  decay: DecayConfig;
  consolidation: ConsolidationConfig;
  weights: RetrievalWeights;
  profile: ProfileFloors;
  /** MMR diversity/relevance trade-off in [0,1]; 1 = pure relevance. */
  mmrLambda: number;
  /** Chunk size ceiling in characters for episodic records. */
  maxChunkChars: number;
  /** Recency scoring half-life in days. */
  recencyHalfLifeDays: number;
}

/** Deep-partial patch shape accepted by MemorySystem.open. */
export interface LtmConfigPatch {
  decay?: Partial<DecayConfig>;
  consolidation?: Partial<ConsolidationConfig>;
  weights?: Partial<RetrievalWeights>;
  profile?: Partial<ProfileFloors>;
  mmrLambda?: number;
  maxChunkChars?: number;
  recencyHalfLifeDays?: number;
}

export function mergeConfig(patch: LtmConfigPatch = {}): LtmConfig {
  return {
    decay: { ...DEFAULT_CONFIG.decay, ...patch.decay },
    consolidation: { ...DEFAULT_CONFIG.consolidation, ...patch.consolidation },
    weights: { ...DEFAULT_CONFIG.weights, ...patch.weights },
    profile: { ...DEFAULT_CONFIG.profile, ...patch.profile },
    mmrLambda: patch.mmrLambda ?? DEFAULT_CONFIG.mmrLambda,
    maxChunkChars: patch.maxChunkChars ?? DEFAULT_CONFIG.maxChunkChars,
    recencyHalfLifeDays: patch.recencyHalfLifeDays ?? DEFAULT_CONFIG.recencyHalfLifeDays,
  };
}

export const DEFAULT_CONFIG: LtmConfig = {
  decay: { halfLifeDays: 30, accessBonus: 0.5 },
  consolidation: { olderThanDays: 45, retentionFloor: 0.35, maxSummaryChars: 1200 },
  // Content match (lexical + vector) must dominate; recency and salience are
  // tie-breakers, not channels that can outvote an exact term match.
  weights: { vector: 0.3, lexical: 0.4, recency: 0.08, salience: 0.07, graph: 0.15 },
  profile: { floor: 0.3, identityFloor: 0.3, directiveFloor: 0.3 },
  mmrLambda: 0.7,
  maxChunkChars: 1500,
  recencyHalfLifeDays: 21,
};
