/**
 * CLI: npm run eval [-- --seed 7 --sessions 16 --turns 12 --workdir .eval]
 * Generates fixtures, runs the full harness, prints the report, writes
 * report.json next to the generated corpus. Exits non-zero on failure.
 */

import path from "node:path";
import fs from "node:fs";
import { formatReport, runEval } from "./harness.ts";

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const workDir = path.resolve(argValue("workdir") ?? ".eval");
const report = await runEval({
  workDir,
  seed: argValue("seed") ? Number(argValue("seed")) : undefined,
  sessions: argValue("sessions") ? Number(argValue("sessions")) : undefined,
  turnsPerSession: argValue("turns") ? Number(argValue("turns")) : undefined,
});

fs.writeFileSync(path.join(workDir, "report.json"), JSON.stringify(report, null, 2));
console.log(formatReport(report));
console.log(`\nReport written to ${path.join(workDir, "report.json")}`);
process.exit(report.passed ? 0 : 1);
