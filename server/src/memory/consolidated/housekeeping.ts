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
  // Global tier: cross-project rules in cog-meta/patterns.md (always loaded
  // via session-brief). Tightened from the band-aid 8000B back to a real
  // cap now that ytsejam-specific rules have moved to per-domain tier.
  global_patterns_lines: 70,
  global_patterns_bytes: 6000,
  // Per-domain tier: project-specific rules in {domain-path}/patterns.md
  // (loaded only when the domain skill activates — NOT injected every turn,
  // so this tier can be larger than the global cap without per-session cost).
  // Raised 40/3500 -> 60/8000 (2026-06-18) to match the files' load-bearing
  // density: projects/ytsejam/patterns.md self-declares an 8KB ceiling and
  // absorbed the develop-loop / harness / test-validation rules moved off the
  // global tier. Domain patterns had been flagged over-cap on 12 distinct
  // dates and hand-compressed each time; the recurrence is the signal the cap
  // was too tight, not that the content was bloated.
  domain_patterns_lines: 60,
  domain_patterns_bytes: 8000,
  decisions_entries: 100,
  decisions_age_months: 6,
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
    domain_patterns_over_cap: [],
    decisions_over_cap: [],
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
  for (const t of c.decisions()) {
    const content = await readOptional(t.path);
    if (content == null) continue;
    scanDecisions(t.path, content, result, now);
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
  await scanGlobalPatterns("cog-meta/patterns.md", result);
  await scanDomainPatterns(result, all);

  result.thresholds.observations_over_cap.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  result.thresholds.completed_actions_over_cap.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  result.thresholds.hot_memory_over_cap.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  result.thresholds.decisions_over_cap.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
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

function scanDecisions(path: string, content: string, result: HousekeepingScan, now: Date): void {
  let entries = 0;
  let headDate = ""; // earliest YYYY-MM-DD seen — head of the file
  // Match the entry shape from Task 1's template / Task 3's rule #9:
  // "- YYYY-MM-DD [d-<slug>]: <body>"
  const entryRE = /^-\s+(\d{4}-\d{2}-\d{2})\s+\[d-[a-z0-9-]+\]:/;
  for (const line of splitLines(content)) {
    const m = line.trim().match(entryRE);
    if (!m) continue;
    entries++;
    if (headDate === "" || m[1] < headDate) headDate = m[1];
  }
  if (entries > caps.decisions_entries) {
    result.thresholds.decisions_over_cap.push({
      path,
      entries,
      cap: caps.decisions_entries,
      reason: "count",
    });
    return; // count-cap wins; don't double-flag
  }
  if (headDate) {
    const headTime = new Date(`${headDate}T00:00:00Z`);
    const cutoffMs = caps.decisions_age_months * 30 * 24 * 60 * 60 * 1000;
    const cutoff = new Date(now.getTime() - cutoffMs);
    if (headTime < cutoff) {
      result.thresholds.decisions_over_cap.push({
        path,
        entries,
        cap: caps.decisions_entries,
        reason: "age",
      });
    }
  }
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

async function scanGlobalPatterns(path: string, result: HousekeepingScan): Promise<void> {
  const content = await readOptional(path);
  if (content == null) return;
  const lines = countLines(content);
  const size = Buffer.byteLength(content);
  if (lines > caps.global_patterns_lines || size > caps.global_patterns_bytes) {
    result.thresholds.patterns_over_cap.push({
      path,
      lines,
      size,
      lines_cap: caps.global_patterns_lines,
      size_cap: caps.global_patterns_bytes,
    });
  }
}

async function scanDomainPatterns(
  result: HousekeepingScan,
  all: { per_file: { path: string; lines: number; size: number }[] },
): Promise<void> {
  // Per-domain patterns: any {path}/patterns.md anywhere under the memory
  // root EXCEPT cog-meta/ (the global tier, scanned separately) and
  // glacier/** (read-only archives). Hardcoded exclusions rather than
  // intersecting with domains.yml so orphaned files (e.g. patterns.md left
  // behind by a removed domain) are still surfaced.
  const candidates = all.per_file.filter((f) => {
    if (!f.path.endsWith("/patterns.md")) return false;
    if (f.path === "cog-meta/patterns.md") return false;
    if (f.path.startsWith("glacier/")) return false;
    return true;
  });
  for (const f of candidates) {
    // store.stats() already computed per-file size/line counts; use those
    // instead of re-reading every domain patterns file during housekeeping.
    let lines = f.lines;
    let size = f.size;
    if (!Number.isFinite(lines) || !Number.isFinite(size) || (size > 0 && lines === 0)) {
      const content = await readOptional(f.path);
      if (content == null) continue;
      lines = countLines(content);
      size = Buffer.byteLength(content);
    }
    if (lines > caps.domain_patterns_lines || size > caps.domain_patterns_bytes) {
      result.thresholds.domain_patterns_over_cap.push({
        path: f.path,
        lines,
        size,
        lines_cap: caps.domain_patterns_lines,
        size_cap: caps.domain_patterns_bytes,
      });
    }
  }
  result.thresholds.domain_patterns_over_cap.sort(
    (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
}
