import { createHash } from "node:crypto";

export type ParsedObservation = {
  text: string;
  timestamp: string;
  tags: string[];
};

const LINE_RE =
  /^-\s+(\d{4}-\d{2}-\d{2})(?:\s+\[([^\]]*)\])?\s*:\s*(.+?)\s*$/;

export function parseObservationLine(line: string): ParsedObservation | null {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  const [, date, tagBlock, text] = m;
  if (!text || !text.trim()) return null;
  const tags = tagBlock
    ? tagBlock
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    : [];
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
