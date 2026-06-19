// scripts/ltm-rederive-facts.ts
import fs from "node:fs";
import { parseArgs } from "node:util";
import { PiAuthStore, resolveApiKey } from "../server/src/pi-auth.ts";
import { CopilotFactExtractor } from "../server/src/memory/fact-extractor.ts";
import { buildFreshFacts } from "../server/src/memory/rederive.ts";

const { values } = parseArgs({ options: { "dry-run": { type: "boolean" }, "store-dir": { type: "string" } } });
const storeDir = values["store-dir"] ?? `${process.env.HOME}/.ytsejam/data/ltm`;
const authStore = new PiAuthStore(`${process.env.HOME}/.pi/agent/auth.json`);
const extractor = new CopilotFactExtractor({ getApiKey: () => resolveApiKey("github-copilot", authStore) });

const r = await buildFreshFacts({ storeDir, extractor });
console.log(JSON.stringify({ mode: values["dry-run"] ? "dry-run" : "rewrite", freshFactCount: r.facts.length, knownGood: r.knownGood, facts: r.facts }, null, 2));

if (!r.knownGood.ok) {
  console.error(`ABORT: known-good facts missing: ${r.knownGood.missing.join(", ")}. Not wiping.`);
  process.exit(1);
}
if (values["dry-run"]) { console.error("dry-run: no writes performed."); process.exit(0); }

// Real run: replace live facts.jsonl with the freshly-built one (operator must have stopped the server + taken a backup).
fs.copyFileSync(r.freshFactsPath, `${storeDir}/facts.jsonl`);
console.error(`rewrote ${storeDir}/facts.jsonl with ${r.facts.length} clean facts.`);
