/**
 * CLI: npm run eval [-- --seed 7 --band short|medium|long --workdir .eval]
 * Default runs ALL bands (short/medium/long), prints per-band reports and a
 * summary table, writes report.json. Exits non-zero if any band fails its
 * thresholds.
 *
 * Semantic mode (npm run eval:semantic, i.e. --semantic): swaps the default
 * HashEmbedder for LocalEmbedder (+ on-disk cache). Requires the optional
 * @huggingface/transformers dependency and LOCAL_EMBEDDER_MODEL — exits
 * with instructions when unavailable.
 *
 * Ollama mode (npm run eval:ollama, i.e. --ollama [--ollama-model <name>]
 * [--ollama-url <url>]): same shape, but the embedder is a local Ollama
 * service (default nomic-embed-text:latest on http://localhost:11434, url
 * overridable via OLLAMA_BASE_URL). Mutually exclusive with --semantic —
 * one source of truth per run.
 *
 * Neither mode raises any band threshold. PLAN-OLLAMA Task O2 planned a
 * medium-band paraphrase raise to 0.80 for real-embedder modes; measurement
 * said no: medium-band paraphrase recall@5 is 0% with nomic-embed-text,
 * mxbai-embed-large, AND HashEmbedder alike, because those probes target
 * facts past their decay horizon at 24 months — the misses are decay-bound,
 * not similarity-bound, so better embeddings cannot buy them back (the
 * BANDS docs in harness.ts predict exactly this). The real lift lands on
 * the short band (hash: 75% on every seed measured; nomic: 75–100%
 * depending on seed), but its minimum across seeds equals the hash
 * baseline, so the measured-minus-5pp discipline leaves every threshold at
 * the band default. A raise that holds only on the gate's default seed
 * would overfit one seed; the defaults already fail a garbage embedder
 * (short-band paraphrase threshold 0.70 vs ~0 for noise vectors).
 */

import path from "node:path";
import fs from "node:fs";
import { formatBandedResult, formatReport, runEval, type EvalBand } from "./harness.ts";
import type { Embedder } from "../embedding/embedder.ts";
import { CachedEmbedder } from "../embedding/cached-embedder.ts";
import { LocalEmbedder } from "../embedding/local-embedder.ts";
import { OllamaEmbedder } from "../embedding/ollama-embedder.ts";

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const workDir = path.resolve(argValue("workdir") ?? ".eval");
const seed = argValue("seed") ? Number(argValue("seed")) : undefined;
const band = argValue("band") as EvalBand | undefined;
const semantic = process.argv.includes("--semantic");
const ollama = process.argv.includes("--ollama");

if (semantic && ollama) {
  console.error("--semantic and --ollama are mutually exclusive: pick one embedder mode.");
  process.exit(2);
}

let embedder: Embedder | undefined;
if (semantic) {
  try {
    const local = await LocalEmbedder.create();
    embedder = new CachedEmbedder(local, path.join(workDir, "embed-cache"), local.modelName);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
} else if (ollama) {
  try {
    const remote = await OllamaEmbedder.create({
      model: argValue("ollama-model") ?? "nomic-embed-text:latest",
      baseUrl: argValue("ollama-url") ?? process.env.OLLAMA_BASE_URL,
    });
    embedder = new CachedEmbedder(remote, path.join(workDir, "embed-cache"), remote.modelName);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
}

if (band) {
  const report = await runEval({ workDir, seed, band, embedder });
  fs.writeFileSync(path.join(workDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(formatReport(report));
  process.exit(report.passed ? 0 : 1);
} else {
  const bands = [];
  for (const b of ["short", "medium", "long"] as EvalBand[]) {
    bands.push(await runEval({ workDir: path.join(workDir, b), seed, band: b, embedder }));
  }
  const result = { bands, passed: bands.every((r) => r.passed) };
  fs.writeFileSync(path.join(workDir, "report.json"), JSON.stringify(result, null, 2));
  console.log(formatBandedResult(result));
  console.log(`\nReport written to ${path.join(workDir, "report.json")}`);
  process.exit(result.passed ? 0 : 1);
}
