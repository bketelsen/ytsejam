/**
 * MemorySystem — the public facade. Owns the episodic and semantic stores,
 * the ingestion pipeline, the derived indexes, and the user-control
 * surface (inspect / explain / redact / export).
 *
 * Lifecycle: open() loads the JSONL store and rebuilds derived state;
 * ingest*() pulls new session entries in; retrieve()/composeContext() serve
 * per-turn context; consolidate() runs the decay-driven maintenance pass
 * and compacts semantic logs.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  EpisodicRecord,
  LtmConfig,
  ProfileSummary,
  RedactionEvent,
  RedactionResult,
  RedactionSelector,
  RetrievalResult,
  RetrieveOptions,
  RetrievedMemory,
  SemanticFact,
  SourceRef,
  Turn,
} from "../types.ts";
import { mergeConfig, type LtmConfigPatch } from "../types.ts";
import { HashEmbedder, type Embedder } from "../embedding/embedder.ts";
import { VectorIndex } from "../embedding/vector-index.ts";
import { EpisodicStore } from "../episodic/store.ts";
import {
  consolidate,
  extractiveSummary,
  summaryId,
  type Summarizer,
} from "../episodic/consolidate.ts";
import { retention } from "../episodic/decay.ts";
import { SemanticStore } from "../semantic/store.ts";
import { Retriever, packToBudget } from "../retrieval/retriever.ts";
import { promoteFacts } from "../retrieval/promote.ts";
import { IngestPipeline, type IngestReport } from "../pipeline/ingest.ts";
import { JsonlLog } from "../store/jsonl-log.ts";
import {
  listSessionFiles,
  readSessionFile,
  type ReadSessionOptions,
} from "../session/reader.ts";

export interface MemorySystemOptions {
  /** Directory for the memory store's JSONL files. */
  storeDir: string;
  embedder?: Embedder;
  config?: LtmConfigPatch;
  summarizer?: Summarizer;
  readOptions?: ReadSessionOptions;
  /** Clock override (ISO timestamp) for deterministic tests/evals. */
  now?: () => string;
  /**
   * Path of a JSONL trace appended per retrieve() call — the post-fold
   * "why didn't it surface that?" record (PLAN.md Task 5.3). Defaults to
   * the LTM_RETRIEVAL_LOG env var; unset means no tracing.
   */
  retrievalLog?: string;
}

interface AuditRecord extends RedactionEvent {
  id: string;
}

/**
 * The store is single-writer: JSONL appends from two processes interleave
 * unpredictably and the in-memory fold would diverge from disk. open()
 * takes an advisory lock (lock.pid in the store dir) with stale-pid
 * takeover; close() releases it. A second open() of the same store while
 * one is live throws (PLAN.md Task 3.4).
 */
export class MemorySystem {
  /** Store dirs held open by THIS process (a pid file can't distinguish two handles in one process). */
  private static openDirs = new Set<string>();

  readonly config: LtmConfig;
  private readonly storeDir: string;
  private readonly lockPath: string;
  private closed = false;
  private readonly embedder: Embedder;
  private readonly summarizer: Summarizer;
  private readonly episodic: EpisodicStore;
  private readonly semantic: SemanticStore;
  private readonly pipeline: IngestPipeline;
  private readonly auditLog: JsonlLog<AuditRecord>;
  private retriever: Retriever;
  private readonly clock: () => string;
  private readonly retrievalLog?: string;
  private readonly readOptions?: ReadSessionOptions;
  private auditSeq = 0;

  private constructor(opts: MemorySystemOptions) {
    this.storeDir = opts.storeDir;
    this.lockPath = path.join(this.storeDir, "lock.pid");
    this.acquireLock();
    this.config = mergeConfig(opts.config);
    this.embedder = opts.embedder ?? new HashEmbedder();
    this.summarizer = opts.summarizer ?? extractiveSummary;
    this.clock = opts.now ?? (() => new Date().toISOString());
    this.retrievalLog = opts.retrievalLog ?? process.env.LTM_RETRIEVAL_LOG;
    this.readOptions = opts.readOptions;
    this.episodic = EpisodicStore.open(this.storeDir);
    this.semantic = SemanticStore.open(this.storeDir);
    this.auditLog = new JsonlLog<AuditRecord>(
      path.join(this.storeDir, "redactions.jsonl"),
    );
    this.auditSeq = this.auditLog.load().size;
    this.pipeline = new IngestPipeline({
      storeDir: this.storeDir,
      episodic: this.episodic,
      semantic: this.semantic,
      embedder: this.embedder,
      config: this.config,
      readOptions: opts.readOptions,
    });
    this.retriever = new Retriever({
      store: this.episodic,
      embedder: this.embedder,
      config: this.config,
    });
  }

  static open(opts: MemorySystemOptions): MemorySystem {
    return new MemorySystem(opts);
  }

  private acquireLock(): void {
    const key = path.resolve(this.storeDir);
    if (MemorySystem.openDirs.has(key)) {
      throw new Error(
        `Memory store ${this.storeDir} is already open in this process — close() the other MemorySystem first (single-writer store).`,
      );
    }
    fs.mkdirSync(this.storeDir, { recursive: true });
    let holder: number | undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.lockPath, "utf8")) as {
        pid?: number;
      };
      if (typeof parsed.pid === "number") holder = parsed.pid;
    } catch {
      // no lock or unreadable lock — treat as stale
    }
    if (holder !== undefined && holder !== process.pid && pidAlive(holder)) {
      throw new Error(
        `Memory store ${this.storeDir} is locked by live pid ${holder} (lock.pid) — the store is single-writer. ` +
          `If that process is gone, delete the lock file.`,
      );
    }
    // Free, stale (dead pid), or a leaked same-pid lock: take over.
    fs.writeFileSync(
      this.lockPath,
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
    );
    MemorySystem.openDirs.add(key);
  }

  /** Release the single-writer lock. Idempotent; the handle stays readable. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    MemorySystem.openDirs.delete(path.resolve(this.storeDir));
    try {
      const parsed = JSON.parse(fs.readFileSync(this.lockPath, "utf8")) as {
        pid?: number;
      };
      if (parsed.pid === process.pid) fs.rmSync(this.lockPath);
    } catch {
      // lock already gone
    }
  }

  /** Rebuild every derived structure after a mutation of the stores. */
  private rebuildDerived(): void {
    this.retriever = new Retriever({
      store: this.episodic,
      embedder: this.embedder,
      config: this.config,
    });
  }

  // -- ingestion ------------------------------------------------------------

  async ingestSessionFile(filePath: string): Promise<IngestReport> {
    const report = await this.pipeline.ingestFile(filePath);
    if (report.recordsCreated > 0 || report.turnsIngested > 0)
      this.rebuildDerived();
    return report;
  }

  async ingestSessionDir(dir: string): Promise<IngestReport> {
    const report = await this.pipeline.ingestDir(dir);
    if (report.recordsCreated > 0 || report.turnsIngested > 0)
      this.rebuildDerived();
    return report;
  }

  /**
   * Record a deliberate, externally authored observation (SEAM 4) — the
   * write API the cog→LTM bridge calls. Unlike session turns (learned by
   * the ingester), an observation is an explicit note: it gets a slow
   * per-kind half-life, an optional domain tag and provenance `origin`,
   * and its text is run through the semantic extractor so facts learn from
   * deliberate writes and a later originPrefix redaction cascades to them.
   *
   * The id is content-addressed (`obs-<sha256(text+timestamp)>`), so
   * re-recording the same line is idempotent: the record upserts
   * latest-wins (metadata like tags/origin updates), and fact learning
   * runs only on first sight of that id — re-ingest does NOT inflate the
   * extracted fact's mentionCount/strength. This matters because the
   * bridge's promotion gate reads mentionCount; a watcher re-emitting an
   * unchanged line must not look like reinforcement. (Note: `origin` is
   * not part of the id; re-recording identical text+timestamp under a new
   * origin won't re-learn under the new provenance.)
   */
  async recordObservation(obs: {
    text: string;
    timestamp: string;
    tags?: string[];
    origin?: string;
    salience?: number;
  }): Promise<EpisodicRecord> {
    const digest = crypto
      .createHash("sha256")
      .update(`${obs.text}\n${obs.timestamp}`)
      .digest("hex")
      .slice(0, 12);
    const id = `obs-${digest}`;
    const alreadyLearned = this.episodic.get(id) !== undefined;
    const record: EpisodicRecord = {
      id,
      kind: "observation",
      sessionId: obs.origin ?? "observation",
      entryId: digest,
      role: "user",
      text: obs.text,
      timestamp: obs.timestamp,
      salience: obs.salience ?? 0.85,
      accessCount: 0,
      state: "active",
      embedding: await this.embedder.embed(obs.text),
      ...(obs.tags ? { tags: obs.tags } : {}),
      ...(obs.origin ? { origin: obs.origin } : {}),
    };
    this.episodic.upsert(record);

    // Learn facts from the deliberate write — ONLY on first sight of this
    // id, so re-ingest of an unchanged line doesn't reinforce facts (the
    // bridge's promotion gate reads mentionCount). The synthesized Turn's
    // sessionId = origin so source-based redaction (originPrefix) cascades.
    if (!alreadyLearned) {
      const turn: Turn = {
        sessionId: obs.origin ?? "observation",
        entryId: digest,
        role: "user",
        text: obs.text,
        timestamp: obs.timestamp,
      };
      this.semantic.ingestTurn(turn);
    }

    this.rebuildDerived();
    return record;
  }

  // -- retrieval ------------------------------------------------------------

  /**
   * Returns true if any episodic record exists with the given origin
   * string. Synchronous; backed by the in-memory episodic index.
   * Used by the cog-LTM bridge to skip already-mirrored observations.
   */
  hasObservation(origin: string): boolean {
    if (!origin) return false;
    return this.episodic.all().some((r) => r.origin === origin);
  }

  /**
   * Return a map of all currently-live (non-redacted) observation records
   * with a cog: origin, keyed by origin → record id.
   *
   * Used by the reconciler's prune pass to identify orphan records (cog
   * origins not present in the current cog file scan).
   */
  allObservationsByOrigin(): Map<string, string> {
    const out = new Map<string, string>();
    for (const r of this.episodic.all()) {
      if (r.kind !== "observation") continue;
      if (r.state === "redacted") continue;
      if (!r.origin || !r.origin.startsWith("cog:")) continue;
      out.set(r.origin, r.id);
    }
    return out;
  }

  /** Return the dimension of currently stored episodic vectors, or null when the index is empty. */
  indexDimension(): number | null {
    const vectors = new VectorIndex();
    for (const record of this.episodic.all()) {
      if (record.embedding) vectors.set(record.id, record.embedding);
    }
    return vectors.sampleDimension();
  }

  /**
   * True on-disk distribution of stored embedding dimensions, counted
   * directly from records (NOT through VectorIndex, which now refuses
   * off-dimension vectors). Surfaces D2 contamination: the majority dimension
   * is the live one; any minority bucket is dead weight excluded from
   * retrieval, awaiting re-embed. `primary` is the most common dimension.
   */
  dimensionReport(): { primary: number | null; counts: Record<number, number>; total: number } {
    const counts: Record<number, number> = {};
    let total = 0;
    for (const record of this.episodic.all()) {
      if (!record.embedding || record.embedding.length === 0) continue;
      const d = record.embedding.length;
      counts[d] = (counts[d] ?? 0) + 1;
      total++;
    }
    let primary: number | null = null;
    let best = -1;
    for (const [d, n] of Object.entries(counts)) {
      if (n > best) {
        best = n;
        primary = Number(d);
      }
    }
    return { primary, counts, total };
  }

  async retrieve(
    query: string,
    opts: RetrieveOptions = {},
  ): Promise<RetrievalResult> {
    const now = opts.now ?? this.clock();
    const k = opts.k ?? 8;
    const profile = this.semantic.profile(now, this.config.profile);
    const ranked = await this.retriever.rank(
      query,
      k,
      now,
      opts.includeConsolidated ?? false,
      opts.filterTags,
    );

    // Slot-aware promotion: profile facts the query addresses surface ahead
    // of episodic items (composeContext puts the profile first anyway, and
    // a slot answer beats a lexical near-miss). Synthetic records — never
    // persisted. Episodic accessCount is never bumped for facts; stale dormant
    // facts instead get a rehearsal bump via semantic.recordRecall (below).
    const promoted = promoteFacts(query, profile).map(
      (record): RetrievedMemory => ({
        record,
        score: 1,
        ...(record.stale ? { stale: true } : {}),
        breakdown: {
          vector: 0,
          lexical: 0,
          recency: 0,
          salience: record.salience, // = fact.strength
          retention: 1,
          total: 1,
        },
      }),
    );

    const items = packToBudget(
      [...promoted, ...ranked],
      opts.tokenBudget ?? 1200,
    ).slice(0, Math.max(k, promoted.length));
    if (!opts.dryRun) {
      for (const item of items) {
        if (item.record.kind === "fact") {
          // Dormant facts recalled by a direct slot question count as rehearsal:
          // bumps recallCount which stretches the fact's decay half-life,
          // eventually pushing it back above the profile floor.
          if (item.stale) this.semantic.recordRecall(item.record.fact.id);
        } else {
          this.episodic.bumpAccess(item.record.id, now);
        }
      }
    }
    this.trace(query, k, now, items);
    return { items, profile };
  }

  /** Append one retrieval-trace line; tracing failures never break retrieval. */
  private trace(
    query: string,
    k: number,
    at: string,
    items: RetrievedMemory[],
  ): void {
    if (!this.retrievalLog) return;
    try {
      fs.mkdirSync(path.dirname(this.retrievalLog), { recursive: true });
      fs.appendFileSync(
        this.retrievalLog,
        `${JSON.stringify({
          at,
          query,
          k,
          returned: items.map((i) => ({
            id: i.record.id,
            score: i.score,
            ...(i.stale ? { stale: true } : {}),
            breakdown: i.breakdown,
          })),
        })}\n`,
      );
    } catch {
      // tracing is best-effort observability
    }
  }

  /**
   * Render a retrieval result as a system-prompt-ready context block:
   * the user profile (identity, preferences, directives) followed by
   * relevant episodic memories with their dates.
   */
  async composeContext(
    query: string,
    opts: RetrieveOptions = {},
  ): Promise<string> {
    const { items, profile } = await this.retrieve(query, opts);
    const lines: string[] = [];

    const factLine = (f: SemanticFact) =>
      `- ${f.predicate === "directive" ? (f.polarity > 0 ? "always" : "never") : f.predicate}${
        f.kind === "preference" && f.polarity < 0 ? " (dislikes)" : ""
      }: ${f.object}`;

    if (
      profile.identity.length ||
      profile.preferences.length ||
      profile.directives.length ||
      profile.attributes.length
    ) {
      lines.push("## What you know about the user");
      for (const f of [...profile.identity, ...profile.attributes])
        lines.push(factLine(f));
      for (const f of profile.preferences) lines.push(factLine(f));
      if (profile.directives.length) {
        lines.push("", "Standing instructions:");
        for (const f of profile.directives) lines.push(factLine(f));
      }
    }

    if (items.length) {
      lines.push("", "## Relevant past conversation");
      for (const item of items) {
        const date = item.record.timestamp.slice(0, 10);
        const who =
          item.record.role === "summary" ? "summary" : item.record.role;
        lines.push(`- [${date}, ${who}] ${item.record.text}`);
      }
    }

    return lines.join("\n").trim();
  }

  profile(now?: string): ProfileSummary {
    return this.semantic.profile(now ?? this.clock(), this.config.profile);
  }

  // -- maintenance ------------------------------------------------------------

  async consolidate(
    opts: { now?: string } = {},
  ): Promise<{
    created: number;
    folded: number;
    factsCompacted: number;
  }> {
    const now = opts.now ?? this.clock();
    const result = await consolidate(
      this.episodic,
      this.embedder,
      now,
      this.config.consolidation,
      this.config.decay,
      this.summarizer,
    );
    if (result.created.length > 0) this.rebuildDerived();
    const semanticCompacted = this.semantic.compactLogs();
    return {
      created: result.created.length,
      folded: result.consolidatedChildren,
      factsCompacted: semanticCompacted.facts,
    };
  }

  async purgeStaleFacts(
    sessionsDir: string,
    opts: { maxPurgeFraction?: number; dryRun?: boolean } = {},
  ): Promise<{
    kept: number;
    purged: string[];
    aborted?: { reason: "fraction"; fraction: number; limit: number; active: number };
  }> {
    const sessionFiles = new Map<string, string>();
    for (const file of listSessionFiles(sessionsDir)) {
      const sessionId = readSessionId(file);
      if (sessionId) sessionFiles.set(sessionId, file);
    }

    const sessions = new Map<
      string,
      { turns: Turn[] } | undefined
    >();
    const resolver = (sessionId: string, entryId: string): string | undefined => {
      const file = sessionFiles.get(sessionId);
      if (!file) return undefined;
      if (!sessions.has(sessionId)) {
        try {
          sessions.set(sessionId, readSessionFile(file, this.readOptions));
        } catch {
          sessions.set(sessionId, undefined);
        }
      }
      return sessions
        .get(sessionId)
        ?.turns.find((turn) => entryIdMatches(turn.entryId, entryId))?.text;
    };

    const result = this.semantic.purgeStaleFacts(resolver, this.clock(), opts);
    if (result.purged.length > 0 && !opts.dryRun) this.rebuildDerived();
    return result;
  }

  // -- inspection (user control surface) --------------------------------------

  listEpisodic(
    filter: { sessionId?: string; state?: EpisodicRecord["state"] } = {},
  ): EpisodicRecord[] {
    return this.episodic
      .all()
      .filter((r) =>
        filter.sessionId ? r.sessionId === filter.sessionId : true,
      )
      .filter((r) => (filter.state ? r.state === filter.state : true))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  listFacts(): SemanticFact[] {
    return this.semantic.allFacts();
  }

  getRecord(id: string): EpisodicRecord | undefined {
    return this.episodic.get(id);
  }

  /** Why would this query surface these memories? Ranked with score breakdowns; read-only. */
  async explain(query: string, k = 8): Promise<RetrievedMemory[]> {
    return this.retriever.rank(query, k, this.clock(), true);
  }

  stats(now?: string): {
    episodic: {
      total: number;
      active: number;
      consolidated: number;
      redacted: number;
      meanRetention: number;
    };
    facts: { total: number; active: number };
  } {
    const at = now ?? this.clock();
    const records = this.episodic.all();
    const active = records.filter((r) => r.state === "active");
    const meanRetention = active.length
      ? active.reduce(
          (sum, r) => sum + retention(r, at, this.config.decay),
          0,
        ) / active.length
      : 0;
    return {
      episodic: {
        total: records.length,
        active: active.length,
        consolidated: records.filter((r) => r.state === "consolidated").length,
        redacted: records.filter((r) => r.state === "redacted").length,
        meanRetention,
      },
      facts: {
        total: this.semantic.allFacts().length,
        active: this.semantic.activeFacts().length,
      },
    };
  }

  /** Full dump for user transparency/export. */
  export(): {
    episodic: EpisodicRecord[];
    facts: SemanticFact[];
  } {
    return {
      episodic: this.episodic
        .all()
        .map((r) => ({ ...r, embedding: undefined })),
      facts: this.semantic.allFacts(),
    };
  }

  // -- redaction ---------------------------------------------------------------

  /**
   * Tombstone many episodic records by id, in one compaction pass.
   *
   * Lower-cost sibling of redact(selector) for reconciler bulk-prune paths:
   *   - No RedactionEvent audit (caller logs at its own layer).
   *   - No semantic/consolidated cascade (caller is responsible for the
   *     invariant that pruned records have no live cascade targets — e.g.
   *     orphan observations whose source line is gone from cog memory have
   *     no current children to rebuild from).
   *
   * Returns the count actually tombstoned (already-redacted skipped).
   */
  episodicRedactMany(ids: Iterable<string>): number {
    const n = this.episodic.redactMany(ids);
    if (n > 0) this.rebuildDerived();
    return n;
  }

  /**
   * Forget memories matching the selector. Episodic records are tombstoned
   * (text + embedding destroyed, logs compacted); semantic facts/entities
   * derived from the redacted turns lose that evidence and are redacted when
   * none remains; consolidated summaries containing a redacted child are
   * rebuilt from the surviving children. An audit event (ids/counts only,
   * never content) is appended to redactions.jsonl.
   */
  async redact(selector: RedactionSelector): Promise<RedactionResult> {
    const result: RedactionResult = {
      episodicRedacted: 0,
      factsRedacted: 0,
      consolidatedRebuilt: 0,
    };

    const targets = this.selectRecords(selector);
    const redactedSources: SourceRef[] = [];
    for (const record of targets) {
      if (this.episodic.redact(record.id)) {
        result.episodicRedacted++;
        if (record.entryId) {
          redactedSources.push({
            sessionId: record.sessionId,
            entryId: record.entryId,
          });
        }
      }
    }

    // Propagate to semantic memory: facts derived from the redacted source
    // turns lose that evidence (and are tombstoned if no evidence remains).
    if (redactedSources.length > 0) {
      const keys = new Set(
        redactedSources.map((s) => `${s.sessionId}/${s.entryId}`),
      );
      const r = this.semantic.redactBySources((s) =>
        keys.has(`${s.sessionId}/${s.entryId}`),
      );
      result.factsRedacted += r.facts;
    }

    // Rebuild consolidated summaries that included a redacted child.
    const redactedIds = new Set(targets.map((t) => t.id));
    for (const summary of this.episodic.all()) {
      if (summary.kind !== "consolidated" || summary.state !== "active")
        continue;
      if (!summary.sourceIds?.some((id) => redactedIds.has(id))) continue;
      const survivors = (summary.sourceIds ?? [])
        .filter((id) => !redactedIds.has(id))
        .map((id) => this.episodic.get(id))
        .filter(
          (r): r is EpisodicRecord => !!r && r.state !== "redacted" && !!r.text,
        );
      this.episodic.redact(summary.id);
      if (survivors.length >= 2) {
        const text = (
          await this.summarizer(
            survivors,
            this.config.consolidation.maxSummaryChars,
          )
        ).trim();
        if (text) {
          this.episodic.upsert({
            ...summary,
            id: summaryId(
              summary.sessionId,
              survivors.map((r) => r.id),
            ),
            sourceIds: survivors.map((r) => r.id),
            text,
            embedding: await this.embedder.embed(text),
          });
        }
      }
      result.consolidatedRebuilt++;
    }

    this.auditLog.append({
      id: `red-${this.auditSeq++}`,
      at: this.clock(),
      selector: sanitizeSelector(selector),
      result,
    });
    this.rebuildDerived();
    return result;
  }

  private selectRecords(selector: RedactionSelector): EpisodicRecord[] {
    const records = this.episodic.all().filter((r) => r.state !== "redacted");
    if ("recordId" in selector) {
      const record = this.episodic.get(selector.recordId);
      return record && record.state !== "redacted" ? [record] : [];
    }
    if ("sessionId" in selector) {
      return records.filter((r) => r.sessionId === selector.sessionId);
    }
    if ("entity" in selector) {
      const norm = selector.entity.toLowerCase();
      return records.filter((r) => r.text.toLowerCase().includes(norm));
    }
    if ("originPrefix" in selector) {
      return records.filter((r) => r.origin?.startsWith(selector.originPrefix));
    }
    const re = new RegExp(selector.pattern, "i");
    return records.filter((r) => re.test(r.text));
  }

  /** Redaction audit trail (ids and counts only — no content). */
  auditTrail(): RedactionEvent[] {
    return [...this.auditLog.load().values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
  }
}

/**
 * Match a stored source entryId against a session turn's entryId.
 *
 * Source refs may carry a truncated id (older writes stored an 8-char prefix
 * while the session turn carries the full id), so a shorter stored ref matches
 * by prefix; equal-length refs must match exactly. Empty refs never match.
 */
function entryIdMatches(turnEntryId: string, storedEntryId: string): boolean {
  if (!storedEntryId || !turnEntryId) return false;
  if (storedEntryId.length < turnEntryId.length) {
    return turnEntryId.startsWith(storedEntryId);
  }
  return turnEntryId === storedEntryId;
}

/** Whether a pid refers to a live process (EPERM = alive but not ours). */
function readSessionId(filePath: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8").split("\n", 1)[0]) as {
      type?: unknown;
      version?: unknown;
      id?: unknown;
    };
    if (parsed.type === "session" && parsed.version === 3 && typeof parsed.id === "string") {
      return parsed.id;
    }
  } catch {
    // Non-v3 or unreadable files cannot justify any fact evidence.
  }
  return undefined;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Record/session ids are opaque and safe to keep; entity names and patterns
 * are the content the user wants forgotten, so only a digest is logged.
 */
function sanitizeSelector(
  selector: RedactionSelector,
): RedactionEvent["selector"] {
  const digest = (s: string) =>
    crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
  if ("recordId" in selector)
    return { type: "recordId", ref: selector.recordId };
  if ("sessionId" in selector)
    return { type: "sessionId", ref: selector.sessionId };
  if ("entity" in selector)
    return { type: "entity", ref: digest(selector.entity.toLowerCase()) };
  // An origin prefix is a file/domain pointer, not the forgotten content —
  // safe to keep verbatim, like recordId/sessionId.
  if ("originPrefix" in selector)
    return { type: "originPrefix", ref: selector.originPrefix };
  return { type: "pattern", ref: digest(selector.pattern) };
}
