import type { Cluster, ClusterCheckParams, KeywordCluster, SampleObservation, TagCluster, ThreadCandidate } from "../types.ts";
import { controller, readRel, splitLines, validateParams } from "./common.ts";

interface Observation { domain: string; path: string; line: number; date: Date; dateS: string; tags: string[]; text: string }
const obsRE = /^-\s+(\d{4}-\d{2}-\d{2})\s+\[([^\]]+)\]:\s*(.+)$/;
const keywordRE = /[A-Za-z][A-Za-z0-9_-]{3,}/g;
const stopwords = new Set("this that with from have will into been were their they what when then than there about which would could should after before still also just like some more most only your yours ours them http https".split(" "));

export async function clusterCheck(params: ClusterCheckParams = {}): Promise<Cluster> {
  validateParams(params as Record<string, unknown>, ["domain", "min_cluster_size", "since", "span_days", "sample_limit"]);
  const min = params.min_cluster_size && params.min_cluster_size > 0 ? params.min_cluster_size : 3;
  const spanDaysParam = params.span_days && params.span_days > 0 ? params.span_days : 14;
  const sampleLimit = params.sample_limit && params.sample_limit > 0 ? params.sample_limit : 3;
  const since = parseSince(params.since);
  const c = controller();
  let targets: { domain: string; path: string }[];
  if (params.domain) {
    const d = c.resolve(params.domain);
    if (!d.files?.includes("observations")) throw new Error(`domain ${JSON.stringify(d.id)} does not declare file "observations"`);
    targets = c.observations(d.id);
  } else {
    targets = c.observations();
  }
  const all: Observation[] = [];
  for (const t of targets) {
    const data = await readRel(t.path);
    if (data == null) continue;
    let inComment = false, inFence = false;
    splitLines(data).forEach((line, i) => {
      const trimmed = line.trim();
      if (skipMarkdownBlock(trimmed)) return;
      const o = parseObs(t.domain, t.path, i + 1, trimmed);
      if (o && o.date >= since) all.push(o);
    });
    function skipMarkdownBlock(trimmed: string): boolean {
      if (inComment) { if (trimmed.includes("-->")) inComment = false; return true; }
      if (trimmed.startsWith("<!--")) { if (!trimmed.includes("-->")) inComment = true; return true; }
      if (inFence) { if (/^(```+|~~~+)/.test(trimmed)) inFence = false; return true; }
      if (/^(```+|~~~+)/.test(trimmed)) { inFence = true; return true; }
      return false;
    }
  }
  return { by_tag: tagClusters(all, min, sampleLimit), by_keyword: keywordClusters(all, min, sampleLimit), thread_candidates: threadCandidates(all, min, spanDaysParam) };
}

function parseObs(domain: string, path: string, line: number, trimmed: string): Observation | null {
  const m = trimmed.match(obsRE); if (!m) return null;
  const date = new Date(`${m[1]}T00:00:00Z`); if (Number.isNaN(date.getTime())) return null;
  const seen = new Set<string>();
  const tags = m[2].split(/[\s,]+/).map((t) => t.trim().toLowerCase()).filter((t) => t && !seen.has(t) && (seen.add(t), true));
  return { domain, path, line, date, dateS: m[1], tags, text: m[3].trim() };
}
function parseSince(raw = ""): Date {
  raw = raw.trim(); const now = new Date();
  let result: Date;
  if (!raw) result = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 7));
  else {
    const d = raw.match(/^(\d+)d$/);
    if (d && Number(d[1]) > 0) result = new Date(Date.now() - Number(d[1]) * 86400000);
    else {
      const dur = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);
      if (dur) result = new Date(Date.now() - Number(dur[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[dur[2] as "ms" | "s" | "m" | "h"]));
      else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) result = new Date(`${raw}T00:00:00Z`);
      else {
        const parsed = new Date(raw); if (Number.isNaN(parsed.getTime())) throw new Error(`invalid since ${JSON.stringify(raw)} (want RFC3339 date, duration, or Nd)`);
        result = parsed;
      }
    }
  }
  // Match Go store/cluster.go:108: all parsed since values are truncated to UTC midnight.
  result.setUTCHours(0, 0, 0, 0);
  return result;
}
function tagClusters(all: Observation[], min: number, sampleLimit: number): TagCluster[] {
  const map = new Map<string, Observation[]>();
  for (const o of all) for (const t of o.tags) (map.get(t) ?? map.set(t, []).get(t)!).push(o);
  return [...map].filter(([, obs]) => obs.length >= min).map(([tag, obs]) => ({ tag, count: obs.length, spans_days: spanDays(obs), domains: domains(obs), samples: samples(obs, sampleLimit) })).sort((a,b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
function keywordClusters(all: Observation[], min: number, sampleLimit: number): KeywordCluster[] {
  const map = new Map<string, Observation[]>();
  for (const o of all) {
    const seen = new Set<string>();
    for (const [m] of o.text.matchAll(keywordRE)) { const term = m.toLowerCase(); if (stopwords.has(term) || seen.has(term)) continue; seen.add(term); (map.get(term) ?? map.set(term, []).get(term)!).push(o); }
  }
  return [...map].filter(([, obs]) => obs.length >= min).map(([keyword, obs]) => ({ keyword, count: obs.length, spans_days: spanDays(obs), domains: domains(obs), samples: samples(obs, sampleLimit) })).sort((a,b) => b.count - a.count || a.keyword.localeCompare(b.keyword));
}
function threadCandidates(all: Observation[], min: number, minSpan: number): ThreadCandidate[] {
  const buckets = new Map<string, Observation[]>();
  const add = (k: string, o: Observation) => (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(o);
  for (const o of all) {
    for (const t of o.tags) add(`tag:${t}`, o);
    const seen = new Set<string>();
    for (const [m] of o.text.matchAll(keywordRE)) { const term = m.toLowerCase(); if (stopwords.has(term) || seen.has(term)) continue; seen.add(term); add(`keyword:${term}`, o); }
  }
  return [...buckets].filter(([, obs]) => obs.length >= min && spanDays(obs) >= minSpan).map(([topic, obs]) => ({ topic, fragment_count: obs.length, date_range: `${range(obs)[0]}..${range(obs)[1]}` })).sort((a,b) => b.fragment_count - a.fragment_count || a.topic.localeCompare(b.topic));
}
function spanDays(obs: Observation[]): number { const ts = obs.map((o) => o.date.getTime()); return Math.floor((Math.max(...ts) - Math.min(...ts)) / 86400000) + 1; }
function range(obs: Observation[]): [string,string] { const sorted = [...obs].sort((a,b) => a.date.getTime() - b.date.getTime()); return [sorted[0].dateS, sorted.at(-1)!.dateS]; }
function domains(obs: Observation[]): string[] { return [...new Set(obs.map((o) => o.domain).filter(Boolean))].sort(); }
function samples(obs: Observation[], limit: number): SampleObservation[] { return [...obs].sort((a,b) => b.date.getTime() - a.date.getTime() || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line)).slice(0, limit).map((o) => ({ date: o.dateS, domain: o.domain, path: o.path, line: o.line, text: o.text })); }
