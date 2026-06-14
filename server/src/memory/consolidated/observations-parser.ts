import type { RecentObservation } from "../types.ts";
import { splitLines } from "./common.ts";
import { parseObservationLine as parseObservationGrammarLine } from "./observation-grammar.ts";
import { skipMarkdownNoise } from "./open-actions.ts";

export function parseObservationLine(domain: string, path: string, line: number, raw: string): RecentObservation | null {
  const parsed = parseObservationGrammarLine(raw);
  if (!parsed) return null;
  const d = new Date(`${parsed.date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== parsed.date) return null;
  if (parsed.tags.length === 0) return null;
  if (!parsed.text) return null;
  return { domain, path, line, date: parsed.date, tags: parsed.tags, text: parsed.text };
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

export { primaryTagFromObservationLine } from "./observation-grammar.ts";
