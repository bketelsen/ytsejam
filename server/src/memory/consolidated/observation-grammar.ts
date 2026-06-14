export const OBSERVATION_LINE_PATTERN =
  /^-\s+(\d{4}-\d{2}-\d{2})\s+((?:\[[^\]]+\])+)\s*:\s*(.*?)\s*$/;

export interface ParsedObservationLine {
  date: string;
  tags: string[];
  text: string;
}

export function parseObservationLine(raw: string): ParsedObservationLine | null {
  const m = OBSERVATION_LINE_PATTERN.exec(raw);
  if (!m) return null;
  const [, date, tagBlock, text] = m;
  const d = new Date(date);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) return null;
  const tags = Array.from(tagBlock.matchAll(/\[([^\]]+)\]/g))
    .flatMap((match) => match[1]!.split(",").map((t) => t.trim()))
    .filter((t) => t.length > 0);
  return { date, tags, text: text.trim() };
}

export function primaryTagFromObservationLine(raw: string): string | null {
  const m = OBSERVATION_LINE_PATTERN.exec(raw.trim());
  if (!m) return null;
  const parsed = parseObservationLine(raw.trim());
  if (!parsed) return null;
  const first = Array.from(m[2].matchAll(/\[([^\]]+)\]/g))[0]?.[1] ?? "";
  return (first.split(",", 1)[0] ?? "").trim() || "(untagged)";
}
