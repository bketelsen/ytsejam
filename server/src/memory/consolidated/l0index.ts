import type { L0IndexParams, L0IndexResult } from "../types.ts";
import { list, read } from "../store/index.ts";
import { validateParams } from "./params.ts";

const l0RE = /<!--\s*L0:\s*(.+?)\s*-->/;

export async function l0index(params: L0IndexParams = {}): Promise<L0IndexResult> {
  validateParams(params as Record<string, unknown>, ["domain"]);
  const domain = params.domain ?? "";
  const prefix = domain ? domain.replace(/\/+$/, "") + "/" : "";
  const lines: string[] = [];
  for (const path of (await list()).paths) {
    if (prefix && !path.startsWith(prefix)) continue;
    const first = (await read(path)).content.split("\n", 1)[0];
    const match = first.match(l0RE);
    if (match) lines.push(`${path}: ${match[1].trim()}`);
  }
  return { index: lines.join("\n") };
}
