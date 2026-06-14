import type { RecentObservation } from "../types.ts";
import { splitLines } from "./common.ts";
import { skipMarkdownNoise } from "./open-actions.ts";

const obsLineRE =
  /^-\s+(\d{4}-\d{2}-\d{2})\s+((?:\[[^\]]+\])+):\s*(.+)$/;

export function parseObservationLine(domain: string, path: string, line: number, raw: string): RecentObservation | null {
  const m = raw.match(obsLineRE);
  if (!m) return null;
  const date = m[1];
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) return null;
  // Split the captured tag block into individual bracketed groups, then
  // comma-split within each group. Both forms (and the mixed form) flatten
  // to one ordered tag list. TODO: keep this duplicate wire-format parser in
  // sync with bridge/ltm-observer.ts until a shared helper exists.
  const tags = Array.from(m[2].matchAll(/\[([^\]]+)\]/g))
    .flatMap((match) => match[1]!.split(",").map((t) => t.trim()))
    .filter((t) => t.length > 0);
  if (tags.length === 0) return null;
  const text = m[3].trim();
  if (!text) return null;
  return { domain, path, line, date, tags, text };
}

export function parseObservationFile(domain: string, path: string, content: string, options: { skipNoise: boolean } = { skipNoise: true }): RecentObservation[] {
  const out: RecentObservation[] = [];
  const state = { inComment: false, inFence: false };
  let lineNo = 0;
  for (const line of splitLines(content)) {
    lineNo++;
    const trimmed = line.trim();
    if (options.skipNoise && skipMarkdownNoise(trimmed, state)) continue;
    const entry = parseObservationLine(domain, path, lineNo, trimmed);
    if (entry) out.push(entry);
  }
  return out;
}

export function primaryTagFromObservationLine(line: string): string | null {
  const m = line.trim().match(/^-\s+\d{4}-\d{2}-\d{2}\s+((?:\[[^\]]+\])+):/);
  if (!m) return null;
  const first = Array.from(m[1].matchAll(/\[([^\]]+)\]/g))[0]?.[1] ?? "";
  return (first.split(",", 1)[0] ?? "").trim() || "(untagged)";
}
