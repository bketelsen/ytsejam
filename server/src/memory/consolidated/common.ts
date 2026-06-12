import { Controller } from "../domain/index.ts";
import { memoryRoot } from "../store/index.ts";
import type { Domain } from "../types.ts";

export function controller(): Controller {
  return new Controller(memoryRoot());
}

export function domainFilePath(domain: Domain, file: string): string {
  const base = domain.path.replace(/\/+$/, "");
  return base ? `${base}/${file}.md` : `${file}.md`;
}

export function splitLines(content: string): string[] {
  const lines = content.split("\n");
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}

export function countLines(content: string): number {
  if (content.length === 0) return 0;
  const n = content.match(/\n/g)?.length ?? 0;
  return content.endsWith("\n") ? n : n + 1;
}

export async function fileExists(path: string): Promise<boolean> {
  return (await import("../store/index.ts")).stats(path).then((s) => s.per_file.some((f) => f.path === path));
}

export async function fileModifiedDate(path: string): Promise<Date | null> {
  const s = await (await import("../store/index.ts")).stats(path);
  const row = s.per_file.find((f) => f.path === path);
  return row ? new Date(row.modified) : null;
}

export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function formatRFC3339Seconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Resolve a `since` parameter to a Date.
 *
 * Accepted forms:
 *   - `""` (empty) → default 7d window
 *   - `YYYY-MM-DD` → midnight UTC of that date
 *   - RFC3339 timestamp → parsed as-is then floored to UTC date
 *   - Single-unit duration: `Nd` (integer-only), `Nh`/`Nm`/`Ns` (decimals allowed)
 *
 * INTENTIONAL DIVERGENCE FROM GO: Go's `time.ParseDuration` also accepts
 * composite forms like `1h30m`, `2h45m30s`, and sub-second units (`100ms`).
 * The TS port deliberately does NOT support composites — single-unit windows
 * cover every realistic memory-window use case (reflect/foresight/history),
 * and porting a full ParseDuration is not worth the LOC. Composite forms
 * throw `unrecognized since value`. Documented at `PARITY.md` (PR-2a section)
 * and locked by regression test.
 */
export function resolveSince(raw = ""): { cutoff: Date; since: string } {
  const s = raw.trim();
  const now = new Date();
  if (s === "") {
    const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    return { cutoff, since: formatDate(cutoff) };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { cutoff: new Date(`${s}T00:00:00Z`), since: s };
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return { cutoff: d, since: formatDate(d) };
  }
  const days = s.match(/^(\d+)d$/);
  if (days && Number(days[1]) > 0) {
    const cutoff = new Date(now.getTime() - Number(days[1]) * 24 * 60 * 60 * 1000);
    return { cutoff, since: formatDate(cutoff) };
  }
  const hours = s.match(/^(\d+(?:\.\d+)?)h$/);
  if (hours) {
    const cutoff = new Date(now.getTime() - Number(hours[1]) * 60 * 60 * 1000);
    return { cutoff, since: formatDate(cutoff) };
  }
  const mins = s.match(/^(\d+(?:\.\d+)?)m$/);
  if (mins) {
    const cutoff = new Date(now.getTime() - Number(mins[1]) * 60 * 1000);
    return { cutoff, since: formatDate(cutoff) };
  }
  const secs = s.match(/^(\d+(?:\.\d+)?)s$/);
  if (secs) {
    const cutoff = new Date(now.getTime() - Number(secs[1]) * 1000);
    return { cutoff, since: formatDate(cutoff) };
  }
  throw new Error(`unrecognized \`since\` value ${JSON.stringify(raw)} (want YYYY-MM-DD, RFC3339, or duration like "7d"/"168h")`);
}
