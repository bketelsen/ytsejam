import fs from "node:fs";
import path from "node:path";

export interface BackfillJobOptions {
  ltm: {
    ingestSessionFile(p: string): Promise<{
      sessionsSeen: number;
      turnsIngested: number;
      recordsCreated: number;
      warnings: string[];
    }>;
  };
  dir: string;
  ratePerSec: number;
  batchSize: number;
  pauseMs: number;
  onProgress?: (s: {
    processed: number;
    total: number;
    lastSessionId?: string;
  }) => void;
}

export type BackfillStatus =
  | "pending"
  | "running"
  | "done"
  | "cancelled"
  | "failed";

/**
 * Process-local one-shot backfill engine for feeding archived pi v3 session
 * JSONLs into LTM without flooding the live server. The job is deliberately
 * small and in-memory: routes/CLI own lifecycle policy, while this class owns
 * walking, pacing, per-file isolation, cancellation checkpoints, and progress.
 *
 * Cancellation is observed only BETWEEN files — a mid-flight ingest, the
 * per-turn rate-sleep, and the per-batch pause all complete before the
 * next file's cancellation check. For most use cases this is fine
 * (files are small, rate is modest); callers needing instant cancel
 * should keep file batches small and pace conservatively.
 */
export class BackfillJob {
  readonly id: string;
  status: BackfillStatus = "pending";
  processed = 0;
  total = 0;
  lastSessionId: string | undefined;
  warnings: string[] = [];

  private readonly opts: BackfillJobOptions;
  private cancelRequested = false;

  constructor(opts: BackfillJobOptions) {
    this.opts = opts;
    this.id = `backfill-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)
      .padEnd(6, "0")}`;
  }

  cancel(): void {
    this.cancelRequested = true;
  }

  async run(): Promise<void> {
    // Single-shot: re-entry would re-ingest everything. The pending-cancellation
    // checkpoint below handles cancel() called before run() starts.
    if (this.status !== "pending") return;

    if (this.cancelRequested) {
      this.status = "cancelled";
      return;
    }
    this.status = "running";

    let files: string[];
    try {
      files = this.findJsonlFiles(this.opts.dir);
    } catch (err) {
      this.status = "failed";
      this.warnings.push(this.errorMessage(err));
      return;
    }

    this.total = files.length;
    let batchCount = 0;

    for (const file of files) {
      if (this.cancelRequested) {
        this.status = "cancelled";
        return;
      }

      const basename = path.basename(file);
      try {
        const result = await this.opts.ltm.ingestSessionFile(file);
        this.processed++;
        this.lastSessionId = basename;
        for (const warning of result.warnings) {
          this.warnings.push(`${basename}: ${warning}`);
        }
        this.opts.onProgress?.({
          processed: this.processed,
          total: this.total,
          lastSessionId: this.lastSessionId,
        });

        if (result.turnsIngested > 0 && this.opts.ratePerSec > 0) {
          await sleep((result.turnsIngested * 1000) / this.opts.ratePerSec);
        }
      } catch (err) {
        this.warnings.push(`${basename}: ${this.errorMessage(err)}`);
      }

      batchCount++;
      if (
        this.opts.batchSize > 0 &&
        batchCount % this.opts.batchSize === 0 &&
        this.opts.pauseMs > 0
      ) {
        await sleep(this.opts.pauseMs);
      }
    }

    this.status = "done";
  }

  private findJsonlFiles(root: string): string[] {
    const results: string[] = [];
    const walk = (dir: string): void => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const filepath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(filepath);
        } else if (
          entry.isFile() &&
          entry.name.endsWith(".jsonl") &&
          !entry.name.endsWith(".compactions.jsonl")
        ) {
          results.push(filepath);
        }
      }
    };
    walk(root);
    return results.sort();
  }

  private errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
