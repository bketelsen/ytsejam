/**
 * Schema definitions for the LTM memory system.
 *
 * Persistence model mirrors ytsejam: JSONL event logs are the source of
 * truth, latest-wins per record id. Every record here is serialized as one
 * JSONL line; in-memory indexes (vectors, BM25) are
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
 *
 * "observation" (SEAM 4): a deliberate, externally authored note (e.g. a
 * cog observation line bridged from ytsejam) — persisted like any episodic
 * record but slow-decaying (DecayConfig.halfLifeDaysByKind) and exempt
 * from consolidation; written via MemorySystem.recordObservation().
 */
export type EpisodicKind = "turn" | "consolidated" | "observation";

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
  /**
   * Domain tags (SEAM 3), e.g. "projects:ytsejam" — carried from external
   * sources (cog observation tags) as denormalized metadata; retrieve()
   * can scope to a tagged subset via RetrieveOptions.filterTags. Absent on
   * session-ingested turns.
   */
  tags?: string[];
  /**
   * Opaque provenance key for externally sourced records (SEAM 4),
   * convention `cog:<path>#<digest12>` (12-hex-char content hash; see
   * server/src/memory/bridge/ltm-observer.ts computeOrigin). Drives
   * redaction cascade via RedactionSelector { originPrefix } — prefer
   * content digest over line numbers, which drift in human-edited files.
   */
  origin?: string;
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
  /**
   * Times this fact was recalled from dormancy by a direct slot question
   * (strong-cue recall). Rehearsal: stretches the disuse half-life the same
   * way accessCount does for episodic records. Optional — absent on facts
   * written before this field existed.
   */
  recallCount?: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Every turn that asserted this fact. Drives redaction propagation. */
  sources: SourceRef[];
  /** Set when a newer contradictory fact replaced this one. */
  supersededBy?: string;
  state: RecordState;
  /** Resolved project tag (e.g. "projects:ytsejam"); absent = global. */
  projectTag?: string;
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
  /** Rendered natural-language sentence (output of renderFact). */
  text: string;
  /** The fact's lastSeenAt. */
  timestamp: string;
  /** The fact's strength. */
  salience: number;
  /** Always 0 — promoted items are never access-bumped. (Rehearsal for a
   *  stale promotion bumps recallCount on the underlying SemanticFact, not
   *  this synthetic item's accessCount.) */
  accessCount: number;
  /** Set when the fact was promoted from the dormant (below-floor) profile
   *  section by a direct slot question — consumers should phrase it as
   *  historical ("you told me on <date>"), not current. */
  stale?: boolean;
  // No `state` field, deliberately: promoted items are always "active" and
  // are never consolidated, redacted, or persisted.
}

export interface ScoreBreakdown {
  vector: number;
  lexical: number;
  recency: number;
  salience: number;
  /** Decay multiplier applied to salience (see decay.ts). */
  retention: number;
  total: number;
}

export interface RetrievedMemory {
  /** A stored episodic memory, or a synthetic promoted profile fact. */
  record: EpisodicRecord | PromotedFact;
  score: number;
  breakdown: ScoreBreakdown;
  /** Set when this item was recalled past decay: a dormant promoted fact or
   *  a resurrected consolidated record. */
  stale?: boolean;
}

export interface ProfileSummary {
  identity: SemanticFact[];
  preferences: SemanticFact[];
  directives: SemanticFact[];
  attributes: SemanticFact[];
  /**
   * Active, non-superseded facts whose effective strength fell below their
   * floor — invisible to unprompted composition, but reachable by a direct
   * slot question (strong-cue recall). Sorted by effective strength desc.
   */
  dormant: SemanticFact[];
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
  /**
   * Scope episodic results to records with a matching tag (SEAM 3).
   * A filter "infra" matches tags "infra" and "infra:net" (tag-segment
   * prefix). Untagged records are excluded while a filter is set —
   * filtering means "search the tagged subset". Promoted profile facts
   * are not tag-scoped. Default: no filtering.
   */
  filterTags?: string[];
}

// ---------------------------------------------------------------------------
// Redaction / inspection

export type RedactionSelector =
  | { recordId: string }
  | { sessionId: string }
  | { entity: string }
  | { pattern: string }
  /** Records whose `origin` starts with this prefix (SEAM 5) — e.g.
   *  "cog:personal/observations.md" for a file-level cascade, or
   *  "cog:personal/" for a whole domain. Extracted facts cascade through
   *  the existing source path (an observation's fact source carries the
   *  same origin as its sessionId). */
  | { originPrefix: string };

export interface RedactionResult {
  episodicRedacted: number;
  factsRedacted: number;
  consolidatedRebuilt: number;
}

/**
 * Audit log line. Never contains redacted content: record/session ids are
 * opaque and kept verbatim, but entity names and patterns — the very thing
 * the user asked to forget — are stored only as a hash digest.
 */
export interface RedactionEvent {
  at: string;
  selector: { type: "recordId" | "sessionId" | "entity" | "pattern" | "originPrefix"; ref: string };
  result: RedactionResult;
}

// ---------------------------------------------------------------------------
// Configuration

export interface DecayConfig {
  /** Base half-life in days for a salience-0.5, never-accessed record. */
  halfLifeDays: number;
  /** Additional half-life multiplier per access. */
  accessBonus: number;
  /**
   * Per-kind base half-life override (SEAM 2). Deliberate, externally
   * authored records (kind "observation") should outlive conversational
   * turns; `Infinity` pins a kind (retention 1 forever). Config is
   * code-side, so Infinity's JSON-unserializability is not a constraint.
   * Kinds without an entry use halfLifeDays.
   */
  halfLifeDaysByKind?: Partial<Record<EpisodicKind, number>>;
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
  /**
   * Z-score (leave-one-out, over the candidate pool's cosines) a consolidated
   * record must reach to be resurrected by a semantic match. Calibrated
   * against the eval (Task RECALL 9); flat or tiny pools never resurrect.
   */
  resurrectZ: number;
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
  resurrectZ?: number;
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
    resurrectZ: patch.resurrectZ ?? DEFAULT_CONFIG.resurrectZ,
  };
}

export const DEFAULT_CONFIG: LtmConfig = {
  decay: {
    halfLifeDays: 30,
    accessBonus: 0.5,
    // Observations are deliberate writes; let them last (SEAM 2/4).
    halfLifeDaysByKind: { observation: 730 },
  },
  consolidation: { olderThanDays: 45, retentionFloor: 0.35, maxSummaryChars: 1200 },
  // Content match (lexical + vector) must dominate; recency and salience are
  // tie-breakers, not channels that can outvote an exact term match. (The
  // preference-graph channel was removed — it contributed exactly zero to
  // retrieval — so the surviving four weights are renormalized to sum 1.0.)
  weights: {
    vector: 0.35294117647058826,
    lexical: 0.4705882352941177,
    recency: 0.09411764705882353,
    salience: 0.0823529411764706,
  },
  profile: { floor: 0.3, identityFloor: 0.3, directiveFloor: 0.3 },
  mmrLambda: 0.7,
  maxChunkChars: 1500,
  recencyHalfLifeDays: 21,
  // Calibrated RECALL 9: leave-one-out z-gate for consolidated-record
  // resurrection. Measured {2.5, 3.5, 5.0} on seeds 0-5, hash + nomic — all
  // three recover the SAME consolidated paraphrase targets (guitar, marathon)
  // with no MRR/stability change: a lone true outlier clears z ≈ 28, far
  // above any candidate, and no false resurrection lands in the 2.5-5.0 band,
  // so the eval fixtures cannot distinguish the three. The binding constraint
  // is the RECALL 7 "no mutual suppression" invariant: when TWO equally
  // strong consolidated records (cosine 1.0) sit in one pool, each one's
  // leave-one-out z collapses to ≈ 2.98 (the twin inflates the pool mean and
  // std), so any gate above ~2.98 makes genuine twin matches mutually
  // suppress each other below the floor. 2.5 is the calibrated value: it
  // preserves twin resurrection with headroom while still rejecting mid-pool
  // records (a 0.30-cosine consolidated record scores z ≈ -0.15). Raising it
  // buys no measured eval recovery and silently breaks multi-match recall.
  resurrectZ: 2.5,
};
