import type { EntityAuditParams, EntityAuditResult } from "../types.ts";
import { controller, readRel, splitLines, stripParenSuffix, validateParams } from "./common.ts";

const headingRE = /^###\s+(.+?)\s*$/;
const detailLinkRE = /\[\[wiki:[^\]]+\]\]/;
const untilRE = /\(until\s+(\d{4}-\d{2})\)/g;

export async function entityAudit(params: EntityAuditParams = {}): Promise<EntityAuditResult> {
  validateParams(params as Record<string, unknown>, ["domain"]);
  const c = controller();
  const targets = params.domain ? (c.resolveFile(params.domain, "entities"), c.entities(params.domain)) : c.entities();
  const res: EntityAuditResult = { format_violations: [], glacier_candidates: [], missing_metadata: [], temporal_violations: [], total_entries: 0, total_lines: 0 };
  for (const t of targets.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    const data = await readRel(t.path);
    if (data == null) continue;
    auditOne(res, t.domain, t.path, data, new Date());
  }
  return res;
}

interface Block { name: string; body: string[]; lines: number[] }
function auditOne(res: EntityAuditResult, domain: string, path: string, data: string, now: Date): void {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  splitLines(data).forEach((raw, i) => {
    const m = raw.match(headingRE);
    if (m) { if (cur) blocks.push(cur); cur = { name: stripParenSuffix(m[1]), body: [], lines: [] }; return; }
    if (cur) { cur.body.push(raw); cur.lines.push(i + 1); }
  });
  if (cur) blocks.push(cur);

  for (const b of blocks) {
    let count = 1, hasDetail = false, hasStatus = false, hasLast = false, status = "", last = "";
    b.body.forEach((line, i) => {
      const trim = line.trim();
      if (!trim || trim.startsWith("<!--")) return;
      count++;
      if (detailLinkRE.test(line)) hasDetail = true;
      const st = field(line, "status"); if (st != null) { hasStatus = true; status = st; }
      const la = field(line, "last"); if (la != null) { hasLast = true; last = la; }
      for (const m of line.matchAll(untilRE)) {
        const start = m.index ?? 0, end = start + m[0].length;
        if (pastYYYYMM(m[1], now) && !(line.slice(start - 2, start) === "~~" && line.slice(end, end + 2) === "~~")) {
          res.temporal_violations.push({ path, domain, name: b.name, line: b.lines[i], text: trim, needs: "strikethrough" });
        }
      }
    });
    res.total_entries++; res.total_lines += count;
    if (count > 3) res.format_violations.push({ path, domain, name: b.name, lines: count, issue: "exceeds_3_line_compact", has_detail_file: hasDetail });
    const missing = [...(!hasStatus ? ["status"] : []), ...(!hasLast ? ["last"] : [])];
    if (missing.length) res.missing_metadata.push({ path, domain, name: b.name, missing });
    const age_days = hasLast ? ageDays(last, now) : -1;
    if (status.toLowerCase() === "inactive" || age_days > 180) res.glacier_candidates.push({ path, domain, name: b.name, status, last, age_days });
  }
}
function field(line: string, name: string): string | null {
  const prefix = `${name.toLowerCase()}:`;
  for (const part of line.split("|")) {
    const trim = part.trim();
    if (!trim.toLowerCase().startsWith(prefix)) continue;
    let val = trim.slice(prefix.length).trim();
    const cut = val.indexOf(" ("); if (cut > 0) val = val.slice(0, cut).trim();
    return val;
  }
  return null;
}
function ageDays(s: string, now: Date): number {
  const d = new Date(`${s.trim()}T00:00:00Z`); if (Number.isNaN(d.getTime())) return -1;
  const diff = now.getTime() - d.getTime(); return diff > 0 ? Math.floor(diff / 86400000) : 0;
}
function pastYYYYMM(s: string, now: Date): boolean {
  const d = new Date(`${s}-01T00:00:00Z`); if (Number.isNaN(d.getTime())) return false;
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return d < month;
}
