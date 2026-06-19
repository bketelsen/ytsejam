import fs from "node:fs";
import path from "node:path";
import { readdirSync } from "node:fs";

/**
 * Per-session agent working directory. JSONL events are SSOT (latest-wins);
 * the resolved dir is folded on read. We store one file per session under
 * `<dataDir>/workdirs/<sessionId>.jsonl` rather than appending to the
 * harness's own session log so we don't fight pi-agent-core's schema or
 * dirty its session timeline. This mirrors the schedules.ts pattern.
 *
 * The harness's own JsonlSessionMetadata.cwd is the session's *home* dir
 * (used by repo.list() to filter); ytsejam passes a constant there. The
 * agent working directory tracked here is orthogonal to that and is the
 * cwd the bash/file tools resolve against.
 */
export interface WorkdirEvent {
  dir: string;
  timestamp: string;
}

export class WorkdirStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private filePath(sessionId: string): string {
    // sessionId is a uuid; no traversal risk in practice, but normalize defensively
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.dir, `${safe}.jsonl`);
  }

  /** Append a workdir-set event for one session. Caller must validate `dir`. */
  append(sessionId: string, event: WorkdirEvent): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.filePath(sessionId), `${JSON.stringify(event)}\n`);
  }

  /**
   * Latest workdir set for a session, or undefined if never set.
   * Malformed lines are skipped silently so a single corrupt write
   * can't break session boot.
   */
  current(sessionId: string): string | undefined {
    let text: string;
    try {
      text = fs.readFileSync(this.filePath(sessionId), "utf8");
    } catch {
      return undefined;
    }
    let latest: WorkdirEvent | undefined;
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const ev = JSON.parse(line) as WorkdirEvent;
        if (typeof ev.dir === "string") latest = ev;
      } catch {
        // tolerate corrupt lines
      }
    }
    return latest?.dir;
  }
}

/**
 * Return the most-recent distinct working directories across all sessions in
 * the store, excluding `excludeDir` (typically the dataDir default).
 *
 * Algorithm:
 *   1. Enumerate every *.jsonl file in the store dir.
 *   2. For each file, derive a session id and read the latest event via `current()`.
 *   3. Collect (dir, timestamp) pairs from each file's last event so we can sort
 *      by recency.
 *   4. Sort descending by timestamp, deduplicate paths, then slice to `limit`.
 *
 * Errors reading individual session files are silently skipped (same resilience
 * posture as `current()`).
 */
export function recentWorkdirs(
  store: WorkdirStore,
  limit: number,
  excludeDir?: string,
): string[] {
  let files: string[];
  try {
    files = readdirSync(store["dir"]).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }

  // collect (sessionId, latestEvent) pairs
  const entries: { dir: string; timestamp: string }[] = [];
  for (const file of files) {
    const sessionId = file.slice(0, -".jsonl".length);
    let text: string;
    try {
      text = fs.readFileSync(path.join(store["dir"], file), "utf8");
    } catch {
      continue;
    }
    let latest: WorkdirEvent | undefined;
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const ev = JSON.parse(line) as WorkdirEvent;
        if (typeof ev.dir === "string") latest = ev;
      } catch {
        // tolerate corrupt lines
      }
    }
    if (latest) entries.push(latest);
    void sessionId; // used only to derive file path via store["dir"]
  }

  // sort most-recent first
  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  // deduplicate paths, exclude default dir, slice to limit
  const seen = new Set<string>();
  const result: string[] = [];
  for (const { dir } of entries) {
    if (result.length >= limit) break;
    if (excludeDir && dir === excludeDir) continue;
    if (seen.has(dir)) continue;
    seen.add(dir);
    result.push(dir);
  }
  return result;
}

/**
 * Resolve a session's effective working directory:
 *  1. Look up its workdir event (latest wins).
 *  2. Validate the dir exists and is a directory; if not, fall back.
 *  3. Default to `defaultDir` (typically dataDir) when unset.
 *
 * Returns the resolved absolute path. Logs a warning when a previously-set
 * workdir has gone missing so the operator can investigate.
 */
export function resolveWorkdir(
  store: WorkdirStore,
  sessionId: string,
  defaultDir: string,
): string {
  const set = store.current(sessionId);
  if (set) {
    try {
      const stat = fs.statSync(set);
      if (stat.isDirectory()) return set;
      console.warn(
        `workdir for session ${sessionId} (${set}) exists but is not a directory; falling back to ${defaultDir}`,
      );
    } catch {
      console.warn(
        `workdir for session ${sessionId} (${set}) no longer exists; falling back to ${defaultDir}`,
      );
    }
  }
  return defaultDir;
}
