/**
 * ltm doctor (PLAN.md Task 5.2) — store health checks. Reads the raw JSONL
 * (deliberately not through MemorySystem, which papers over corruption) and
 * reports:
 *   - malformed lines per log file
 *   - latest-wins collisions (same id, same timestamp, different lines)
 *   - ingest-state entries whose session files no longer exist
 *   - redaction-audit events referencing records/sessions that don't exist
 *   - inconsistent embedding dimensions
 * --fix compacts every log to one line per id and prunes ingest-state to
 * sessions that exist on disk.
 */

import fs from "node:fs";
import path from "node:path";

interface RawRecord {
  id: string;
  line: number;
  json: Record<string, unknown>;
}

interface LogScan {
  file: string;
  records: RawRecord[];
  malformed: number[];
}

const LOG_FILES = ["episodic.jsonl", "facts.jsonl", "redactions.jsonl"];

/** Immutable per-id fields; two snapshots disagreeing on these = collision. */
const IDENTITY_FIELDS: Record<string, string[]> = {
  "episodic.jsonl": ["kind", "sessionId", "entryId"],
  "facts.jsonl": ["kind", "predicate", "polarity"],
};

function scanLog(filePath: string): LogScan | undefined {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  const scan: LogScan = { file: path.basename(filePath), records: [], malformed: [] };
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const json = JSON.parse(line) as Record<string, unknown>;
      if (typeof json.id === "string" && json.id) {
        scan.records.push({ id: json.id, line: i + 1, json });
      } else {
        scan.malformed.push(i + 1);
      }
    } catch {
      scan.malformed.push(i + 1);
    }
  });
  return scan;
}

export function runDoctor(
  storeDir: string,
  opts: { fix: boolean },
  out: (s: string) => void = console.log,
): number {
  const findings: string[] = [];
  const scans = new Map<string, LogScan>();

  for (const name of LOG_FILES) {
    const scan = scanLog(path.join(storeDir, name));
    if (!scan) continue;
    scans.set(name, scan);
    if (scan.malformed.length > 0) {
      findings.push(`${name}: ${scan.malformed.length} malformed line(s) at ${scan.malformed.slice(0, 5).join(", ")}`);
    }
    // An id collision is two DIFFERENT logical records sharing an id:
    // snapshots of one record may evolve freely (reinforcement, supersede,
    // access bumps — often within the same timestamp), but the identity
    // fields below never legitimately change. Redaction tombstones zero
    // fields out, so they're exempt.
    const identityFields = IDENTITY_FIELDS[name];
    if (identityFields) {
      const identities = new Map<string, { tuple: string; line: number }>();
      for (const r of scan.records) {
        if (r.json.state === "redacted") continue;
        const tuple = identityFields.map((f) => String(r.json[f] ?? "")).join("|");
        const prev = identities.get(r.id);
        if (prev && prev.tuple !== tuple) {
          findings.push(
            `${name}: id collision — ${r.id} holds two different records (lines ${prev.line}, ${r.line}: "${prev.tuple}" vs "${tuple}")`,
          );
        }
        identities.set(r.id, { tuple, line: r.line });
      }
    }
  }

  // ingest-state references.
  const statePath = path.join(storeDir, "ingest-state.json");
  let state: { sessions: Record<string, { path: string; entryIds: string[] }> } | undefined;
  try {
    state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    if (fs.existsSync(statePath)) findings.push("ingest-state.json: unparseable");
  }
  const missingSessions: string[] = [];
  if (state?.sessions) {
    for (const [id, entry] of Object.entries(state.sessions)) {
      if (!fs.existsSync(entry.path)) missingSessions.push(id);
    }
    if (missingSessions.length > 0) {
      findings.push(`ingest-state.json: ${missingSessions.length} session(s) reference missing files`);
    }
  }

  // Redaction audit orphans.
  const episodic = scans.get("episodic.jsonl");
  const audit = scans.get("redactions.jsonl");
  if (audit && episodic) {
    const ids = new Set(episodic.records.map((r) => r.id));
    const sessions = new Set(episodic.records.map((r) => r.json.sessionId as string));
    for (const event of audit.records) {
      const selector = event.json.selector as { type?: string; ref?: string } | undefined;
      if (selector?.type === "recordId" && selector.ref && !ids.has(selector.ref)) {
        findings.push(`redactions.jsonl: event ${event.id} references unknown record ${selector.ref}`);
      }
      if (selector?.type === "sessionId" && selector.ref && !sessions.has(selector.ref)) {
        findings.push(`redactions.jsonl: event ${event.id} references unknown session ${selector.ref}`);
      }
    }
  }

  // Embedding dimensions.
  if (episodic) {
    const dims = new Set<number>();
    for (const r of episodic.records) {
      if (Array.isArray(r.json.embedding)) dims.add((r.json.embedding as unknown[]).length);
    }
    if (dims.size > 1) {
      findings.push(`episodic.jsonl: inconsistent embedding dimensions: ${[...dims].join(", ")}`);
    }
  }

  if (findings.length === 0) {
    out(`store ${storeDir}: healthy`);
    return 0;
  }
  for (const f of findings) out(`FINDING: ${f}`);

  if (!opts.fix) {
    out(`${findings.length} finding(s). Run with --fix to compact logs and rebuild ingest-state.`);
    return 1;
  }

  // --fix: latest-wins compaction per log (drops malformed lines and
  // superseded snapshots) + prune ingest-state to existing files.
  for (const name of LOG_FILES) {
    const scan = scans.get(name);
    if (!scan) continue;
    const latest = new Map<string, Record<string, unknown>>();
    for (const r of scan.records) latest.set(r.id, r.json);
    const tmp = path.join(storeDir, `${name}.tmp`);
    fs.writeFileSync(tmp, [...latest.values()].map((j) => `${JSON.stringify(j)}\n`).join(""));
    fs.renameSync(tmp, path.join(storeDir, name));
    out(`fixed: ${name} compacted to ${latest.size} record(s)`);
  }
  if (state?.sessions) {
    for (const id of missingSessions) delete state.sessions[id];
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    if (missingSessions.length > 0) out(`fixed: ingest-state.json pruned ${missingSessions.length} stale session(s)`);
  }
  out("fix complete — re-run doctor to verify");
  return 0;
}
