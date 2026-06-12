import { readFile } from "node:fs/promises";
import type { SearchResults, SearchResult } from "../types.ts";
import { scanFiles } from "./walk.ts";

/**
 * Case-insensitive literal substring search across all .md files.
 * Matches the Go reference: `strings.Contains(strings.ToLower(line), strings.ToLower(query))`.
 * NOT a regex — regex metacharacters in the query are matched literally and never throw.
 */
export async function search(query: string): Promise<SearchResults> {
  const needle = query.toLowerCase();
  const results: SearchResult[] = [];
  for (const f of await scanFiles()) {
    const lines = (await readFile(f.abs, "utf8").catch(() => "")).split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        results.push({ path: f.rel, line: i + 1, text: lines[i] });
      }
    }
  }
  return { results, count: results.length };
}
