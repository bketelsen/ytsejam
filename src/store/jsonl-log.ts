/**
 * Append-only JSONL log with latest-wins fold on read — the same persistence
 * idiom ytsejam uses for its sidecar stores. Records must carry a string
 * `id`; appending a new snapshot of an id supersedes earlier lines. Malformed
 * lines are skipped so one corrupt write can't break loading.
 */

import fs from "node:fs";
import path from "node:path";

export class JsonlLog<T extends { id: string }> {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  append(record: T): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`);
  }

  appendMany(records: T[]): void {
    if (records.length === 0) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const lines = records.map((r) => `${JSON.stringify(r)}\n`).join("");
    fs.appendFileSync(this.filePath, lines);
  }

  /** Fold the log: latest snapshot per id wins. */
  load(): Map<string, T> {
    const out = new Map<string, T>();
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, "utf8");
    } catch {
      return out;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as T;
        if (typeof record.id === "string" && record.id) out.set(record.id, record);
      } catch {
        // tolerate corrupt lines
      }
    }
    return out;
  }

  /**
   * Rewrite the log to one line per id (drops superseded snapshots). Called
   * opportunistically; the log stays correct without it.
   */
  compact(records: Iterable<T>): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const lines = [...records].map((r) => `${JSON.stringify(r)}\n`).join("");
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, lines);
    fs.renameSync(tmp, this.filePath);
  }
}
