import path from "node:path";
import * as store from "../store/index.ts";
import type { HousekeepingScan, HousekeepingThresholds, StaleActionItem } from "../types.ts";
import { controller, countLines, fileModifiedDate, formatRFC3339Seconds, splitLines } from "./common.ts";
import { primaryTagFromObservationLine } from "./observations-parser.ts";
import { parseOpenActionItem, skipMarkdownNoise } from "./open-actions.ts";

const caps = {
  observations_entries: 50,
  completed_actions: 10,
  improvements_done: 10,
  hot_memory_lines: 50,
  patterns_lines: 70,
  // TODO(tiered-patterns): temporarily raised 5500→8000 (2026-06-14) to
  // accommodate calibrated multi-failure-mode rules accumulated since the
  // ytsejam supernova. Structural fix is the tiered-patterns split (global
  // <4KB + per-domain <2KB each loaded on activation) tracked as the top
  // wishlist item in cog-meta/improvements.md. Restore to 5500 (or a new
  // global-tier cap) when tiered patterns ships.
  patterns_bytes: 8000,
  dormant_domain_days: 28,
  stale_action_item_days: 14,
  changed_recently_fallback_days: 7,
};
const markerPath = "cog-meta/.housekeeping-marker";
const addedDateRE = /\badded:\s*(\d{4}-\d{2}-\d{2})/i;

async function readOptional(path: string): Promise<string | null> {
  const r = await store.read(path);
  return r.found ? r.content : null;
}

function emptyThresholds(): HousekeepingThresholds {
  return {
    observations_over_cap: [],
    completed_actions_over_cap: [],
    improvements_implemented_over_cap: [],
    hot_memory_over_cap: [],
    patterns_over_cap: [],
  };
}

export async function housekeepingScan(params: object = {}): Promise<HousekeepingScan> {
  if (Object.keys(params).length) throw new Error(`unknown param key: ${Object.keys(params)[0]}`);
  const c = controller();
  const now = new Date();
  const markerMtime = await fileModifiedDate(markerPath);
  const cutoff = markerMtime ?? new Date(now.getTime() - caps.changed_recently_fallback_days * 24 * 60 * 60 * 1000);
  const result: HousekeepingScan = {
    since: markerMtime ? formatRFC3339Seconds(markerMtime) : "",
    changed_recently: [],
    thresholds: emptyThresholds(),
    dormant_domains: [],
    stale_action_items: [],
  };

  const all = await store.stats();
  result.changed_recently = all.per_file
    .filter((f) => f.path !== markerPath && new Date(f.modified) > cutoff)
    .map((f) => f.path)
    .sort();

  for (const t of c.observations()) {
    const content = await readOptional(t.path);
    if (content == null) continue;
    scanObservations(t.domain, t.path, content, result, now);
  }
  for (const t of c.actionItems()) {
    const content = await readOptional(t.path);
    if (content == null) continue;
    scanActionItems(t.path, content, result, now);
  }
  for (const d of c.list()) {
    if (!d.files?.includes("hot-memory")) continue;
    let rel: string;
    try { rel = path.relative(c.root, c.resolveFile(d.id, "hot-memory")).replaceAll("\\", "/"); }
    catch { continue; }
    await scanHotMemory(rel, result);
  }
  await scanHotMemory("hot-memory.md", result);
  await scanImprovements("cog-meta/improvements.md", result);
  await scanPatterns("cog-meta/patterns.md", result);

  result.thresholds.observations_over_cap.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  result.thresholds.completed_actions_over_cap.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  result.thresholds.hot_memory_over_cap.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  result.dormant_domains.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  result.stale_action_items.sort((a, b) => a.path !== b.path ? (a.path < b.path ? -1 : 1) : a.line - b.line);
  return result;
}

function scanObservations(domain: string, path: string, content: string, result: HousekeepingScan, now: Date): void {
  let entries = 0;
  let latest = "";
  const by_primary_tag: Record<string, number> = {};
  for (const line of splitLines(content)) {
    const primary = primaryTagFromObservationLine(line);
    if (primary == null) continue;
    entries++;
    by_primary_tag[primary] = (by_primary_tag[primary] ?? 0) + 1;
    const m = line.trim().match(/^-\s+(\d{4}-\d{2}-\d{2})\s+\[/);
    if (m && m[1] > latest) latest = m[1];
  }
  if (entries > caps.observations_entries) {
    result.thresholds.observations_over_cap.push({ path, entries, cap: caps.observations_entries, by_primary_tag });
  }
  const cutoff = new Date(now.getTime() - caps.dormant_domain_days * 24 * 60 * 60 * 1000);
  const latestTime = latest === "" ? null : new Date(`${latest}T00:00:00Z`);
  // Match Go store/housekeeping.go scanDormancy: midnight-of-date vs full
  // 28-day cutoff timestamp. The boundary-date case (latest exactly on
  // the cutoff calendar day) flags dormant, matching Go.
  if (latest === "" || (latestTime != null && latestTime < cutoff)) result.dormant_domains.push({ id: domain, last_observation: latest });
}

function scanActionItems(path: string, content: string, result: HousekeepingScan, now: Date): void {
  let completed = 0;
  const state = { inComment: false, inFence: false };
  let lineNo = 0;
  for (const line of splitLines(content)) {
    lineNo++;
    const trimmed = line.trim();
    if (skipMarkdownNoise(trimmed, state)) continue;
    if (trimmed.startsWith("- [x] ") || trimmed.startsWith("- [X] ")) { completed++; continue; }
    if (!trimmed.startsWith("- [ ] ")) continue;
    const item = parseOpenActionItem("", path, lineNo, trimmed);
    if (!item) continue;
    const added = item.added || trimmed.match(addedDateRE)?.[1] || "";
    if (!added) continue;
    const t = new Date(`${added}T00:00:00Z`);
    if (Number.isNaN(t.getTime())) continue;
    const age_days = Math.floor((now.getTime() - t.getTime()) / (24 * 60 * 60 * 1000));
    if (age_days >= caps.stale_action_item_days) {
      const stale: StaleActionItem = { path, line: lineNo, text: item.text, added, age_days };
      result.stale_action_items.push(stale);
    }
  }
  if (completed > caps.completed_actions) {
    result.thresholds.completed_actions_over_cap.push({ path, completed, cap: caps.completed_actions });
  }
}

async function scanHotMemory(path: string, result: HousekeepingScan): Promise<void> {
  const content = await readOptional(path);
  if (content == null) return;
  const lines = countLines(content);
  if (lines > caps.hot_memory_lines) result.thresholds.hot_memory_over_cap.push({ path, lines, cap: caps.hot_memory_lines });
}

async function scanImprovements(path: string, result: HousekeepingScan): Promise<void> {
  const content = await readOptional(path);
  if (content == null) return;
  let implemented = 0;
  const state = { inComment: false, inFence: false };
  for (const line of splitLines(content)) {
    const trimmed = line.trim();
    if (skipMarkdownNoise(trimmed, state)) continue;
    if (trimmed.startsWith("- [x] ") || trimmed.startsWith("- [X] ")) implemented++;
  }
  if (implemented > caps.improvements_done) result.thresholds.improvements_implemented_over_cap.push({ path, implemented, cap: caps.improvements_done });
}

async function scanPatterns(path: string, result: HousekeepingScan): Promise<void> {
  const content = await readOptional(path);
  if (content == null) return;
  const lines = countLines(content);
  const size = Buffer.byteLength(content);
  if (lines > caps.patterns_lines || size > caps.patterns_bytes) {
    result.thresholds.patterns_over_cap.push({ path, lines, size, lines_cap: caps.patterns_lines, size_cap: caps.patterns_bytes });
  }
}
