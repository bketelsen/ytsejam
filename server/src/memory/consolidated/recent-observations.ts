import * as store from "../store/index.ts";
import type { RecentObservation, RecentObservationsParams, RecentObservationsResult } from "../types.ts";
import { controller, resolveSince } from "./common.ts";
import { parseObservationFile } from "./observations-parser.ts";
import { validateParams } from "./params.ts";

export async function recentObservations(params: RecentObservationsParams = {}): Promise<RecentObservationsResult> {
  validateParams(params, ["since", "domain", "by_tag"] as const);
  const { since } = resolveSince(params.since ?? "");
  const c = controller();
  let targets: { domain: string; path: string }[];
  if (params.domain) {
    const d = c.get(params.domain);
    if (!d.files?.includes("observations")) throw new Error(`domain ${JSON.stringify(d.id)} does not declare file "observations"`);
    targets = c.observations(d.id).map(({ domain, path }) => ({ domain, path }));
  } else {
    targets = c.observations().map(({ domain, path }) => ({ domain, path }));
  }

  const entries: RecentObservation[] = [];
  for (const t of targets.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    const file = await store.read(t.path);
    if (!file.found) continue;
    for (const e of parseObservationFile(t.domain, t.path, file.content)) {
      if (e.date < since) continue;
      if (params.by_tag && !e.tags.includes(params.by_tag)) continue;
      entries.push(e);
    }
  }
  entries.sort((a, b) => a.date !== b.date ? (a.date > b.date ? -1 : 1) : a.path !== b.path ? (a.path < b.path ? -1 : 1) : a.line - b.line);
  const by_domain: Record<string, number> = {};
  const by_tag: Record<string, number> = {};
  for (const e of entries) {
    by_domain[e.domain] = (by_domain[e.domain] ?? 0) + 1;
    for (const tag of e.tags) by_tag[tag] = (by_tag[tag] ?? 0) + 1;
  }
  return { since, entries, by_domain, by_tag };
}
