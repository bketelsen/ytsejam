import { readFile } from "node:fs/promises";
import type { AppendResult } from "../types.ts";
import { atomicWrite } from "./fs.ts";
import { maybeAutoCommit } from "./auto-commit.ts";
import { withFileLock } from "./file-lock.ts";
import { rejectIDAsPath, resolveMemoryPath } from "./paths.ts";

const obsLineRE = /^-\s+\d{4}-\d{2}-\d{2}\s+\[.+\]:\s*.+$/;
const headingRE = /^(#{1,6})\s+(.+?)\s*$/;

export async function append(path: string, text: string, options: { section?: string } = {}): Promise<AppendResult> {
  const { abs, rel } = await resolveMemoryPath(path);
  await rejectIDAsPath(rel);
  if (rel.endsWith("observations.md")) validateObsLines(text);
  // Serialize the read-modify-write against concurrent mutations of the SAME
  // file so a parallel append/patch can't clobber this one (lost update).
  const appendResult = await withFileLock(abs, () =>
    options.section
      ? appendUnderSection(abs, rel, options.section, text)
      : appendAtEOF(abs, text),
  );
  await maybeAutoCommit();
  return appendResult;
}

async function appendAtEOF(abs: string, text: string): Promise<AppendResult> {
  let existing = "";
  try { existing = await readFile(abs, "utf8"); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  const separator = existing && !existing.endsWith("\n") && !text.startsWith("\n") ? "\n" : "";
  const trailing = text.endsWith("\n") ? "" : "\n";
  const final = existing + separator + text + trailing;
  await atomicWrite(abs, final);
  return appendResult(existing, final);
}

async function appendUnderSection(abs: string, rel: string, section: string, text: string): Promise<AppendResult> {
  let existing: string;
  try { existing = await readFile(abs, "utf8"); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`store: append section ${JSON.stringify(section)}: file ${JSON.stringify(rel)} does not exist (create it first)`);
    throw err;
  }
  const want = section.trim().replace(/^#+/, "").trim();
  if (!want) throw new Error("store: append section: empty section name");
  const lines = existing.split("\n");
  let start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headingRE);
    if (m && m[2].trim().toLowerCase() === want.toLowerCase()) { start = i; level = m[1].length; break; }
  }
  if (start < 0) throw new Error(`store: append section ${JSON.stringify(section)}: heading not found in ${JSON.stringify(rel)}`);
  let end = lines.length;
  for (let j = start + 1; j < lines.length; j++) {
    const m = lines[j].match(headingRE);
    if (m && m[1].length <= level) { end = j; break; }
  }
  let insertAt = end;
  while (insertAt > start + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  const block = text.replace(/\n+$/, "").split("\n");
  const next = [...lines.slice(0, insertAt)];
  if (insertAt === start + 1) next.push("");
  next.push(...block);
  if (end < lines.length) next.push("", ...lines.slice(end));
  else if (lines.at(-1) === "") next.push("");
  let out = next.join("\n");
  if (!out.endsWith("\n")) out += "\n";
  await atomicWrite(abs, out);
  return appendResult(existing, out);
}

function appendResult(before: string, after: string): AppendResult {
  const priorBytes = Buffer.byteLength(before);
  const totalBytes = Buffer.byteLength(after);
  return {
    ok: true,
    bytes_written: totalBytes - priorBytes,
    total_bytes: totalBytes,
  };
}

function validateObsLines(text: string): void {
  const bad = text.split("\n").map((l) => l.trim()).filter((l) => l && !obsLineRE.test(l));
  if (bad.length) throw new Error(`store: observation format invalid; expected "- YYYY-MM-DD [tags]: text"; bad lines: ${bad.join(" | ")}`);
}
