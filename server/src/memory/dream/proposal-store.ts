import fs from "node:fs"; import path from "node:path";
import type { Proposal } from "./types.ts";

export function keyOf(p: Proposal): string {
  return `${p.kind}:${[...p.factIds].sort().join(",")}:${p.add?.predicate ?? ""}:${p.add?.object ?? ""}`;
}

/** Append-only JSONL of proposals; latest-wins fold per id (mirrors the fact log). */
export class ProposalStore {
  private file: string;
  private map: Map<string, Proposal>;
  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "pending-proposals.jsonl");
    this.map = new Map();
    if (fs.existsSync(this.file)) {
      for (const line of fs.readFileSync(this.file, "utf8").split("\n")) {
        const t = line.trim(); if (!t) continue;
        try { const r = JSON.parse(t) as Proposal; if (r.id) this.map.set(r.id, r); } catch { /* skip */ }
      }
    }
  }
  private append(p: Proposal): void { fs.appendFileSync(this.file, JSON.stringify(p) + "\n"); }
  save(ps: Proposal[]): void { for (const p of ps) { this.map.set(p.id, p); this.append(p); } }
  pending(): Proposal[] { return [...this.map.values()].filter((p) => p.status === "pending"); }
  get(id: string): Proposal | undefined { return this.map.get(id); }
  setStatus(id: string, status: Proposal["status"]): void {
    const p = this.map.get(id); if (!p) return;
    const updated = { ...p, status }; this.map.set(id, updated); this.append(updated);
  }
  /** Keys of dismissed proposals — the miner excludes these (anti-thrash). */
  dismissedKeys(): Set<string> {
    const out = new Set<string>();
    for (const p of this.map.values()) if (p.status === "dismissed") out.add(keyOf(p));
    return out;
  }
}
