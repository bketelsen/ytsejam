/**
 * CLI: npm run eval [-- --seed 7 --band short|medium|long --workdir .eval]
 * Default runs ALL bands (short/medium/long), prints per-band reports and a
 * summary table, writes report.json. Exits non-zero if any band fails its
 * thresholds.
 *
 * Semantic mode (npm run eval:semantic, i.e. --semantic): swaps the default
 * HashEmbedder for LocalEmbedder (+ on-disk cache) and raises the medium
 * band's paraphrase recall threshold to 0.80. Requires the optional
 * @huggingface/transformers dependency and LOCAL_EMBEDDER_MODEL — exits
 * with instructions when unavailable.
 */

import path from "node:path";
import fs from "node:fs";
import {
  formatBandedResult,
  formatReport,
  runEval,
  type EvalBand,
  type EvalThresholds,
} from "./harness.ts";
import type { Embedder } from "../embedding/embedder.ts";
import { CachedEmbedder } from "../embedding/cached-embedder.ts";
import { LocalEmbedder } from "../embedding/local-embedder.ts";

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const workDir = path.resolve(argValue("workdir") ?? ".eval");
const seed = argValue("seed") ? Number(argValue("seed")) : undefined;
const band = argValue("band") as EvalBand | undefined;
const semantic = process.argv.includes("--semantic");

let embedder: Embedder | undefined;
if (semantic) {
  try {
    const local = await LocalEmbedder.create();
    embedder = new CachedEmbedder(local, path.join(workDir, "embed-cache"), local.modelName);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
}

/** Semantic mode must actually fix paraphrase recall on the medium band. */
function semanticThresholds(b: EvalBand): Partial<EvalThresholds> | undefined {
  if (!semantic) return undefined;
  return b === "medium" ? { paraphraseRecallAt5: 0.8 } : undefined;
}

if (band) {
  const report = await runEval({ workDir, seed, band, embedder, thresholds: semanticThresholds(band) });
  fs.writeFileSync(path.join(workDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(formatReport(report));
  process.exit(report.passed ? 0 : 1);
} else {
  const bands = [];
  for (const b of ["short", "medium", "long"] as EvalBand[]) {
    bands.push(
      await runEval({ workDir: path.join(workDir, b), seed, band: b, embedder, thresholds: semanticThresholds(b) }),
    );
  }
  const result = { bands, passed: bands.every((r) => r.passed) };
  fs.writeFileSync(path.join(workDir, "report.json"), JSON.stringify(result, null, 2));
  console.log(formatBandedResult(result));
  console.log(`\nReport written to ${path.join(workDir, "report.json")}`);
  process.exit(result.passed ? 0 : 1);
}
