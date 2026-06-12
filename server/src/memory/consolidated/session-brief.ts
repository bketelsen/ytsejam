import * as store from "../store/index.ts";
import type { SessionBrief } from "../types.ts";
import { controller } from "./common.ts";
import { scanOpenActions } from "./open-actions.ts";

export async function sessionBrief(params: object = {}): Promise<SessionBrief> {
  if (Object.keys(params).length) throw new Error(`unknown param key: ${Object.keys(params)[0]}`);
  const c = controller();
  const [hot, patterns] = await Promise.all([
    store.read("hot-memory.md"),
    store.read("cog-meta/patterns.md"),
  ]);
  const domains = c.list().map((d) => ({
    id: d.id,
    path: d.path,
    ...(d.label ? { label: d.label } : {}),
    ...(d.triggers ? { triggers: d.triggers } : {}),
  }));
  const action_counts: Record<string, number | boolean> = {};
  let priHigh = false;
  for (const target of c.actionItems()) {
    const items = await scanOpenActions([{ domain: target.domain, path: target.path }]);
    action_counts[target.domain] = items.length;
    if (items.some((i) => i.priority?.toLowerCase() === "high")) priHigh = true;
  }
  action_counts._pri_high_anywhere = priHigh;
  return {
    hot_memory: hot.content,
    patterns: patterns.content,
    domains,
    action_counts,
    controller_last_error: c.lastError?.message ?? null,
  };
}
