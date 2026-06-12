import type { GlacierEntry, GlacierIndexResult } from "../types.ts";
import { list, read } from "../store/index.ts";
import { numberField, parseFrontmatter, stringArrayField, stringField } from "./frontmatter.ts";

export async function glacierIndexCompute(): Promise<GlacierIndexResult> {
  const paths = (await list()).paths.filter((p) => p.startsWith("glacier/") && p.endsWith(".md"));
  const entries: GlacierEntry[] = [];
  for (const path of paths) {
    const entry: GlacierEntry = { path, tags: [] };
    const content = (await read(path)).content;
    const fm = parseFrontmatter(content);
    if (fm) {
      entry.domain = stringField(fm, "domain");
      entry.type = stringField(fm, "type");
      entry.tags = stringArrayField(fm, "tags") ?? [];
      entry.date_range = stringField(fm, "date_range");
      entry.entries = numberField(fm, "entries");
      entry.summary = stringField(fm, "summary");
    }
    entries.push(entry);
  }
  return { entries, count: entries.length };
}
