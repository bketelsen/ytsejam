import { createHash } from "node:crypto";
import type { MemorySystem } from "ltm";

export type ParsedObservation = {
  text: string;
  timestamp: string;
  tags: string[];
};

// Mirrors the cog SSOT validator in server/src/memory/store/append.ts:7.
// Tags are MANDATORY: at least one [...] group is required. The block may be a
// SINGLE bracketed group `[a, b]` (comma-separated), or a SEQUENCE of bracketed
// groups `[a][b][c]` (multi-bracket, cumulative), or a mixed shape `[a, b][c]`.
// All three forms are valid cog observation shapes used in practice. The body
// after `:` is mandatory and non-empty.
const OBSERVATION_LINE_RE =
  /^-\s+(\d{4}-\d{2}-\d{2})\s+((?:\[[^\]]+\])+)\s*:\s*(.+?)\s*$/;

export function parseObservationLine(line: string): ParsedObservation | null {
  const m = OBSERVATION_LINE_RE.exec(line);
  if (!m) return null;
  const [, date, tagBlock, text] = m;
  if (!text || !text.trim()) return null;
  // Date validity: 2026-13-99 etc. would pass the shape regex but produce
  // an Invalid Date downstream. Mirrors observations-parser.ts:11-12.
  const d = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) {
    return null;
  }
  // Split the captured tag block into individual bracketed groups, then
  // comma-split within each group. Both forms (and the mixed form) flatten
  // to one ordered tag list. TODO: keep this duplicate wire-format parser in
  // sync with consolidated/observations-parser.ts until a shared helper exists.
  const tags = Array.from(tagBlock.matchAll(/\[([^\]]+)\]/g))
    .flatMap((m) => m[1]!.split(",").map((t) => t.trim()))
    .filter((t) => t.length > 0);
  if (tags.length === 0) return null; // [   ] or [, ,] yields zero tags -> invalid per cog SSOT
  return {
    text: text.trim(),
    timestamp: `${date}T00:00:00.000Z`,
    tags,
  };
}

export function computeOrigin(
  domainPath: string,
  filename: string,
  rawLine: string,
): string {
  const basis = `${domainPath}/${filename}\u0000${rawLine}`;
  const hash = createHash("sha256").update(basis, "utf8").digest("hex").slice(0, 12);
  return `cog:${domainPath}/${filename}#${hash}`;
}

// -- LTM mirror -----------------------------------------------------------

const SALIENCE_COG_OBSERVATION = 0.85;

export async function mirrorToLtm(
  ltm: MemorySystem,
  parsed: ParsedObservation,
  origin: string,
): Promise<{ ok: true } | { ok: false; error: Error }> {
  try {
    await ltm.recordObservation({
      text: parsed.text,
      timestamp: parsed.timestamp,
      tags: parsed.tags,
      origin,
      salience: SALIENCE_COG_OBSERVATION,
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}
