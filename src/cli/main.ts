/**
 * ltm CLI (PLAN.md Task 5.1) — the inspectable surface of the memory store.
 *
 *   ltm ingest <sessions-dir-or-file>   incremental ingest, prints report
 *   ltm retrieve <query>                ranked items + profile
 *   ltm explain <query>                 full score-breakdown table
 *   ltm profile                         current profile dump
 *   ltm consolidate                     run the maintenance pass
 *   ltm redact --entity <name> | --session <id> | --pattern <re> | --record <id>
 *   ltm stats                           store size + retention summary
 *   ltm export                          full JSON dump to stdout
 *   ltm doctor [--fix]                  store health checks
 *
 * Store dir: --store-dir flag or LTM_STORE_DIR env (default ./memory).
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { MemorySystem } from "../api/memory-system.ts";
import { runDoctor } from "./doctor.ts";

const USAGE = `usage: ltm <command> [args] [--store-dir <dir>]

commands:
  ingest <path>        ingest a session file or directory (incremental)
  retrieve <query>     retrieve memory context for a query
  explain <query>      ranked candidates with per-channel score breakdowns
  profile              what the system believes about the user
  consolidate          fold old, faded turns into session summaries
  redact               --entity <name> | --session <id> | --pattern <re> | --record <id>
  stats                store statistics
  export               full JSON dump to stdout (embeddings stripped)
  doctor [--fix]       store health checks; --fix compacts + rebuilds state

store dir: --store-dir or LTM_STORE_DIR (default ./memory)`;

export async function runCli(argv: string[], out: (s: string) => void = console.log): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "store-dir": { type: "string" },
      k: { type: "string" },
      budget: { type: "string" },
      entity: { type: "string" },
      session: { type: "string" },
      pattern: { type: "string" },
      record: { type: "string" },
      fix: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  const [command, ...rest] = positionals;
  if (values.help || !command) {
    out(USAGE);
    return values.help ? 0 : 2;
  }

  const storeDir = path.resolve(values["store-dir"] ?? process.env.LTM_STORE_DIR ?? "./memory");

  // Doctor must run WITHOUT the normal open path: a sick store is exactly
  // the case where MemorySystem.open might misbehave.
  if (command === "doctor") {
    return runDoctor(storeDir, { fix: values.fix ?? false }, out);
  }

  const mem = MemorySystem.open({ storeDir });
  try {
    switch (command) {
      case "ingest": {
        const target = rest[0];
        if (!target) {
          out("ingest: missing <sessions-dir-or-file>");
          return 2;
        }
        const stat = fs.statSync(target);
        const report = stat.isDirectory()
          ? await mem.ingestSessionDir(target)
          : await mem.ingestSessionFile(target);
        out(
          `sessions ${report.sessionsSeen ?? 1}  turns ${report.turnsIngested}  records ${report.recordsCreated}`,
        );
        for (const w of report.warnings) out(`warning: ${w}`);
        return 0;
      }
      case "retrieve": {
        const query = rest.join(" ");
        if (!query) {
          out("retrieve: missing <query>");
          return 2;
        }
        const k = values.k ? Number(values.k) : 8;
        const budget = values.budget ? Number(values.budget) : 1200;
        out(await mem.composeContext(query, { k, tokenBudget: budget, dryRun: true }));
        return 0;
      }
      case "explain": {
        const query = rest.join(" ");
        if (!query) {
          out("explain: missing <query>");
          return 2;
        }
        const k = values.k ? Number(values.k) : 8;
        const ranked = await mem.explain(query, k);
        out(`rank  total  vec   lex   rec   sal   grf   ret   id`);
        ranked.forEach((item, i) => {
          const b = item.breakdown;
          const f = (x: number) => x.toFixed(2);
          out(
            `${String(i + 1).padStart(4)}  ${f(b.total)}  ${f(b.vector)}  ${f(b.lexical)}  ${f(b.recency)}  ${f(b.salience)}  ${f(b.graph)}  ${f(b.retention)}  ${item.record.id}`,
          );
          out(`      ${item.record.text.slice(0, 100).replace(/\n/g, " ")}`);
        });
        return 0;
      }
      case "profile": {
        const profile = mem.profile();
        const section = (label: string, facts: { object: string; polarity: number; strength: number; predicate: string }[]) => {
          if (!facts.length) return;
          out(`${label}:`);
          for (const f of facts) {
            out(`  ${f.predicate} ${f.polarity > 0 ? "+" : "-"} ${f.object}  (strength ${f.strength.toFixed(2)})`);
          }
        };
        section("identity", profile.identity);
        section("attributes", profile.attributes);
        section("preferences", profile.preferences);
        section("directives", profile.directives);
        if (profile.topEntities.length) {
          out(`top entities: ${profile.topEntities.map((e) => `${e.name}(${e.mentionCount})`).join(", ")}`);
        }
        return 0;
      }
      case "consolidate": {
        const result = await mem.consolidate();
        out(`created ${result.created} summaries, folded ${result.folded} turn records`);
        return 0;
      }
      case "redact": {
        const selector = values.entity
          ? { entity: values.entity }
          : values.session
            ? { sessionId: values.session }
            : values.pattern
              ? { pattern: values.pattern }
              : values.record
                ? { recordId: values.record }
                : undefined;
        if (!selector) {
          out("redact: need --entity, --session, --pattern, or --record");
          return 2;
        }
        const result = await mem.redact(selector);
        out(
          `redacted: ${result.episodicRedacted} episodic, ${result.factsRedacted} facts, ` +
            `${result.entitiesRedacted} entities; ${result.consolidatedRebuilt} summaries rebuilt`,
        );
        return 0;
      }
      case "stats": {
        const stats = mem.stats();
        out(
          `episodic: ${stats.episodic.total} total (${stats.episodic.active} active, ` +
            `${stats.episodic.consolidated} consolidated, ${stats.episodic.redacted} redacted), ` +
            `mean retention ${stats.episodic.meanRetention.toFixed(2)}`,
        );
        out(`facts: ${stats.facts.active}/${stats.facts.total} active`);
        out(`entities: ${stats.entities.active}/${stats.entities.total} active`);
        return 0;
      }
      case "export": {
        out(JSON.stringify(mem.export(), null, 2));
        return 0;
      }
      default:
        out(`unknown command: ${command}\n\n${USAGE}`);
        return 2;
    }
  } finally {
    mem.close();
  }
}
