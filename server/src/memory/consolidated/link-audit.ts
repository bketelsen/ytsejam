import type { LinkAuditCandidate, LinkAuditResult } from "../types.ts";
import { markdownFiles, readRel, splitLines, validateParams } from "./common.ts";

const headingRE = /^###\s+(.+?)\s*$/;
const linkRE = /\[\[([^\[\]]+?)\]\]/g;
interface Entity { name: string; target: string; source: string }
export async function linkAudit(params: Record<string, unknown> = {}): Promise<LinkAuditResult> {
  validateParams(params, []);
  const files = await markdownFiles();
  const entities: Entity[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (!(f.rel.endsWith("/entities.md") || f.rel === "entities.md")) continue;
    const data = await readRel(f.rel); if (data == null) continue;
    const source = f.rel.replace(/\.md$/, "");
    for (const line of splitLines(data)) {
      const m = line.match(headingRE); if (!m) continue;
      const name = stripLinkAuditParenSuffix(m[1]); if (name.length < 2) continue;
      const key = `${source}#${name}`; if (seen.has(key)) continue; seen.add(key);
      entities.push({ name, target: key, source });
    }
  }
  const candidates: LinkAuditCandidate[] = [];
  for (const f of files) {
    const data = await readRel(f.rel); if (data == null) continue;
    const source = f.rel.replace(/\.md$/, "");
    splitLines(data).forEach((line, i) => {
      const spans = [...line.matchAll(linkRE)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length] as const);
      for (const e of entities) {
        if (source === e.source) continue;
        const pos = wholeWordIndex(line, e.name); if (pos < 0) continue;
        if (spans.some(([a,b]) => pos < b && pos + e.name.length > a)) continue;
        candidates.push({ source_path: f.rel, line: i + 1, entity_name: e.name, target_link: e.target, context: line.trim() });
      }
    });
  }
  candidates.sort((a,b) => a.source_path.localeCompare(b.source_path) || a.line - b.line || a.entity_name.localeCompare(b.entity_name));
  return { candidates };
}

function stripLinkAuditParenSuffix(name: string): string {
  // Matches Go store/link.go:226 — strips at the FIRST " (" not the last.
  // Diverges intentionally from `stripParenSuffix` (used by entity_audit per
  // Go's internal inconsistency).
  const idx = name.indexOf(" (");
  return idx === -1 ? name : name.slice(0, idx).trim();
}

function wholeWordIndex(line: string, name: string): number {
  let at = 0;
  for (;;) { const pos = line.indexOf(name, at); if (pos < 0) return -1; const end = pos + name.length; if (boundary(line, pos - 1) && boundary(line, end)) return pos; at = pos + 1; }
}
function boundary(s: string, i: number): boolean { return i < 0 || i >= s.length || !/[A-Za-z0-9_]/.test(s[i]); }
