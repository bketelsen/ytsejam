/**
 * Ingestion pipeline: ytsejam session JSONL → turns → chunks → embeddings →
 * episodic records + semantic facts. Incremental: per-session ingested entry
 * ids are tracked in ingest-state.json, so re-running over a live store only
 * processes new entries.
 */

import fs from "node:fs";
import path from "node:path";
import type { EpisodicRecord, LtmConfig, Turn } from "../types.ts";
import type { Embedder } from "../embedding/embedder.ts";
import { chunkText } from "../episodic/chunk.ts";
import { scoreSalience } from "../episodic/salience.ts";
import type { EpisodicStore } from "../episodic/store.ts";
import type { SemanticStore } from "../semantic/store.ts";
import { listSessionFiles, readSessionFile, type ReadSessionOptions } from "../session/reader.ts";

interface IngestState {
  sessions: Record<string, { path: string; entryIds: string[] }>;
}

export interface IngestReport {
  sessionsSeen: number;
  turnsIngested: number;
  recordsCreated: number;
  warnings: string[];
}

export interface IngestDeps {
  storeDir: string;
  episodic: EpisodicStore;
  semantic: SemanticStore;
  embedder: Embedder;
  config: LtmConfig;
  readOptions?: ReadSessionOptions;
}

export class IngestPipeline {
  private readonly deps: IngestDeps;
  private state: IngestState;
  private readonly statePath: string;

  constructor(deps: IngestDeps) {
    this.deps = deps;
    this.statePath = path.join(deps.storeDir, "ingest-state.json");
    this.state = this.loadState();
  }

  private loadState(): IngestState {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as IngestState;
      if (parsed && typeof parsed === "object" && parsed.sessions) return parsed;
    } catch {
      // fresh store
    }
    return { sessions: {} };
  }

  private saveState(): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }

  async ingestFile(filePath: string): Promise<IngestReport> {
    const session = readSessionFile(filePath, this.deps.readOptions);
    const seen = new Set(this.state.sessions[session.sessionId]?.entryIds ?? []);
    const report: IngestReport = {
      sessionsSeen: 1,
      turnsIngested: 0,
      recordsCreated: 0,
      warnings: session.warnings,
    };

    const newRecords: EpisodicRecord[] = [];
    for (const turn of session.turns) {
      if (seen.has(turn.entryId)) continue;
      seen.add(turn.entryId);
      report.turnsIngested++;

      this.deps.semantic.ingestTurn(turn);
      newRecords.push(...(await this.turnToRecords(turn)));
    }

    if (newRecords.length > 0) {
      this.deps.episodic.upsertMany(newRecords);
      report.recordsCreated = newRecords.length;
    }
    this.state.sessions[session.sessionId] = { path: filePath, entryIds: [...seen] };
    this.saveState();
    return report;
  }

  async ingestDir(dir: string): Promise<IngestReport> {
    const totals: IngestReport = { sessionsSeen: 0, turnsIngested: 0, recordsCreated: 0, warnings: [] };
    for (const file of listSessionFiles(dir)) {
      try {
        const report = await this.ingestFile(file);
        totals.sessionsSeen += report.sessionsSeen;
        totals.turnsIngested += report.turnsIngested;
        totals.recordsCreated += report.recordsCreated;
        totals.warnings.push(...report.warnings.map((w) => `${path.basename(file)}: ${w}`));
      } catch (error) {
        totals.warnings.push(`${path.basename(file)}: ${(error as Error).message}`);
      }
    }
    return totals;
  }

  private async turnToRecords(turn: Turn): Promise<EpisodicRecord[]> {
    const { embedder, config } = this.deps;
    const chunks = chunkText(turn.text, config.maxChunkChars);
    const records: EpisodicRecord[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const text = chunks[i];
      records.push({
        id: `${turn.sessionId}/${turn.entryId}#${i}`,
        kind: "turn",
        sessionId: turn.sessionId,
        entryId: turn.entryId,
        role: turn.role,
        text,
        timestamp: turn.timestamp,
        salience: scoreSalience(text, turn.role),
        accessCount: 0,
        state: "active",
        embedding: await embedder.embed(text),
      });
    }
    return records;
  }
}
