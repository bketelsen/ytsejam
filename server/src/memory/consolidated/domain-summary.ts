import path from "node:path";
import * as store from "../store/index.ts";
import type { DomainSummaryParams, DomainSummaryResult } from "../types.ts";
import { controller, fileModifiedDate, formatDate, resolveSince } from "./common.ts";
import { parseObservationFile } from "./observations-parser.ts";
import { skipMarkdownNoise } from "./open-actions.ts";
import { validateParams } from "./params.ts";

const addedDateRE = /\badded:\s*(\d{4}-\d{2}-\d{2})/i;

export async function countActions(path: string, sinceDate: string): Promise<{ open: number; completed: number }> {
  const file = await store.read(path);
  if (!file.found) return { open: 0, completed: 0 };
  let open = 0, completed = 0;
  const state = { inComment: false, inFence: false };
  for (const line of file.content.split("\n")) {
    const trimmed = line.trim();
    if (skipMarkdownNoise(trimmed, state)) continue;
    if (trimmed.startsWith("- [ ] ")) open++;
    else if (trimmed.startsWith("- [x] ") || trimmed.startsWith("- [X] ")) {
      if (!sinceDate) completed++;
      else {
        const m = trimmed.match(addedDateRE);
        if (m && m[1] >= sinceDate) completed++;
      }
    }
  }
  return { open, completed };
}

export async function domainSummary(params: DomainSummaryParams): Promise<DomainSummaryResult> {
  validateParams(params ?? {}, ["domain", "since"] as const);
  if (!params?.domain) throw new Error("domain required");
  const c = controller();
  const d = c.resolve(params.domain);
  const { since } = resolveSince(params.since ?? "");
  const result: DomainSummaryResult = {
    domain: d.id,
    path: d.path,
    label: d.label ?? "",
    hot_memory: "",
    open_action_count: 0,
    completed_action_count_since: 0,
    recent_observations: [],
    files_present: [],
    last_activity: "",
    since,
  };
  let last: Date | null = null;
  for (const file of d.files ?? []) {
    let rel: string;
    try { rel = path.relative(c.root, c.resolveFile(d.id, file)).replaceAll("\\", "/"); }
    catch { continue; }
    const read = await store.read(rel);
    if (!read.found) continue;
    result.files_present.push(file);
    const mt = await fileModifiedDate(rel);
    if (mt && (!last || mt > last)) last = mt;
    if (file === "hot-memory") result.hot_memory = read.content;
    else if (file === "action-items") {
      const counts = await countActions(rel, since);
      result.open_action_count = counts.open;
      result.completed_action_count_since = counts.completed;
    } else if (file === "observations") {
      const obs = parseObservationFile("", rel, read.content, { skipNoise: false }).filter((e) => e.date >= since);
      result.recent_observations = obs;
      for (const o of obs) {
        const dt = new Date(`${o.date}T00:00:00Z`);
        if (!last || dt > last) last = dt;
      }
    }
  }
  if (last) result.last_activity = formatDate(last);
  return result;
}
