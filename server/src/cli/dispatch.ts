import { ltmHealth, ltmReplay } from "./ltm-commands.ts";

const USAGE = `\
ytsejam CLI

Usage:
  ytsejam ltm replay [--force] [--rebuild] [--prune]
                                  Open LTM, run one reconcile pass, print JSON stats.
  ytsejam ltm health              Print LTM bridge health (one-off tick).

Notes:
  All ltm subcommands require the server to be STOPPED (LTM single-writer lock).
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
    return ltmReplay({ force, rebuild, prune });
  }

  if (sub === "health") {
    return ltmHealth({});
  }

  if (sub === "--help" || sub === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }

  process.stderr.write(`ytsejam ltm: unknown subcommand "${sub}"\n\n${USAGE}`);
  return 2;
}
