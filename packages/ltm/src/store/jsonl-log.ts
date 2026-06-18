/**
 * Append-only JSONL log with latest-wins fold on read — the same persistence
 * idiom ytsejam uses for its sidecar stores. Records must carry a string
 * `id`; appending a new snapshot of an id supersedes earlier lines. Malformed
 * lines are skipped so one corrupt write can't break loading.
 *
 * Reads and writes are STREAMED, never materialized as one whole-file string:
 * a JSONL log can exceed V8's max string length (~0.5 GB), and
 * `fs.readFileSync(path, "utf8")` THROWS `ERR_STRING_TOO_LONG` past that —
 * which silently emptied the store before (D4). `load()` reads in fixed byte
 * chunks; `compact()` writes one line at a time to the temp fd.
 */

import fs from "node:fs";
import path from "node:path";

/** Byte chunk size for streamed reads. 4 MiB: well under the string cap, large enough to keep syscalls cheap on a multi-GB log. */
const READ_CHUNK_BYTES = 4 * 1024 * 1024;

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

  /**
   * Fold the log: latest snapshot per id wins. Reads the file in byte chunks
   * and parses line-by-line so a multi-GB log never becomes one V8 string.
   */
  load(): Map<string, T> {
    const out = new Map<string, T>();
    let fd: number;
    try {
      fd = fs.openSync(this.filePath, "r");
    } catch (err) {
      // A missing log is an empty store. Any OTHER open error is real — surface it.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return out;
      throw err;
    }
    try {
      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      let carry = ""; // bytes of a partial final line, decoded, awaiting the rest
      const decoder = new TextDecoder("utf8"); // multi-byte-safe across chunk seams
      let bytesRead: number;
      while ((bytesRead = fs.readSync(fd, buffer, 0, READ_CHUNK_BYTES, null)) > 0) {
        // stream:true keeps a trailing partial multi-byte char buffered in the decoder.
        carry += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
        let nl: number;
        while ((nl = carry.indexOf("\n")) !== -1) {
          this.foldLine(carry.slice(0, nl), out);
          carry = carry.slice(nl + 1);
        }
      }
      carry += decoder.decode(); // flush any buffered final char
      if (carry) this.foldLine(carry, out); // last line if the file lacks a trailing newline
    } finally {
      fs.closeSync(fd);
    }
    return out;
  }

  private foldLine(line: string, out: Map<string, T>): void {
    if (!line.trim()) return;
    try {
      const record = JSON.parse(line) as T;
      if (typeof record.id === "string" && record.id) out.set(record.id, record);
    } catch {
      // tolerate corrupt lines
    }
  }

  /**
   * Rewrite the log to one line per id (drops superseded snapshots). Called
   * opportunistically; the log stays correct without it. Streams to the temp
   * fd one line at a time — the compacted file can itself exceed the V8 string
   * cap, so it is never built as one string.
   */
  compact(records: Iterable<T>): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    const fd = fs.openSync(tmp, "w");
    try {
      for (const r of records) fs.writeSync(fd, `${JSON.stringify(r)}\n`);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.filePath);
  }
}
