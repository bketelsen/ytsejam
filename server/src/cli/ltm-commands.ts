import path from "node:path";
import { MemorySystem } from "ltm";
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
  /** Output sink (defaults to console). Test injection point. */
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
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
      // signal of trouble. Info-level (tick-complete summary) is intentionally
      // suppressed because the CLI already prints stats explicitly.
      logger: (level, msg, ctx) => {
        if (level === "info") return;
        const tail = ctx ? ` ${JSON.stringify(ctx)}` : "";
        err(`[ltm replay] [${level}] ${msg}${tail}`);
      },
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
