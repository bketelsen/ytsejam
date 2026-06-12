/**
 * MemorySystem — the public facade. Owns the episodic and semantic stores,
 * the ingestion pipeline, the derived indexes/graph, and the user-control
 * surface (inspect / explain / redact / export).
 *
 * Lifecycle: open() loads the JSONL store and rebuilds derived state;
 * ingest*() pulls new session entries in; retrieve()/composeContext() serve
 * per-turn context; consolidate() runs the decay-driven maintenance pass.
 */

import crypto from "node:crypto";
import path from "node:path";
import type {
  EntityRecord,
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
} from "../types.ts";
import { mergeConfig, type LtmConfigPatch } from "../types.ts";
import { HashEmbedder, type Embedder } from "../embedding/embedder.ts";
import { EpisodicStore } from "../episodic/store.ts";
import { consolidate, extractiveSummary, type Summarizer } from "../episodic/consolidate.ts";
import { retention } from "../episodic/decay.ts";
import { SemanticStore } from "../semantic/store.ts";
import { PreferenceGraph } from "../semantic/graph.ts";
import { Retriever, packToBudget } from "../retrieval/retriever.ts";
import { IngestPipeline, type IngestReport } from "../pipeline/ingest.ts";
import { JsonlLog } from "../store/jsonl-log.ts";
import type { ReadSessionOptions } from "../session/reader.ts";

export interface MemorySystemOptions {
  /** Directory for the memory store's JSONL files. */
  storeDir: string;
  embedder?: Embedder;
  config?: LtmConfigPatch;
  summarizer?: Summarizer;
  readOptions?: ReadSessionOptions;
  /** Clock override (ISO timestamp) for deterministic tests/evals. */
  now?: () => string;
}

interface AuditRecord extends RedactionEvent {
  id: string;
}

export class MemorySystem {
  readonly config: LtmConfig;
  private readonly storeDir: string;
  private readonly embedder: Embedder;
  private readonly summarizer: Summarizer;
  private readonly episodic: EpisodicStore;
  private readonly semantic: SemanticStore;
  private readonly pipeline: IngestPipeline;
  private readonly auditLog: JsonlLog<AuditRecord>;
  private retriever: Retriever;
  private graph: PreferenceGraph;
  private readonly clock: () => string;
  private auditSeq = 0;

  private constructor(opts: MemorySystemOptions) {
    this.storeDir = opts.storeDir;
    this.config = mergeConfig(opts.config);
    this.embedder = opts.embedder ?? new HashEmbedder();
    this.summarizer = opts.summarizer ?? extractiveSummary;
    this.clock = opts.now ?? (() => new Date().toISOString());
    this.episodic = EpisodicStore.open(this.storeDir);
    this.semantic = SemanticStore.open(this.storeDir);
    this.auditLog = new JsonlLog<AuditRecord>(path.join(this.storeDir, "redactions.jsonl"));
    this.auditSeq = this.auditLog.load().size;
    this.pipeline = new IngestPipeline({
      storeDir: this.storeDir,
      episodic: this.episodic,
      semantic: this.semantic,
      embedder: this.embedder,
      config: this.config,
      readOptions: opts.readOptions,
    });
    this.graph = this.rebuildGraph();
    this.retriever = new Retriever({
      store: this.episodic,
      embedder: this.embedder,
      graph: this.graph,
      config: this.config,
    });
  }

  static open(opts: MemorySystemOptions): MemorySystem {
    return new MemorySystem(opts);
  }

  private rebuildGraph(): PreferenceGraph {
    this.graph = PreferenceGraph.build(this.semantic.allFacts(), this.episodic.all());
    return this.graph;
  }

  /** Rebuild every derived structure after a mutation of the stores. */
  private rebuildDerived(): void {
    this.rebuildGraph();
    this.retriever = new Retriever({
      store: this.episodic,
      embedder: this.embedder,
      graph: this.graph,
      config: this.config,
    });
  }

  // -- ingestion ------------------------------------------------------------

  async ingestSessionFile(filePath: string): Promise<IngestReport> {
    const report = await this.pipeline.ingestFile(filePath);
    if (report.recordsCreated > 0 || report.turnsIngested > 0) this.rebuildDerived();
    return report;
  }

  async ingestSessionDir(dir: string): Promise<IngestReport> {
    const report = await this.pipeline.ingestDir(dir);
    if (report.recordsCreated > 0 || report.turnsIngested > 0) this.rebuildDerived();
    return report;
  }

  // -- retrieval ------------------------------------------------------------

  async retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrievalResult> {
    const now = opts.now ?? this.clock();
    const k = opts.k ?? 8;
    const ranked = await this.retriever.rank(query, k, now, opts.includeConsolidated ?? false);
    const items = packToBudget(ranked, opts.tokenBudget ?? 1200);
    if (!opts.dryRun) {
      for (const item of items) {
        this.episodic.bumpAccess(item.record.id, now);
      }
    }
    return { items, profile: this.semantic.profile(now, this.config.profile) };
  }

  /**
   * Render a retrieval result as a system-prompt-ready context block:
   * the user profile (identity, preferences, directives) followed by
   * relevant episodic memories with their dates.
   */
  async composeContext(query: string, opts: RetrieveOptions = {}): Promise<string> {
    const { items, profile } = await this.retrieve(query, opts);
    const lines: string[] = [];

    const factLine = (f: SemanticFact) =>
      `- ${f.predicate === "directive" ? (f.polarity > 0 ? "always" : "never") : f.predicate}${
        f.kind === "preference" && f.polarity < 0 ? " (dislikes)" : ""
      }: ${f.object}`;

    if (profile.identity.length || profile.preferences.length || profile.directives.length || profile.attributes.length) {
      lines.push("## What you know about the user");
      for (const f of [...profile.identity, ...profile.attributes]) lines.push(factLine(f));
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
        const who = item.record.role === "summary" ? "summary" : item.record.role;
        lines.push(`- [${date}, ${who}] ${item.record.text}`);
      }
    }

    return lines.join("\n").trim();
  }

  profile(now?: string): ProfileSummary {
    return this.semantic.profile(now ?? this.clock(), this.config.profile);
  }

  // -- maintenance ------------------------------------------------------------

  async consolidate(opts: { now?: string } = {}): Promise<{ created: number; folded: number }> {
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
    return { created: result.created.length, folded: result.consolidatedChildren };
  }

  // -- inspection (user control surface) --------------------------------------

  listEpisodic(filter: { sessionId?: string; state?: EpisodicRecord["state"] } = {}): EpisodicRecord[] {
    return this.episodic
      .all()
      .filter((r) => (filter.sessionId ? r.sessionId === filter.sessionId : true))
      .filter((r) => (filter.state ? r.state === filter.state : true))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  listFacts(): SemanticFact[] {
    return this.semantic.allFacts();
  }

  listEntities(): EntityRecord[] {
    return this.semantic.allEntities();
  }

  getRecord(id: string): EpisodicRecord | undefined {
    return this.episodic.get(id);
  }

  /** Why would this query surface these memories? Ranked with score breakdowns; read-only. */
  async explain(query: string, k = 8): Promise<RetrievedMemory[]> {
    return this.retriever.rank(query, k, this.clock(), true);
  }

  stats(now?: string): {
    episodic: { total: number; active: number; consolidated: number; redacted: number; meanRetention: number };
    facts: { total: number; active: number };
    entities: { total: number; active: number };
  } {
    const at = now ?? this.clock();
    const records = this.episodic.all();
    const active = records.filter((r) => r.state === "active");
    const meanRetention = active.length
      ? active.reduce((sum, r) => sum + retention(r, at, this.config.decay), 0) / active.length
      : 0;
    return {
      episodic: {
        total: records.length,
        active: active.length,
        consolidated: records.filter((r) => r.state === "consolidated").length,
        redacted: records.filter((r) => r.state === "redacted").length,
        meanRetention,
      },
      facts: { total: this.semantic.allFacts().length, active: this.semantic.activeFacts().length },
      entities: { total: this.semantic.allEntities().length, active: this.semantic.activeEntities().length },
    };
  }

  /** Full dump for user transparency/export. */
  export(): { episodic: EpisodicRecord[]; facts: SemanticFact[]; entities: EntityRecord[] } {
    return {
      episodic: this.episodic.all().map((r) => ({ ...r, embedding: undefined })),
      facts: this.semantic.allFacts(),
      entities: this.semantic.allEntities(),
    };
  }

  // -- redaction ---------------------------------------------------------------

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
      entitiesRedacted: 0,
      consolidatedRebuilt: 0,
    };

    const targets = this.selectRecords(selector);
    const redactedSources: SourceRef[] = [];
    for (const record of targets) {
      if (this.episodic.redact(record.id)) {
        result.episodicRedacted++;
        if (record.entryId) {
          redactedSources.push({ sessionId: record.sessionId, entryId: record.entryId });
        }
      }
    }

    // Propagate to semantic memory.
    if ("entity" in selector) {
      const r = this.semantic.redactEntity(selector.entity);
      result.factsRedacted += r.facts;
      result.entitiesRedacted += r.entities;
    }
    if (redactedSources.length > 0) {
      const keys = new Set(redactedSources.map((s) => `${s.sessionId}/${s.entryId}`));
      const r = this.semantic.redactBySources((s) => keys.has(`${s.sessionId}/${s.entryId}`));
      result.factsRedacted += r.facts;
      result.entitiesRedacted += r.entities;
    }

    // Rebuild consolidated summaries that included a redacted child.
    const redactedIds = new Set(targets.map((t) => t.id));
    for (const summary of this.episodic.all()) {
      if (summary.kind !== "consolidated" || summary.state !== "active") continue;
      if (!summary.sourceIds?.some((id) => redactedIds.has(id))) continue;
      const survivors = (summary.sourceIds ?? [])
        .filter((id) => !redactedIds.has(id))
        .map((id) => this.episodic.get(id))
        .filter((r): r is EpisodicRecord => !!r && r.state !== "redacted" && !!r.text);
      this.episodic.redact(summary.id);
      if (survivors.length >= 2) {
        const text = (await this.summarizer(survivors, this.config.consolidation.maxSummaryChars)).trim();
        if (text) {
          this.episodic.upsert({
            ...summary,
            id: `${summary.id}-r${this.auditSeq}`,
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
    const re = new RegExp(selector.pattern, "i");
    return records.filter((r) => re.test(r.text));
  }

  /** Redaction audit trail (ids and counts only — no content). */
  auditTrail(): RedactionEvent[] {
    return [...this.auditLog.load().values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}

/**
 * Record/session ids are opaque and safe to keep; entity names and patterns
 * are the content the user wants forgotten, so only a digest is logged.
 */
function sanitizeSelector(selector: RedactionSelector): RedactionEvent["selector"] {
  const digest = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
  if ("recordId" in selector) return { type: "recordId", ref: selector.recordId };
  if ("sessionId" in selector) return { type: "sessionId", ref: selector.sessionId };
  if ("entity" in selector) return { type: "entity", ref: digest(selector.entity.toLowerCase()) };
  return { type: "pattern", ref: digest(selector.pattern) };
}
