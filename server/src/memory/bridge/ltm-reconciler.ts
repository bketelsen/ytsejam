import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { MemorySystem } from "ltm";
import {
  parseObservationLine,
  computeOrigin,
  mirrorToLtm,
} from "./ltm-observer.ts";
import { skipMarkdownNoise } from "../consolidated/open-actions.ts";

type Logger = (level: "warn" | "info", msg: string, meta?: object) => void;

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

// Top-level entries that the reconciler must NOT walk. .git contains pack
// files (zero observations, lots of cost on every scan). glacier holds
// YAML-fronted archives that do not parse as raw observation lines and may
// already be represented in LTM via LTM's own consolidation path -- crossing
// the streams would mis-mirror cold storage as fresh observations.
const SKIP_TOP_LEVEL = new Set<string>(["glacier"]);

function isSkippableDir(name: string): boolean {
  // Hidden dirs (.git, .obsidian, .vscode, ...) plus the explicit skip set.
  if (name.startsWith(".")) return true;
  return SKIP_TOP_LEVEL.has(name);
}

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
 * - lines are split on /\r?\n/ and trimmed before hashing so CRLF files
 *   (from external editors / `git checkout core.autocrlf=true`) dedup
 *   against the live path's clean origins.
 * - skips dot-directories and `glacier/` (cold archives are out of scope).
 */
export class LtmReconciler {
  private readonly ltm: MemorySystem;
  private readonly dataDir: string;
  private readonly intervalMs: number;
  private readonly logger: Logger;
  private readonly mtimeCache = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private state: Health = {
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
        const args =
          meta === undefined ? [`${tag} ${msg}`] : [`${tag} ${msg}`, meta];
        if (level === "warn") console.warn(...args);
        else console.info(...args);
      });
  }

  start(): void {
    if (this.timer) return; // idempotent
    this.timer = setInterval(() => {
      void this.tickSafe();
    }, this.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
    // Kick off an immediate first tick so cold-restart back-fill doesn't
    // wait the full intervalMs. tickSafe() is idempotent (inFlight guard).
    void this.tickSafe();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlight) await this.inFlight;
  }

  /**
   * Returns a structurally cloned health snapshot. Mutating the returned
   * object (including its nested `lastTickStats`) does NOT mutate the
   * reconciler's internal state -- callers (CLI, server.health()) can
   * freely retain references.
   */
  health(): Health {
    const h = this.state;
    const snap: Health = {
      reachable: h.reachable,
      consecutiveFailures: h.consecutiveFailures,
    };
    if (h.lastError !== undefined)
      snap.lastError = { ...h.lastError };
    if (h.lastTickAt !== undefined) snap.lastTickAt = h.lastTickAt;
    if (h.lastTickStats !== undefined)
      snap.lastTickStats = { ...h.lastTickStats };
    return snap;
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
        // Split on /\r?\n/ AND trim each line so CRLF and trailing-whitespace
        // lines hash to the same origin as the live write path's clean lines.
        //
        // Noise classification mirrors the read-side parser
        // (consolidated/observations-parser.ts): the shared skipMarkdownNoise()
        // helper drops HTML comments and fenced code blocks (state must
        // persist across iterations — both can span multiple lines). Lines
        // that survive noise filtering but don't even look like a list item
        // (headings, prose, archive bookkeeping) are silently ignored too —
        // the read-side parser only warns on list items that fail to parse,
        // and the reconciler must agree (see issue #100). Only `- …` lines
        // reach processLine, where a truly malformed observation
        // (`- not-a-date [tag]: …`) still surfaces as a WARN.
        const state = { inComment: false, inFence: false };
        const rawLines = content.split(/\r?\n/);
        for (let i = 0; i < rawLines.length; i++) {
          const trimmed = rawLines[i]!.trim();
          if (!trimmed) continue;
          if (skipMarkdownNoise(trimmed, state)) continue;
          if (!trimmed.startsWith("- ")) continue;
          stats.scannedLines++;
          await this.processLine(file, trimmed, i, stats);
        }
        this.mtimeCache.set(file, st.mtimeMs);
      } catch (err) {
        this.bumpTickError(err as Error, stats);
      }
    }

    this.recordTick(stats);
    this.logger("info", "tick complete", {
      scannedFiles: stats.scannedFiles,
      scannedLines: stats.scannedLines,
      replayed: stats.replayed,
      skipped: stats.skipped,
      errors: stats.errors,
    });
    return stats;
  }

  private async processLine(
    file: string,
    line: string,
    lineNum: number,
    stats: ReconcileStats,
  ): Promise<void> {
    const split = this.splitFilePath(file);
    if (!split) {
      stats.errors++;
      this.logger("warn", `skipping observations.md at unexpected path`, {
        file,
      });
      return;
    }
    const { domainPath, filename } = split;
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
    // The reconciler bridges cog memory into LTM, so walk the cog memory
    // tree (<dataDir>/memory), not the whole data directory.
    const root = join(this.dataDir, "memory");
    const walk = async (dir: string, depth: number): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) {
          // Skip dot-directories at any depth and the configured top-level
          // skip set when we're directly under the cog memory root.
          if (e.name.startsWith(".")) continue;
          if (depth === 0 && SKIP_TOP_LEVEL.has(e.name)) continue;
          await walk(join(dir, e.name), depth + 1);
        } else if (e.isFile() && e.name === "observations.md") {
          results.push(join(dir, e.name));
        }
      }
    };
    // Use isSkippableDir for symmetry: root itself never gets checked
    // (we always descend it), but the helper documents the rule.
    void isSkippableDir;
    await walk(root, 0);
    return results;
  }

  /**
   * Split an absolute observations.md path into (domainPath, filename).
   * Returns null for paths that sit directly under the cog memory root with
   * no domain subdir -- a layout the cog memory contract does not produce,
   * so we skip rather than mint a garbage domainPath.
   */
  private splitFilePath(
    file: string,
  ): { domainPath: string; filename: string } | null {
    const memRoot = join(this.dataDir, "memory");
    const rel = file.startsWith(memRoot + "/")
      ? file.slice(memRoot.length + 1)
      : file;
    const lastSlash = rel.lastIndexOf("/");
    if (lastSlash <= 0) return null; // top-level or empty domain -> skip
    return {
      domainPath: rel.slice(0, lastSlash),
      filename: rel.slice(lastSlash + 1),
    };
  }

  private bumpTickError(err: Error, stats: ReconcileStats): void {
    stats.errors++;
    this.state.consecutiveFailures++;
    this.state.lastError = {
      message: err.message,
      at: new Date().toISOString(),
    };
    this.state.reachable = false;
    this.logger("warn", `tick error: ${err.message}`);
  }

  private recordTick(stats: ReconcileStats): void {
    this.state.lastTickAt = new Date().toISOString();
    this.state.lastTickStats = stats;
    if (stats.errors === 0) {
      this.state.consecutiveFailures = 0;
      this.state.reachable = true;
    }
  }
}
