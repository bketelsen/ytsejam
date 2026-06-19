import path from "node:path";
import { MemorySystem, runDoctor } from "ltm";
import { LtmReconciler } from "../memory/bridge/ltm-reconciler.ts";
import { createLtmEmbedder, parseLtmEmbedderMode } from "../memory/embedder.ts";
import { defaultPiAuthPath, PiAuthStore } from "../pi-auth.ts";

export interface LtmCliOpts {
  /** Override the data root; default: env YTSEJAM_DATA_DIR or "./data". */
  dataDir?: string;
  /** Override the LTM store dir; default: env LTM_STORE_DIR or <dataDir>/ltm. */
  ltmStoreDir?: string;
  /** For replay: ignore the mtime cache and re-scan every file. */
  force?: boolean;
  /** For replay: re-scan and re-embed already-mirrored observations. */
  rebuild?: boolean;
  /** For replay: with rebuild, tombstone orphan cog-origin observations. */
  prune?: boolean;
  /** For replay: surface info-level reconciler logs to stderr. */
  verbose?: boolean;
  /** For replay: suppress reconciler logs. */
  quiet?: boolean;
  /** Output sink (defaults to console). Test injection point. */
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export interface LtmBackfillOpts {
  /** Source directory of pi v3 session JSONLs (required). */
  dir: string;
  /** Per-turn ingest rate (turns/sec). Default 2. */
  rate?: number;
  /** Files per batch before pausing. Default 10. */
  batch?: number;
  /** Pause ms between batches. Default 2000. */
  pauseMs?: number;
  /** Polling interval ms. Default 5000. */
  pollMs?: number;
  /** Server base URL. Default $YTSEJAM_API_URL or http://127.0.0.1:9873. */
  baseUrl?: string;
  /** Auth token. Default $YTSEJAM_API_TOKEN. */
  token?: string;
  /** Output sink (test injection). Default console.log. */
  stdout?: (line: string) => void;
  /** Error sink (test injection). Default console.error. */
  stderr?: (line: string) => void;
  /** Fetch override (test injection). Default globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Optional AbortSignal — when fired, simulates SIGINT (sends DELETE). */
  abortSignal?: AbortSignal;
}

type Logger = (
  level: "warn" | "info" | "error",
  msg: string,
  meta?: object,
) => void;

type LogLevel = "quiet" | "warn" | "info";

function makeCliLogger(level: LogLevel, err: (line: string) => void): Logger {
  return (lvl, msg, meta) => {
    if (level === "quiet") return;
    if (lvl === "info" && level === "warn") return;
    if (lvl === "info" || lvl === "warn" || lvl === "error") {
      const prefix = lvl === "info" ? "[ltm replay]" : `[ltm replay] [${lvl}]`;
      const out = meta
        ? `${prefix} ${msg} ${JSON.stringify(meta)}`
        : `${prefix} ${msg}`;
      err(out);
    }
  };
}

function resolveDirs(opts: LtmCliOpts): {
  dataDir: string;
  ltmStoreDir: string;
} {
  const dataDir = path.resolve(
    opts.dataDir ?? process.env.YTSEJAM_DATA_DIR ?? "./data",
  );
  const ltmStoreDir =
    opts.ltmStoreDir || process.env.LTM_STORE_DIR || path.join(dataDir, "ltm");
  return { dataDir, ltmStoreDir };
}

/**
 * Open LTM, run one reconcile pass, print JSON stats, exit.
 *
 * Exit codes:
 *   0 = stats.errors === 0
 *   1 = stats.errors > 0  OR  LTM could not be opened (server lock, fs perms,
 *       missing dir). All failure modes print a clear stderr message.
 *
 * NOTE: This command opens LTM directly. If the ytsejam server is running
 * and already holds the storeDir's single-writer lock, this WILL fail. Stop
 * the server first, or wait for a future "ltm replay via HTTP" subcommand.
 */
export async function ltmReplay(opts: LtmCliOpts = {}): Promise<number> {
  const out = opts.stdout ?? ((line) => console.log(line));
  const err = opts.stderr ?? ((line) => console.error(line));
  const rebuild = opts.rebuild ?? false;
  let prune = opts.prune ?? false;
  if (opts.verbose && opts.quiet) {
    err("[ltm replay] --verbose and --quiet are mutually exclusive");
    return 2;
  }
  const logLevel: LogLevel = opts.quiet
    ? "quiet"
    : opts.verbose
      ? "info"
      : "warn";
  if (prune && !rebuild) {
    err("[ltm replay] --prune requires --rebuild; ignoring prune");
    prune = false;
  }
  const { dataDir, ltmStoreDir } = resolveDirs(opts);

  const mode = (() => {
    try {
      return parseLtmEmbedderMode(process.env.YTSEJAM_LTM_EMBEDDER);
    } catch (e) {
      err(`[ltm replay] invalid embedder config: ${(e as Error).message}`);
      return null;
    }
  })();
  if (!mode) return 1;

  const authStore = new PiAuthStore(
    process.env.YTSEJAM_PI_AUTH ?? defaultPiAuthPath(),
  );
  const embedderResult = await createLtmEmbedder(authStore, {
    mode,
    cacheDir: path.join(ltmStoreDir, "embed-cache"),
    copilot: {
      model: process.env.YTSEJAM_LTM_COPILOT_MODEL,
      baseUrl: process.env.YTSEJAM_LTM_COPILOT_URL,
    },
    ollama: {
      model: process.env.YTSEJAM_LTM_OLLAMA_MODEL,
      baseUrl: process.env.YTSEJAM_LTM_OLLAMA_URL,
    },
  }).catch((e: Error) => {
    err(`[ltm replay] could not create LTM embedder: ${e.message}`);
    return null;
  });
  if (!embedderResult) return 1;

  let ltm: MemorySystem;
  try {
    // Replay intentionally skips dimension-mismatch refusal: its purpose is
    // to rewrite the index with the selected embedder, especially after a
    // server startup refusal.
    ltm = MemorySystem.open({
      storeDir: ltmStoreDir,
      embedder: embedderResult.embedder,
    });
  } catch (e) {
    err(
      `[ltm replay] could not open LTM at ${ltmStoreDir}\n` +
        `  ${(e as Error).message}\n` +
        `  If the ytsejam server is running it already holds the single-writer\n` +
        `  lock on this store. Stop the server (systemctl --user stop ytsejam)\n` +
        `  before running this command, or query the server's health endpoint.`,
    );
    return 1;
  }

  try {
    const reconciler = new LtmReconciler({
      ltm,
      dataDir,
      // Surface warns and errors to stderr so the JSON stats aren't the only
      // signal of trouble. Info-level (tick-complete summary) remains suppressed
      // by default because the CLI already prints stats explicitly; --verbose
      // sends info to stderr too so JSON on stdout stays clean.
      logger: makeCliLogger(logLevel, err),
    });
    const stats = await reconciler.reconcile({
      force: opts.force ?? false,
      rebuild,
      prune,
    });
    out(JSON.stringify(stats, null, 2));
    return stats.errors > 0 ? 1 : 0;
  } finally {
    try {
      ltm.close();
    } catch {
      // already-failed reconcile leaves LTM in a closeable state; if even
      // close() throws the lock is already gone via the process exit.
    }
  }
}

/**
 * Run raw LTM store health checks. With --fix, compact logs only while the
 * server is stopped so it cannot write concurrently.
 */
export async function ltmDoctor(
  opts: LtmCliOpts & { fix?: boolean } = {},
): Promise<number> {
  const out = opts.stdout ?? ((line) => console.log(line));
  const err = opts.stderr ?? ((line) => console.error(line));
  const { ltmStoreDir } = resolveDirs(opts);
  void err;
  return runDoctor(ltmStoreDir, { fix: opts.fix ?? false }, out);
}

/**
 * Open LTM and tombstone active facts the current extractor no longer
 * reproduces from their source turns. Requires the server to be stopped.
 */
export async function ltmPurgeFacts(
  opts: LtmCliOpts & { sessionsDir?: string; dryRun?: boolean } = {},
): Promise<number> {
  const out = opts.stdout ?? ((line) => console.log(line));
  const err = opts.stderr ?? ((line) => console.error(line));
  const sessionsDir = opts.sessionsDir;
  if (!sessionsDir) {
    err("purge-facts: <sessions-dir> is required");
    return 2;
  }
  const { dataDir, ltmStoreDir } = resolveDirs(opts);
  void dataDir;

  const mode = (() => {
    try {
      return parseLtmEmbedderMode(process.env.YTSEJAM_LTM_EMBEDDER);
    } catch (e) {
      err(`[ltm purge-facts] invalid embedder config: ${(e as Error).message}`);
      return null;
    }
  })();
  if (!mode) return 1;

  const authStore = new PiAuthStore(
    process.env.YTSEJAM_PI_AUTH ?? defaultPiAuthPath(),
  );
  const embedderResult = await createLtmEmbedder(authStore, {
    mode,
    cacheDir: path.join(ltmStoreDir, "embed-cache"),
    copilot: {
      model: process.env.YTSEJAM_LTM_COPILOT_MODEL,
      baseUrl: process.env.YTSEJAM_LTM_COPILOT_URL,
    },
    ollama: {
      model: process.env.YTSEJAM_LTM_OLLAMA_MODEL,
      baseUrl: process.env.YTSEJAM_LTM_OLLAMA_URL,
    },
  }).catch((e: Error) => {
    err(`[ltm purge-facts] could not create LTM embedder: ${e.message}`);
    return null;
  });
  if (!embedderResult) return 1;

  let ltm: MemorySystem;
  try {
    ltm = MemorySystem.open({
      storeDir: ltmStoreDir,
      embedder: embedderResult.embedder,
    });
  } catch (e) {
    err(
      `[ltm purge-facts] could not open LTM at ${ltmStoreDir}\n` +
        `  ${(e as Error).message}\n` +
        `  If the ytsejam server is running it already holds the single-writer\n` +
        `  lock on this store. Stop the server (systemctl --user stop ytsejam)\n` +
        `  before running this command, or query the server's health endpoint.`,
    );
    return 1;
  }

  try {
    const dryRun = (opts as { dryRun?: boolean }).dryRun ?? false;
    const result = await ltm.purgeStaleFacts(sessionsDir, {
      dryRun,
      // --force lifts the mass-redaction circuit-breaker (1 = no limit).
      maxPurgeFraction: opts.force ? 1 : undefined,
    });
    if (result.aborted) {
      err(
        `[ltm purge-facts] ABORTED — would redact ${Math.round(
          result.aborted.fraction * 100,
        )}% of ${result.aborted.active} active facts ` +
          `(limit ${Math.round(result.aborted.limit * 100)}%). Nothing was changed.\n` +
          `  This usually means the session sources could not be read (wrong\n` +
          `  <sessions-dir>, or facts whose source turns are gone), NOT that the\n` +
          `  facts are actually stale. Verify <sessions-dir> points at the real\n` +
          `  sessions tree, re-run with --dry-run to inspect, and only pass\n` +
          `  --force if you are certain a large redaction is correct.`,
      );
      return 1;
    }
    out(
      `${dryRun ? "[dry-run] would keep" : "kept"} ${result.kept}, ` +
        `${dryRun ? "would purge" : "purged"} ${result.purged.length}`,
    );
    for (const id of result.purged) out(id);
    return 0;
  } finally {
    try {
      ltm.close();
    } catch {
      // already-failed purge leaves LTM in a closeable state; if even
      // close() throws the lock is already gone via the process exit.
    }
  }
}

/**
 * Print the LTM bridge health JSON. For now this is a thin alias for
 * `ltm replay` without --force: opens LTM, runs one tick, prints the
 * resulting stats (which mirror what the server's health endpoint would
 * report after that tick). The "live server health" use case requires
 * the server to be running and should hit the server's health endpoint.
 */
export async function ltmHealth(opts: LtmCliOpts = {}): Promise<number> {
  const err = opts.stderr ?? ((line) => console.error(line));
  err(
    `[ltm health] CLI prints stats from a one-off reconcile tick.\n` +
      `  For live server-process health use the server's health endpoint\n` +
      `  (the server must be running; this CLI command requires it stopped).`,
  );
  return ltmReplay({ ...opts, force: false });
}

export async function ltmBackfill(opts: LtmBackfillOpts): Promise<number> {
  const out = opts.stdout ?? ((line) => console.log(line));
  const err = opts.stderr ?? ((line) => console.error(line));
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const dir = opts.dir;
  if (!dir) {
    err("backfill: <dir> is required");
    return 2;
  }
  const token = opts.token ?? process.env.YTSEJAM_API_TOKEN;
  if (!token) {
    err("backfill: YTSEJAM_API_TOKEN not set");
    return 2;
  }
  const baseUrl =
    opts.baseUrl ?? process.env.YTSEJAM_API_URL ?? "http://127.0.0.1:9873";
  const rate = opts.rate ?? 2;
  const batch = opts.batch ?? 10;
  const pauseMs = opts.pauseMs ?? 2000;
  const pollMs = opts.pollMs ?? 5000;

  const postRes = await fetchFn(`${baseUrl}/api/admin/ltm-backfill`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ dir, ratePerSec: rate, batchSize: batch, pauseMs }),
  });
  if (!postRes.ok) {
    err(`backfill: POST failed ${postRes.status}: ${await postRes.text()}`);
    return 1;
  }
  const { jobId } = (await postRes.json()) as { jobId: string };
  out(
    `backfill: started ${jobId} (dir=${dir} rate=${rate}/s batch=${batch} pause=${pauseMs}ms)`,
  );

  let cancelRequested = false;
  const onAbort = () => {
    if (cancelRequested) return;
    cancelRequested = true;
    void fetchFn(`${baseUrl}/api/admin/ltm-backfill/${jobId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    }).catch(() => {
      // best-effort cancel
    });
    out("");
    out("backfill: cancel requested, waiting for terminal status...");
  };
  opts.abortSignal?.addEventListener("abort", onAbort);

  try {
    while (true) {
      await sleep(pollMs);
      const getRes = await fetchFn(
        `${baseUrl}/api/admin/ltm-backfill/${jobId}`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      );
      if (!getRes.ok) {
        err(`backfill: GET failed ${getRes.status}`);
        return 1;
      }
      const s = (await getRes.json()) as {
        processed: number;
        total: number;
        lastSessionId?: string;
        status: string;
        warnings: string[];
      };
      out(
        `[${s.processed}/${s.total}] last: ${s.lastSessionId ?? "-"} (${s.warnings.length} warnings) status=${s.status}`,
      );
      if (
        s.status === "done" ||
        s.status === "cancelled" ||
        s.status === "failed"
      ) {
        out(`backfill: ${s.status}. ${s.warnings.length} warnings.`);
        for (const w of s.warnings.slice(0, 10)) out(`  ${w}`);
        return s.status === "done" ? 0 : 1;
      }
    }
  } finally {
    opts.abortSignal?.removeEventListener("abort", onAbort);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
