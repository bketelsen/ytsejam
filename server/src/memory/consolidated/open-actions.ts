import * as store from "../store/index.ts";
import type { OpenActionItem, OpenActionsParams, OpenActionsResult } from "../types.ts";
import { controller, splitLines } from "./common.ts";
import { validateParams } from "./params.ts";

export function skipMarkdownNoise(trimmed: string, state: { inComment: boolean; inFence: boolean }): boolean {
  if (state.inComment) {
    if (trimmed.includes("-->")) state.inComment = false;
    return true;
  }
  if (trimmed.startsWith("<!--")) {
    if (!trimmed.includes("-->")) state.inComment = true;
    return true;
  }
  if (state.inFence) {
    if (isFenceLine(trimmed)) state.inFence = false;
    return true;
  }
  if (isFenceLine(trimmed)) {
    state.inFence = true;
    return true;
  }
  return false;
}

function isFenceLine(trimmed: string): boolean {
  return trimmed.startsWith("```") || trimmed.startsWith("~~~");
}

export function parseOpenActionItem(domain: string, path: string, line: number, raw: string): OpenActionItem | null {
  if (!raw.startsWith("- [ ] ")) return null;
  const body = raw.slice("- [ ] ".length).trim();
  if (!body) return null;
  const parts = body.split("|");
  const text = (parts[0] ?? "").trim();
  if (!text) return null;
  const item: OpenActionItem = { domain, path, line, text, raw };
  for (const part of parts.slice(1)) {
    const idx = part.indexOf(":");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim().toLowerCase();
    const value = part.slice(idx + 1).trim();
    if (key === "due") item.due = value;
    else if (key === "pri" || key === "priority") item.priority = value;
    else if (key === "added") item.added = value;
  }
  return item;
}

export async function scanOpenActions(targets: { domain: string; path: string }[]): Promise<OpenActionItem[]> {
  const items: OpenActionItem[] = [];
  for (const t of [...targets].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    const file = await store.read(t.path);
    if (!file.found) continue;
    const state = { inComment: false, inFence: false };
    let lineNo = 0;
    for (const line of splitLines(file.content)) {
      lineNo++;
      const trimmed = line.trim();
      if (skipMarkdownNoise(trimmed, state) || !trimmed.startsWith("- [ ] ")) continue;
      const item = parseOpenActionItem(t.domain, t.path, lineNo, trimmed);
      if (item) items.push(item);
    }
  }
  return items;
}

export async function openActions(params: OpenActionsParams = {}): Promise<OpenActionsResult> {
  validateParams(params, ["domain"] as const);
  const c = controller();
  let targets: { domain: string; path: string }[];
  if (params.domain) {
    const d = c.resolve(params.domain);
    if (!d.files?.includes("action-items")) throw new Error(`domain ${JSON.stringify(d.id)} does not declare file "action-items"`);
    targets = c.actionItems(d.id);
  } else {
    targets = c.actionItems();
  }
  return { items: await scanOpenActions(targets) };
}
