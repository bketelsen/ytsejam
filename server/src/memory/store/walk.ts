import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { ensureRoot, normalizeRelPath } from "./paths.ts";

export interface ScannedFile { root: string; rel: string; abs: string; size: number; mtime: Date }

export async function scanFiles(options: { markdownOnly?: boolean; prefix?: string } = {}): Promise<ScannedFile[]> {
  const root = await ensureRoot();
  const trimmedPrefix = options.prefix ? options.prefix.replace(/^\/+|\/+$/g, "") : "";
  const prefix = trimmedPrefix ? normalizeRelPath(trimmedPrefix).replace(/\/$/, "") : "";
  const out: ScannedFile[] = [];
  async function walk(dir: string, relDir: string): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const abs = path.join(dir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { await walk(abs, rel); continue; }
      if (!entry.isFile() || rel.endsWith(".tmp")) continue;
      if (options.markdownOnly && !rel.endsWith(".md")) continue;
      if (prefix && rel !== prefix && !rel.startsWith(prefix + "/")) continue;
      const info = await stat(abs);
      out.push({ root, rel, abs, size: info.size, mtime: info.mtime });
    }
  }
  await walk(root, "");
  // Go uses plain string ordering (byte-wise for UTF-8 paths); avoid localeCompare
  // so case and punctuation order match sort.Strings.
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}
