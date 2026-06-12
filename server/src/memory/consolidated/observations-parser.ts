import type { RecentObservation } from "../types.ts";
import { splitLines } from "./common.ts";
import { skipMarkdownNoise } from "./open-actions.ts";

const obsLineRE = /^-\s+(\d{4}-\d{2}-\d{2})\s+\[([^\]]+)\]:\s*(.+)$/;

export function parseObservationLine(domain: string, path: string, line: number, raw: string): RecentObservation | null {
  const m = raw.match(obsLineRE);
  if (!m) return null;
  const date = m[1];
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) return null;
  const tags = m[2].split(",").map((t) => t.trim()).filter(Boolean);
  return { domain, path, line, date, tags, text: m[3].trim() };
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
  const m = line.trim().match(/^-\s+\d{4}-\d{2}-\d{2}\s+\[([^\]]+)\]:/);
  if (!m) return null;
  return (m[1].split(",", 1)[0] ?? "").trim() || "(untagged)";
}
