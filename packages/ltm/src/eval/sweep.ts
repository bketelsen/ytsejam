/**
 * CLI: npm run eval:sweep [-- --workdir .eval-sweep]
 * Runs every band across a fixed 20-seed set and reports per-band pass
 * rates. Fails (exit 1) if any band's pass rate falls below 95% — catches
 * threshold calibrations that secretly depend on where one seed happens to
 * place a planted statement (PLAN.md Task 1.4).
 */

import fs from "node:fs";
import path from "node:path";
import { runEval, BANDS, type EvalBand, type EvalReport } from "./harness.ts";

export const SWEEP_SEEDS = [
  1, 2, 3, 5, 7, 11, 13, 17, 23, 42, 99, 101, 271, 314, 999, 1337, 4242, 31337, 65521, 99991,
] as const;

export const MIN_PASS_RATE = 0.95;

export interface SweepResult {
  perBand: Record<EvalBand, { passed: number; total: number; failures: { seed: number; failures: string[] }[] }>;
  passed: boolean;
}

export async function runSweep(workDir: string, log: (s: string) => void = () => {}): Promise<SweepResult> {
  const perBand = {} as SweepResult["perBand"];
  for (const band of Object.keys(BANDS) as EvalBand[]) {
    perBand[band] = { passed: 0, total: 0, failures: [] };
    for (const seed of SWEEP_SEEDS) {
      const report: EvalReport = await runEval({
        workDir: path.join(workDir, band, String(seed)),
        band,
        seed,
      });
      perBand[band].total++;
      if (report.passed) perBand[band].passed++;
      else perBand[band].failures.push({ seed, failures: report.failures });
      log(`${band} seed ${seed}: ${report.passed ? "pass" : `FAIL — ${report.failures.join("; ")}`}`);
    }
  }
  const passed = (Object.keys(perBand) as EvalBand[]).every(
    (band) => perBand[band].passed / perBand[band].total >= MIN_PASS_RATE,
  );
  return { perBand, passed };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const idx = process.argv.indexOf("--workdir");
  const workDir = path.resolve(idx >= 0 ? process.argv[idx + 1] : ".eval-sweep");
  fs.rmSync(workDir, { recursive: true, force: true });
  const result = await runSweep(workDir, (s) => console.log(s));
  console.log("");
  for (const [band, r] of Object.entries(result.perBand)) {
    console.log(
      `${band.padEnd(7)} ${r.passed}/${r.total} (${((100 * r.passed) / r.total).toFixed(0)}%)` +
        (r.failures.length ? ` — failing seeds: ${r.failures.map((f) => f.seed).join(", ")}` : ""),
    );
  }
  fs.writeFileSync(path.join(workDir, "sweep-report.json"), JSON.stringify(result, null, 2));
  console.log(result.passed ? "\nSWEEP PASSED (all bands ≥ 95%)" : "\nSWEEP FAILED");
  process.exit(result.passed ? 0 : 1);
}
