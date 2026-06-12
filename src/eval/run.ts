/**
 * CLI: npm run eval [-- --seed 7 --band short|medium|long --workdir .eval]
 * Default runs ALL bands (short/medium/long), prints per-band reports and a
 * summary table, writes report.json. Exits non-zero if any band fails its
 * thresholds.
 */

import path from "node:path";
import fs from "node:fs";
import { formatBandedResult, formatReport, runAllBands, runEval, type EvalBand } from "./harness.ts";

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const workDir = path.resolve(argValue("workdir") ?? ".eval");
const seed = argValue("seed") ? Number(argValue("seed")) : undefined;
const band = argValue("band") as EvalBand | undefined;

if (band) {
  const report = await runEval({ workDir, seed, band });
  fs.writeFileSync(path.join(workDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(formatReport(report));
  process.exit(report.passed ? 0 : 1);
} else {
  const result = await runAllBands({ workDir, seed });
  fs.writeFileSync(path.join(workDir, "report.json"), JSON.stringify(result, null, 2));
  console.log(formatBandedResult(result));
  console.log(`\nReport written to ${path.join(workDir, "report.json")}`);
  process.exit(result.passed ? 0 : 1);
}
