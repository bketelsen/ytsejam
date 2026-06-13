/**
 * CLI: npm run bench [-- --workdir /tmp/ltm-bench --sizes 100,1000,10000]
 *
 * Measures (PLAN.md Task 5.5):
 *   - ingest throughput (turns/sec) on a fresh store
 *   - retrieval latency p50/p99 at several corpus sizes (HashEmbedder)
 *   - consolidation time per 1k records
 * Writes bench-report.json; exits non-zero below thresholds so a "we made
 * retrieval O(n²)" regression fails loudly instead of shipping.
 *
 * Thresholds (HashEmbedder; a real embedder is allowed ~10× slower):
 *   ingest ≥ 500 turns/sec, retrieve p99 ≤ 50ms at the largest size.
 */

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { MemorySystem } from "../api/memory-system.ts";
import { generateFixtures } from "../eval/synthetic.ts";

const INGEST_MIN_TURNS_PER_SEC = 500;
const RETRIEVE_MAX_P99_MS = 50;

const QUERIES = [
  "What is my sister's name?",
  "Where do I work these days?",
  "dark roast coffee preferences",
  "help me debug the payments service",
  "What food am I allergic to?",
  "marathon training progress",
  "Which editor keybindings do I like?",
  "summarize what we discussed about DNS",
];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

interface SizeResult {
  records: number;
  ingestTurnsPerSec: number;
  retrieveP50Ms: number;
  retrieveP99Ms: number;
  consolidateMsPer1k: number;
}

const workDir = path.resolve(argValue("workdir") ?? "/tmp/ltm-bench");
const sizes = (argValue("sizes") ?? "100,1000,10000").split(",").map(Number);
fs.rmSync(workDir, { recursive: true, force: true });

const results: SizeResult[] = [];
for (const target of sizes) {
  // ~2 records per scripted user/assistant exchange; size the corpus to hit
  // the target record count.
  const turnsPerSession = 25;
  const sessions = Math.max(1, Math.ceil(target / (turnsPerSession * 2)));
  const dir = path.join(workDir, String(target));
  const truth = generateFixtures({
    outDir: path.join(dir, "sessions"),
    sessions,
    turnsPerSession,
    seed: 42,
    intervalDays: 3,
  });

  const mem = MemorySystem.open({ storeDir: path.join(dir, "store"), now: () => truth.horizonEnd });

  const ingestStart = performance.now();
  const report = await mem.ingestSessionDir(path.join(dir, "sessions"));
  const ingestSecs = (performance.now() - ingestStart) / 1000;
  const ingestTurnsPerSec = report.turnsIngested / ingestSecs;

  const latencies: number[] = [];
  const rounds = 25;
  for (let r = 0; r < rounds; r++) {
    for (const q of QUERIES) {
      const t0 = performance.now();
      await mem.retrieve(q, { k: 8, dryRun: true });
      latencies.push(performance.now() - t0);
    }
  }
  latencies.sort((a, b) => a - b);

  const consolidateStart = performance.now();
  await mem.consolidate();
  const consolidateMs = performance.now() - consolidateStart;

  const records = mem.stats().episodic.total;
  mem.close();

  results.push({
    records,
    ingestTurnsPerSec: Math.round(ingestTurnsPerSec),
    retrieveP50Ms: Number(percentile(latencies, 50).toFixed(2)),
    retrieveP99Ms: Number(percentile(latencies, 99).toFixed(2)),
    consolidateMsPer1k: Number(((consolidateMs / records) * 1000).toFixed(1)),
  });
  console.log(
    `${String(records).padStart(6)} records: ingest ${Math.round(ingestTurnsPerSec)} turns/s, ` +
      `retrieve p50 ${percentile(latencies, 50).toFixed(1)}ms p99 ${percentile(latencies, 99).toFixed(1)}ms, ` +
      `consolidate ${((consolidateMs / records) * 1000).toFixed(0)}ms/1k`,
  );
}

const largest = results[results.length - 1];
const failures: string[] = [];
if (largest.ingestTurnsPerSec < INGEST_MIN_TURNS_PER_SEC) {
  failures.push(`ingest ${largest.ingestTurnsPerSec} turns/s < ${INGEST_MIN_TURNS_PER_SEC}`);
}
if (largest.retrieveP99Ms > RETRIEVE_MAX_P99_MS) {
  failures.push(`retrieve p99 ${largest.retrieveP99Ms}ms > ${RETRIEVE_MAX_P99_MS}ms at ${largest.records} records`);
}

const benchReport = {
  at: new Date().toISOString(),
  embedder: "HashEmbedder(256)",
  thresholds: { ingestMinTurnsPerSec: INGEST_MIN_TURNS_PER_SEC, retrieveMaxP99Ms: RETRIEVE_MAX_P99_MS },
  results,
  passed: failures.length === 0,
  failures,
};
fs.writeFileSync(path.join(process.cwd(), "bench-report.json"), JSON.stringify(benchReport, null, 2));
console.log(failures.length === 0 ? "\nBENCH PASSED" : `\nBENCH FAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
process.exit(failures.length === 0 ? 0 : 1);
