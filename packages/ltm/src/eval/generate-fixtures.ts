/**
 * CLI: npm run fixtures [-- --out fixtures/generated --seed 42]
 * Writes a deterministic synthetic corpus (ytsejam session JSONL files plus
 * ground-truth.json) without running the eval.
 */

import path from "node:path";
import { generateFixtures } from "./synthetic.ts";

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const outDir = path.resolve(argValue("out") ?? "fixtures/generated");
const truth = generateFixtures({
  outDir,
  seed: argValue("seed") ? Number(argValue("seed")) : 42,
});
console.log(`Wrote ${truth.sessionIds.length} sessions + ground-truth.json to ${outDir}`);
