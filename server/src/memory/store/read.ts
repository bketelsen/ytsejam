import { readFile } from "node:fs/promises";
import type { ReadOptions, ReadResult } from "../types.ts";
import { resolveMemoryPath } from "./paths.ts";
import { splitLines } from "./fs.ts";
import { list } from "./list.ts";
import { l0Index } from "./outline.ts";

export async function read(path: string, options: ReadOptions = {}): Promise<ReadResult> {
  if (path === "LIST") return { content: (await list()).paths.join("\n"), found: true };
  if (path === "L0_INDEX") { const content = await l0Index(); return { content, found: content !== "" }; }
  const { abs, rel } = await resolveMemoryPath(path);
  let content: string;
  try { content = await readFile(abs, "utf8"); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { content: "", found: false };
    throw err;
  }
  if (options.section) content = extractSection(rel, content, options.section);
  else if ((options.start ?? 0) > 0 || (options.end ?? 0) > 0) content = extractLineRange(content, options.start ?? 0, options.end ?? 0);
  return { content, found: content !== "" };
}

function extractSection(rel: string, content: string, section: string): string {
  const lines = splitLines(content);
  const target = normalizeHeading(section).toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toLowerCase() !== target) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) if (lines[j].trim().startsWith("##")) { end = j; break; }
    let sectionText = lines.slice(i, end).join("\n");
    while (sectionText.endsWith("\n\n")) sectionText = sectionText.slice(0, -1);
    return sectionText.endsWith("\n") || sectionText === "" ? sectionText : sectionText + "\n";
  }
  throw new Error(`store: section not found in ${JSON.stringify(rel)}: ${section}`);
}
function normalizeHeading(s: string): string { const t = s.trim(); return t.startsWith("##") ? t : `## ${t}`; }
function extractLineRange(content: string, start: number, end: number): string {
  const lines = splitLines(content); if (lines.length === 0) return "";
  const clamp = (n: number) => Math.max(1, Math.min(n, lines.length));
  const s = clamp(start || 1), e = clamp(end || lines.length);
  return s > e ? "" : lines.slice(s - 1, e).join("\n");
}
