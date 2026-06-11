import fs from "node:fs";
import path from "node:path";

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
