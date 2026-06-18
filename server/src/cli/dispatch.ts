import {
  ltmBackfill,
  ltmDoctor,
  ltmHealth,
  ltmPurgeFacts,
  ltmReplay,
} from "./ltm-commands.ts";

const USAGE = `\
ytsejam CLI

Usage:
  ytsejam ltm replay [--force] [--rebuild] [--prune] [--verbose|--quiet]
                                  Open LTM, run one reconcile pass, print JSON stats.
  ytsejam ltm health              Print LTM bridge health (one-off tick).
  ytsejam ltm doctor [--fix]      Store health checks; --fix compacts logs to one
                                  line per id. Run with the server STOPPED.
  ytsejam ltm purge-facts <dir>   Re-extract each active fact's source turn and
                                  tombstone facts the current extractor no longer
                                  produces. <dir> = pi v3 sessions dir. Server STOPPED.
  ytsejam ltm backfill <dir> [--rate=N] [--batch=N] [--pause-ms=N] [--poll-ms=N]
                                  Stream JSONLs in <dir> through LTM ingest via the
                                  running server. Polls progress; Ctrl-C cancels.
                                  Server MUST be running. Auth via YTSEJAM_API_TOKEN.

Notes:
  ltm replay, ltm health, ltm doctor --fix, and ltm purge-facts require the
  server to be STOPPED (LTM single-writer lock / safe compaction).
  Environment:
    YTSEJAM_DATA_DIR              Cog data root (default: ./data).
    LTM_STORE_DIR                 LTM store dir (default: <dataDir>/ltm).
`;

/**
 * Parse argv (already sliced past node+script) and dispatch.
 *
 * Returns:
 *   - number: an exit code; caller should process.exit with it.
 *   - null: argv does NOT match any CLI subcommand; caller should fall
 *     through to normal server boot.
 *
 * Recognised:
 *   [] -> null (boot the server)
 *   ["ltm", ...] -> always returns a number (we own the "ltm" namespace)
 *   ["--help" | "-h"] -> 0 with USAGE on stdout
 *   ["--version" | "-v"] -> null (server already prints version on boot; we
 *     don't duplicate it here, and we don't want to swallow it)
 */
export async function runCli(argv: string[]): Promise<number | null> {
  if (argv.length === 0) return null;

  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }

  if (argv[0] !== "ltm") return null;

  // Everything below this owns its exit code.
  if (argv.length === 1) {
    process.stderr.write(`ytsejam ltm: missing subcommand\n\n${USAGE}`);
    return 2;
  }

  const sub = argv[1];
  const rest = argv.slice(2);

  if (sub === "replay") {
    const force = rest.includes("--force");
    const rebuild = rest.includes("--rebuild");
    const prune = rest.includes("--prune");
    const verbose = rest.includes("--verbose");
    const quiet = rest.includes("--quiet");
    return ltmReplay({
      force,
      rebuild,
      prune,
      ...(verbose ? { verbose } : {}),
      ...(quiet ? { quiet } : {}),
    });
  }

  if (sub === "health") {
    return ltmHealth({});
  }

  if (sub === "doctor") {
    const fix = rest.includes("--fix");
    return ltmDoctor({ fix });
  }

  if (sub === "purge-facts") {
    const dir = rest.find((a) => !a.startsWith("--"));
    if (!dir) {
      process.stderr.write(
        `ytsejam ltm purge-facts: missing <sessions-dir>\n\n${USAGE}`,
      );
      return 2;
    }
    return ltmPurgeFacts({
      sessionsDir: dir,
      dryRun: rest.includes("--dry-run"),
      force: rest.includes("--force"),
    });
  }

  if (sub === "backfill") {
    const dir = rest.find((a) => !a.startsWith("--"));
    if (!dir) {
      process.stderr.write(`ytsejam ltm backfill: missing <dir>\n\n${USAGE}`);
      return 2;
    }
    const rate = parseFlag(rest, "--rate", 2);
    const batch = parseFlag(rest, "--batch", 10);
    const pauseMs = parseFlag(rest, "--pause-ms", 2000);
    const pollMs = parseFlag(rest, "--poll-ms", 5000);
    const abortController = new AbortController();
    process.on("SIGINT", () => abortController.abort());
    const exit = await ltmBackfill({
      dir,
      rate,
      batch,
      pauseMs,
      pollMs,
      abortSignal: abortController.signal,
    });
    return exit;
  }

  if (sub === "--help" || sub === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }

  process.stderr.write(`ytsejam ltm: unknown subcommand "${sub}"\n\n${USAGE}`);
  return 2;
}

function parseFlag(args: string[], name: string, defaultValue: number): number {
  const arg = args.find((a) => a.startsWith(`${name}=`));
  if (!arg) return defaultValue;
  const val = Number(arg.slice(name.length + 1));
  return Number.isFinite(val) && val > 0 ? val : defaultValue;
}
