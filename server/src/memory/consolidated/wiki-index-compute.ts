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
      const title = stringField(fm, "title");
      if (title !== undefined) entry.title = title;
      const summary = stringField(fm, "summary");
      if (summary !== undefined) entry.summary = summary;
      const updated = stringField(fm, "updated");
      if (updated !== undefined) entry.updated = updated;
      const category = stringField(fm, "entity_type");
      if (category !== undefined) entry.category = category;
      const status = stringField(fm, "status");
      if (status !== undefined) entry.status = status;
      const tags = stringArrayField(fm, "tags");
      if (tags !== undefined) entry.tags = tags;
      const related = stringArrayField(fm, "related");
      if (related !== undefined && related.length > 0) entry.related = related;
    }
    entries.push(entry);
  }
  // walk.ts also sorts byte-wise; keep this cheap defensive sort so the
  // consolidated index contract does not depend on the store helper.
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, count: entries.length };
}
