import { readFile } from "node:fs/promises";
import type { OutlineResult, OutlineEntry } from "../types.ts";
import { resolveMemoryPath } from "./paths.ts";
import { scanFiles } from "./walk.ts";

const l0RE = /^<!--\s*L0:\s*(.+?)\s*-->$/;

export async function outline(path: string): Promise<OutlineResult> {
  const { abs } = await resolveMemoryPath(path);
  const lines = (await readFile(abs, "utf8")).split("\n");
  const entries: OutlineEntry[] = [];
  // L0 header is line-1-only per FORMAT.md. Go's outline.go uses an
  // unanchored regex (matches L0-shaped comments anywhere); we intentionally
  // anchor to line 1 to enforce the spec.
  const l0 = lines[0]?.match(l0RE);
  if (l0) entries.push({ line: 1, text: l0[1].trim(), level: 0 });
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^(#{2,6})\s+(.+?)\s*$/);
    if (h) entries.push({ line: i + 1, text: h[2], level: h[1].length });
  }
  return { entries };
}

export async function l0Index(domain = ""): Promise<string> {
  const prefix = domain ? domain.replace(/\/+$/, "") + "/" : "";
  const lines: string[] = [];
  for (const f of await scanFiles()) {
    if (prefix && !f.rel.startsWith(prefix)) continue;
    const first = (await readFile(f.abs, "utf8").catch(() => "")).split("\n", 1)[0];
    const m = first.match(l0RE);
    if (m) lines.push(`${f.rel}: ${m[1].trim()}`);
  }
  return lines.join("\n");
}
