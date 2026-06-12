import type { WikiEntry, WikiIndexResult } from "../types.ts";
import { list, read } from "../store/index.ts";
import { parseFrontmatter, stringArrayField, stringField } from "./frontmatter.ts";

export async function wikiIndexCompute(): Promise<WikiIndexResult> {
  // Mirrors Go's wiki.go: index.md is the auto-generated catalog (derived,
  // not content), and _meta/ holds non-content registry files. Both are
  // excluded from the page index.
  const paths = (await list()).paths.filter((p) =>
    p.startsWith("wiki/") && p.endsWith(".md") && p !== "wiki/index.md" && !p.startsWith("wiki/_meta/"),
  );
  const entries: WikiEntry[] = [];
  for (const path of paths) {
    const entry: WikiEntry = { path, tags: [] };
    const fm = parseFrontmatter((await read(path)).content);
    if (fm) {
      entry.title = stringField(fm, "title");
      entry.summary = stringField(fm, "summary");
      entry.updated = stringField(fm, "updated");
      entry.category = stringField(fm, "entity_type");
      entry.status = stringField(fm, "status");
      entry.tags = stringArrayField(fm, "tags") ?? [];
      entry.related = stringArrayField(fm, "related");
    }
    entries.push(entry);
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, count: entries.length };
}
