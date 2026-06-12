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
      const domain = stringField(fm, "domain");
      if (domain !== undefined) entry.domain = domain;
      const type = stringField(fm, "type");
      if (type !== undefined) entry.type = type;
      const tags = stringArrayField(fm, "tags");
      if (tags !== undefined) entry.tags = tags;
      const dateRange = stringField(fm, "date_range");
      if (dateRange !== undefined) entry.date_range = dateRange;
      const entriesCount = numberField(fm, "entries");
      if (entriesCount !== undefined) {
        const truncated = Math.trunc(entriesCount);
        if (truncated !== 0) entry.entries = truncated;
      }
      const summary = stringField(fm, "summary");
      if (summary !== undefined) entry.summary = summary;
    }
    entries.push(entry);
  }
  // walk.ts also sorts byte-wise; keep this cheap defensive sort so the
  // consolidated index contract does not depend on the store helper.
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, count: entries.length };
}
