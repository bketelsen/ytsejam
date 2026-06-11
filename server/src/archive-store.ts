import fs from "node:fs";
import path from "node:path";

/**
 * Per-session archive (soft-delete) marker. JSONL events are SSOT
 * (latest-wins); folded on read. One file per session under
 * `<dataDir>/archived/<sessionId>.jsonl`, exactly mirroring the workdirs
 * store. We use a sidecar rather than the harness's own session log so we
 * don't fight pi-agent-core's schema or dirty its session timeline, and so
 * `manager.rebuildIndex()` has a stable place to read the flag back from
 * (the indexer's `archived` column is derived and rebuilt from JSONL on
 * boot — a DB-only flag would silently un-archive every session on
 * restart).
 *
 * Latest-wins semantics make unarchive a normal append of `archived:false`;
 * no compaction needed for a tiny per-session log.
 */
export interface ArchiveEvent {
  archived: boolean;
  timestamp: string;
}

export class ArchiveStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private filePath(sessionId: string): string {
    // sessionId is a uuid; no traversal risk in practice, but normalize defensively
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.dir, `${safe}.jsonl`);
  }

  /** Append an archive-state event for one session. */
  append(sessionId: string, event: ArchiveEvent): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.filePath(sessionId), `${JSON.stringify(event)}\n`);
  }

  /**
   * Whether the session is currently archived (latest event wins; default
   * false when no events exist). Malformed lines are skipped silently so a
   * single corrupt write can't break session boot.
   */
  isArchived(sessionId: string): boolean {
    let text: string;
    try {
      text = fs.readFileSync(this.filePath(sessionId), "utf8");
    } catch {
      return false;
    }
    let latest: ArchiveEvent | undefined;
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const ev = JSON.parse(line) as ArchiveEvent;
        if (typeof ev.archived === "boolean") latest = ev;
      } catch {
        // tolerate corrupt lines
      }
    }
    return latest?.archived ?? false;
  }
}
