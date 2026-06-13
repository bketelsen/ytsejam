import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { MemorySystem } from "ltm";
import {
  parseObservationLine,
  computeOrigin,
  mirrorToLtm,
} from "./ltm-observer.ts";

type Logger = (level: "warn" | "info", msg: string, meta?: object) => void;

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export type ReconcileStats = {
  scannedFiles: number;
  scannedLines: number;
  replayed: number;
  skipped: number;
  errors: number;
};

export type Health = {
  reachable: boolean;
  lastError?: { message: string; at: string };
  consecutiveFailures: number;
  lastTickAt?: string;
  lastTickStats?: ReconcileStats;
};

/**
 * Periodically walks the cog memory tree looking for observations.md
 * lines that have not yet been mirrored to LTM (back-fill + external
 * hand-edit recovery). The live write path is the cog_append MCP tool
 * via memory.recordObservation; this reconciler is the safety net for
 * everything that bypassed it.
 *
 * - per-file mtime cache short-circuits unchanged files.
 * - per-line ltm.hasObservation(origin) dedups within a changed file.
 * - per-line errors are isolated (logged + counted, do not abort tick).
 * - tick-level errors (e.g. unreachable dataDir) bump consecutiveFailures.
 */
export class LtmReconciler {
  private readonly ltm: MemorySystem;
  private readonly dataDir: string;
  private readonly intervalMs: number;
  private readonly logger: Logger;
  private readonly mtimeCache = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private health_: Health = {
    reachable: true,
    consecutiveFailures: 0,
  };

  constructor(opts: {
    ltm: MemorySystem;
    dataDir: string;
    intervalMs?: number;
    logger?: Logger;
  }) {
    this.ltm = opts.ltm;
    this.dataDir = opts.dataDir;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.logger =
      opts.logger ??
      ((level, msg, meta) => {
        const tag = `[ltm-reconciler]`;
        if (level === "warn") console.warn(`${tag} ${msg}`, meta ?? "");
        else console.info(`${tag} ${msg}`, meta ?? "");
      });
  }

  start(): void {
    if (this.timer) return; // idempotent
    this.timer = setInterval(() => {
      void this.tickSafe();
    }, this.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlight) await this.inFlight;
  }

  health(): Health {
    return { ...this.health_ };
  }

  private async tickSafe(): Promise<void> {
    if (this.inFlight) return; // skip if previous tick still running
    this.inFlight = this.reconcile()
      .then(() => undefined)
      .catch((err) => {
        // reconcile() catches its own; this branch is belt-and-suspenders.
        this.logger("warn", `tick threw out-of-band: ${(err as Error).message}`);
      })
      .finally(() => {
        this.inFlight = null;
      });
    await this.inFlight;
  }

  async reconcile(opts?: { force?: boolean }): Promise<ReconcileStats> {
    const force = opts?.force ?? false;
    const stats: ReconcileStats = {
      scannedFiles: 0,
      scannedLines: 0,
      replayed: 0,
      skipped: 0,
      errors: 0,
    };

    let files: string[];
    try {
      files = await this.findObservationFiles();
    } catch (err) {
      this.bumpTickError(err as Error, stats);
      return stats;
    }

    for (const file of files) {
      try {
        const st = await stat(file);
        if (!force) {
          const cached = this.mtimeCache.get(file);
          if (cached !== undefined && st.mtimeMs <= cached) continue;
        }
        stats.scannedFiles++;
        const content = await readFile(file, "utf8");
        const lines = content.split("\n").filter((l) => l.trim().length > 0);
        for (let i = 0; i < lines.length; i++) {
          stats.scannedLines++;
          await this.processLine(file, lines[i]!, i, stats);
        }
        this.mtimeCache.set(file, st.mtimeMs);
      } catch (err) {
        this.bumpTickError(err as Error, stats);
      }
    }

    this.recordTick(stats);
    return stats;
  }

  private async processLine(
    file: string,
    line: string,
    lineNum: number,
    stats: ReconcileStats,
  ): Promise<void> {
    const { domainPath, filename } = this.splitFilePath(file);
    const parsed = parseObservationLine(line);
    if (!parsed) {
      stats.errors++;
      this.logger("warn", `malformed line skipped`, {
        file: `${domainPath}/${filename}`,
        line: lineNum + 1,
      });
      return;
    }
    const origin = computeOrigin(domainPath, filename, line);
    if (this.ltm.hasObservation(origin)) {
      stats.skipped++;
      return;
    }
    const result = await mirrorToLtm(this.ltm, parsed, origin);
    if (result.ok) {
      stats.replayed++;
    } else {
      stats.errors++;
      this.logger("warn", `mirror failed`, {
        origin,
        error: result.error.message,
      });
    }
  }

  private async findObservationFiles(): Promise<string[]> {
    const results: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile() && e.name === "observations.md") results.push(full);
      }
    };
    await walk(this.dataDir);
    return results;
  }

  private splitFilePath(file: string): { domainPath: string; filename: string } {
    const rel = file.startsWith(this.dataDir + "/")
      ? file.slice(this.dataDir.length + 1)
      : file;
    const lastSlash = rel.lastIndexOf("/");
    return {
      domainPath: rel.slice(0, lastSlash),
      filename: rel.slice(lastSlash + 1),
    };
  }

  private bumpTickError(err: Error, stats: ReconcileStats): void {
    stats.errors++;
    this.health_.consecutiveFailures++;
    this.health_.lastError = {
      message: err.message,
      at: new Date().toISOString(),
    };
    this.health_.reachable = false;
    this.logger("warn", `tick error: ${err.message}`);
  }

  private recordTick(stats: ReconcileStats): void {
    this.health_.lastTickAt = new Date().toISOString();
    this.health_.lastTickStats = stats;
    if (stats.errors === 0) {
      this.health_.consecutiveFailures = 0;
      this.health_.reachable = true;
    }
  }
}
