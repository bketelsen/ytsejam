import { readFile } from "node:fs/promises";
import type { StatsResult, FileStats } from "../types.ts";
import { countLines } from "./fs.ts";
import { scanFiles } from "./walk.ts";

export async function stats(prefix = ""): Promise<StatsResult> {
  const per_file: FileStats[] = [];
  let lines = 0, size = 0;
  for (const f of await scanFiles({ prefix })) {
    const data = await readFile(f.abs).catch(() => Buffer.alloc(0));
    const n = countLines(data);
    lines += n; size += f.size;
    per_file.push({ path: f.rel, lines: n, size: f.size, modified: f.mtime.toISOString().replace(/\.\d{3}Z$/, "Z") });
  }
  return { files: per_file.length, lines, size, per_file };
}
