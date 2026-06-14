/**
 * Episodic memory store: turn-level records persisted to episodic.jsonl
 * (latest-wins snapshots via JsonlLog). Embeddings ride along on the record
 * so the vector index rebuilds from the log without re-embedding.
 */

import path from "node:path";
import type { EpisodicRecord } from "../types.ts";
import { JsonlLog } from "../store/jsonl-log.ts";

export class EpisodicStore {
  private records: Map<string, EpisodicRecord>;
  private log: JsonlLog<EpisodicRecord>;

  private constructor(
    log: JsonlLog<EpisodicRecord>,
    records: Map<string, EpisodicRecord>,
  ) {
    this.log = log;
    this.records = records;
  }

  static open(storeDir: string): EpisodicStore {
    const log = new JsonlLog<EpisodicRecord>(
      path.join(storeDir, "episodic.jsonl"),
    );
    return new EpisodicStore(log, log.load());
  }

  get(id: string): EpisodicRecord | undefined {
    return this.records.get(id);
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  all(): EpisodicRecord[] {
    return [...this.records.values()];
  }

  /** Records eligible for retrieval by default. */
  active(): EpisodicRecord[] {
    return this.all().filter((r) => r.state === "active");
  }

  get size(): number {
    return this.records.size;
  }

  upsert(record: EpisodicRecord): void {
    this.records.set(record.id, record);
    this.log.append(record);
  }

  upsertMany(records: EpisodicRecord[]): void {
    for (const r of records) this.records.set(r.id, r);
    this.log.appendMany(records);
  }

  /**
   * Record a retrieval access. The in-memory count always updates; the log
   * snapshot is appended only when the new count is a power of two, so log
   * growth per record is O(log accesses) instead of one line per retrieval
   * (PLAN.md Task 2.6). Worst case on crash, a record loses the bumps since
   * its last power of two — access counts are a decay heuristic, not
   * accounting, so halved-at-worst is fine.
   */
  bumpAccess(id: string, now: string): void {
    const r = this.records.get(id);
    if (!r) return;
    const updated = {
      ...r,
      accessCount: r.accessCount + 1,
      lastAccessedAt: now,
    };
    this.records.set(id, updated);
    if ((updated.accessCount & (updated.accessCount - 1)) === 0) {
      this.log.append(updated);
    }
  }

  /**
   * Tombstone a record: content and embedding are dropped; id, provenance
   * pointers, and state remain so the audit trail and consolidation
   * bookkeeping stay coherent. The JSONL log is compacted immediately so the
   * redacted text does not survive on disk in superseded lines.
   */
  redact(id: string): boolean {
    const r = this.records.get(id);
    if (!r || r.state === "redacted") return false;
    const tombstone: EpisodicRecord = {
      id: r.id,
      kind: r.kind,
      sessionId: r.sessionId,
      entryId: r.entryId,
      sourceIds: r.sourceIds,
      role: r.role,
      text: "",
      timestamp: r.timestamp,
      salience: 0,
      accessCount: r.accessCount,
      lastAccessedAt: r.lastAccessedAt,
      state: "redacted",
    };
    this.records.set(id, tombstone);
    this.log.compact(this.records.values());
    return true;
  }

  /**
   * Tombstone many records in one pass: per-record state transition is
   * identical to redact(), but the JSONL log is compacted ONCE at the end
   * rather than per record. Returns the count of records actually
   * tombstoned (already-redacted ids are skipped, not counted).
   *
   * Use for bulk-cleanup paths (e.g. reconciler prune) where calling
   * redact() N times would do N full-file rewrites.
   */
  redactMany(ids: Iterable<string>): number {
    let count = 0;
    for (const id of ids) {
      const r = this.records.get(id);
      if (!r || r.state === "redacted") continue;
      const tombstone: EpisodicRecord = {
        id: r.id,
        kind: r.kind,
        sessionId: r.sessionId,
        entryId: r.entryId,
        sourceIds: r.sourceIds,
        role: r.role,
        text: "",
        timestamp: r.timestamp,
        salience: 0,
        accessCount: r.accessCount,
        lastAccessedAt: r.lastAccessedAt,
        state: "redacted",
      };
      this.records.set(id, tombstone);
      count++;
    }
    if (count > 0) this.log.compact(this.records.values());
    return count;
  }
}
