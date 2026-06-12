import { readFile } from "node:fs/promises";
import type { SearchResults, SearchResult } from "../types.ts";
import { scanFiles } from "./walk.ts";

export async function search(query: string): Promise<SearchResults> {
  const re = new RegExp(query, "gim");
  const results: SearchResult[] = [];
  for (const f of await scanFiles()) {
    const lines = (await readFile(f.abs, "utf8").catch(() => "")).split("\n");
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (re.test(lines[i])) results.push({ path: f.rel, line: i + 1, text: lines[i] });
    }
  }
  return { results, count: results.length };
}
