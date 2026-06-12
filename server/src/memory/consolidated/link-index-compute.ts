import type { LinkIndexResult } from "../types.ts";
import { extractFrontmatter, markdownFiles, readRel, validateParams } from "./common.ts";

const linkRE = /\[\[([^\[\]]+?)\]\]/g;
export async function linkIndexCompute(params: Record<string, unknown> = {}): Promise<LinkIndexResult> {
  validateParams(params, []);
  const idx = new Map<string, Set<string>>();
  for (const f of await markdownFiles()) {
    if (f.rel.startsWith("glacier/")) continue;
    const data = await readRel(f.rel); if (data == null) continue;
    const source = f.rel.replace(/\.md$/, "");
    const add = (raw: string) => { const target = normalize(raw); if (target && target !== source) (idx.get(target) ?? idx.set(target, new Set()).get(target)!).add(source); };
    for (const m of data.matchAll(linkRE)) add(m[1]);
    const related = extractFrontmatter(data)?.related;
    if (Array.isArray(related)) for (const r of related) if (typeof r === "string") add(r);
  }
  return { links: [...idx].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([target, sources]) => ({ target, sources: [...sources].sort() })) };
}
export function normalize(raw: string): string { return raw.trim().split("#", 1)[0].replace(/\.md$/, ""); }
