/**
 * recall(query) — unified recall across cog full-text search and LTM
 * semantic retrieve. Returns interleaved hits from both substrates, deduped
 * by origin (cog path wins on collision).
 *
 * Design: docs/plans/2026-06-13-recall-tool-design.md
 *
 * FILTER PARAMETER DEFERRED: this version takes only a query string. Filter
 * support (filterTags, scopePaths) was deferred from PR 3 — the two
 * substrates use different coordinate systems (LTM tags vs cog paths) and
 * conflating them in a single param is a footgun. When usage data shows
 * agents want scoped recall, add SEPARATE filterTags (LTM-only) and
 * scopePaths (cog-only) parameters — never a single conflated one.
 *
 * Ordering: strict alternation cog[0], ltm[0], cog[1], ltm[1], ...
 * Cog has no native score so score-based merge would require inventing
 * one; that's a separate design problem. Score on each hit is informational.
 */

import type { RetrievalResult } from "ltm";
import { parseObservationLine } from "./bridge/ltm-observer.ts";
import * as memory from "./index.ts";

export type RecallHit = {
  from: "cog" | "ltm";
  text: string;
  /** "<path>:<line>" for cog, "ltm:<record.id>" for ltm. */
  where: string;
  /** cog=1.0 (informational), ltm=native retrieve score. */
  score: number;
  /** Pass-through from LTM (dormant fact / resurrected record). Absent on cog. */
  stale?: boolean;
  /** Populated when cog hit parses as observation OR LTM record carries tags. */
  tags?: string[];
};

export type RecallResult = {
  hits: RecallHit[];
  /** Total cog grep matches BEFORE truncation to top 5. */
  cogCount: number;
  /** LTM retrieve item count BEFORE dedupe. */
  ltmCount: number;
  /** LTM hits dropped by origin-based dedupe. */
  dropped: number;
};

const K = 5;

/**
 * Merge project-tagged hits ahead of global hits, deduped by `where`.
 * Project hits appear first; any global hit whose `where` already appeared
 * in the project set is dropped (project version wins).
 */
export function mergeRecallHits(global: RecallHit[], project: RecallHit[]): RecallHit[] {
  const seen = new Set<string>();
  const out: RecallHit[] = [];
  for (const h of [...project, ...global]) {
    if (seen.has(h.where)) continue;
    seen.add(h.where);
    out.push(h);
  }
  return out;
}

/** Normalize a slice of LTM RetrievedMemory items into RecallHit[], dropping
 *  items whose observation origin is already covered by a cog prefix. */
function toLtmHits(
  items: RetrievalResult["items"],
  cogOriginPrefixes: Set<string>,
  droppedRef: { count: number },
): RecallHit[] {
  const hits: RecallHit[] = [];
  for (const item of items.slice(0, K)) {
    const record = item.record;
    if (record.kind === "observation" && record.origin) {
      const prefix = record.origin.split("#")[0];
      if (cogOriginPrefixes.has(prefix)) {
        droppedRef.count++;
        continue;
      }
    }
    const hit: RecallHit = {
      from: "ltm",
      text: (record.text ?? "").trim(),
      where: `ltm:${record.id}`,
      score: item.score,
    };
    if (item.stale) hit.stale = true;
    const tags = "tags" in record ? record.tags : undefined;
    if (Array.isArray(tags) && tags.length > 0) {
      hit.tags = tags;
    }
    hits.push(hit);
  }
  return hits;
}

export async function recall(
  query: string,
  opts: { filterTags?: string[] } = {},
): Promise<RecallResult> {
  // 1. Fan out to both substrates, swallowing per-substrate errors.
  const cogRaw = await memory.search(query).catch((err: Error) => {
    console.warn("[recall] cog search failed:", err.message);
    return { results: [], count: 0 };
  });
  const ltm = memory.getLtm();
  // Empty fallback shape. `profile` is non-optional on RetrievalResult but
  // recall() never reads it — the cast is localized so consumers of `record`
  // keep their EpisodicRecord | PromotedFact union and `kind === "observation"`
  // narrowing actually guards origin/tags access below.
  const EMPTY_LTM: RetrievalResult = {
    items: [],
    profile: undefined as unknown as RetrievalResult["profile"],
  };
  const ltmRaw: RetrievalResult = ltm
    ? await ltm.retrieve(query, { k: K }).catch((err: Error) => {
        console.warn("[recall] ltm retrieve failed:", err.message);
        return EMPTY_LTM;
      })
    : EMPTY_LTM;

  // 2. Normalize cog hits (top K). Parse observation-shaped lines for tags.
  const cogHits: RecallHit[] = cogRaw.results.slice(0, K).map((r) => {
    const parsed = parseObservationLine(r.text);
    const hit: RecallHit = {
      from: "cog",
      text: r.text.trim(),
      where: `${r.path}:${r.line}`,
      score: 1.0,
    };
    if (parsed) hit.tags = parsed.tags;
    return hit;
  });

  // 3. Build origin-prefix set from cog hits for dedupe.
  //    "cog-meta/observations.md:14" -> "cog:cog-meta/observations.md"
  const cogOriginPrefixes = new Set(
    cogHits.map((h) => `cog:${h.where.split(":")[0]}`),
  );

  // 4. Normalize LTM hits, dropping those whose origin starts with a cog
  //    prefix we already have. Non-observation records have no origin -> kept.
  const droppedRef = { count: 0 };
  const ltmHits = toLtmHits(ltmRaw.items, cogOriginPrefixes, droppedRef);
  const dropped = droppedRef.count;

  // 5. Interleave: cog[0], ltm[0], cog[1], ltm[1], ...
  const globalHits: RecallHit[] = [];
  const maxLen = Math.max(cogHits.length, ltmHits.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < cogHits.length) globalHits.push(cogHits[i]);
    if (i < ltmHits.length) globalHits.push(ltmHits[i]);
  }

  // 6. Optional: second LTM pass scoped to filterTags (project boost).
  //    Runs only when filterTags is set and LTM is present; keeps cogCount/
  //    ltmCount/dropped from the global pass.
  let hits = globalHits;
  if (opts.filterTags?.length && ltm) {
    const projectRaw: RetrievalResult = await ltm
      .retrieve(query, { k: K, filterTags: opts.filterTags })
      .catch((err: Error) => {
        console.warn("[recall] ltm filterTags retrieve failed:", err.message);
        return EMPTY_LTM;
      });
    // project-pass drop count is intentionally not reported; `dropped` reflects the global pass
    const projectDropped = { count: 0 };
    const projectHits = toLtmHits(projectRaw.items, cogOriginPrefixes, projectDropped);
    hits = mergeRecallHits(globalHits, projectHits);
  }

  return {
    hits,
    cogCount: cogRaw.count,
    ltmCount: ltmRaw.items.length,
    dropped,
  };
}
