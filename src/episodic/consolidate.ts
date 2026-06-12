/**
 * Consolidation: old, faded turn records are folded into one summary record
 * per session. The summary inherits the strongest salience of its children;
 * children move to state "consolidated" (out of default retrieval, retained
 * for provenance and inspection). The default summarizer is extractive and
 * deterministic; an async LLM summarizer can be injected.
 */

import type {
  ConsolidationConfig,
  DecayConfig,
  EpisodicRecord,
} from "../types.ts";
import type { Embedder } from "../embedding/embedder.ts";
import { retention } from "./decay.ts";
import { entityDensity, hasSelfDisclosure } from "./salience.ts";
import type { EpisodicStore } from "./store.ts";

export type Summarizer = (records: EpisodicRecord[], maxChars: number) => Promise<string>;

/**
 * Extractive default: score each child's sentences by salience, preference
 * markers, and entity density; keep the best until the budget is spent,
 * in chronological order.
 */
export async function extractiveSummary(
  records: EpisodicRecord[],
  maxChars: number,
): Promise<string> {
  interface Scored {
    order: number;
    text: string;
    score: number;
  }
  const scored: Scored[] = [];
  let order = 0;
  for (const r of records) {
    const sentences = r.text.match(/[^.!?\n]+[.!?]*/g) ?? [r.text];
    for (const s of sentences) {
      const text = s.trim();
      if (!text) continue;
      const score =
        r.salience +
        0.5 * entityDensity(text) +
        (/\b(prefer|like|love|hate|always|never|my name|call me)\b/i.test(text) ? 0.5 : 0) +
        // Self-disclosures must survive summarization; task questions need not.
        (r.role === "user" && hasSelfDisclosure(text) ? 0.4 : 0) -
        (text.trim().endsWith("?") ? 0.2 : 0);
      scored.push({ order: order++, text, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const kept: Scored[] = [];
  let used = 0;
  for (const s of scored) {
    if (used + s.text.length + 1 > maxChars) continue;
    kept.push(s);
    used += s.text.length + 1;
  }
  kept.sort((a, b) => a.order - b.order);
  return kept.map((s) => s.text).join(" ");
}

export interface ConsolidationResult {
  created: EpisodicRecord[];
  consolidatedChildren: number;
}

export async function consolidate(
  store: EpisodicStore,
  embedder: Embedder,
  now: string,
  config: ConsolidationConfig,
  decay: DecayConfig,
  summarize: Summarizer = extractiveSummary,
): Promise<ConsolidationResult> {
  const cutoff = Date.parse(now) - config.olderThanDays * 24 * 60 * 60 * 1000;
  const bySession = new Map<string, EpisodicRecord[]>();
  for (const r of store.active()) {
    if (r.kind !== "turn") continue;
    if (Date.parse(r.timestamp) > cutoff) continue;
    if (retention(r, now, decay) >= config.retentionFloor) continue;
    const group = bySession.get(r.sessionId) ?? [];
    group.push(r);
    bySession.set(r.sessionId, group);
  }

  const created: EpisodicRecord[] = [];
  let consolidatedChildren = 0;

  for (const [sessionId, group] of bySession) {
    if (group.length < 2) continue; // a lone faded turn isn't worth a summary
    group.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const summary = (await summarize(group, config.maxSummaryChars)).trim();
    if (!summary) continue;

    const record: EpisodicRecord = {
      id: `con-${sessionId}-${group[0].id.split("#")[0].split("/")[1] ?? "0"}`,
      kind: "consolidated",
      sessionId,
      sourceIds: group.map((r) => r.id),
      role: "summary",
      text: summary,
      // The summary carries the group's most recent moment so recency
      // scoring treats it as one memory from that era.
      timestamp: group[group.length - 1].timestamp,
      salience: Math.max(...group.map((r) => r.salience)),
      accessCount: 0,
      state: "active",
      embedding: await embedder.embed(summary),
    };

    const updates: EpisodicRecord[] = [record];
    for (const child of group) {
      updates.push({ ...child, state: "consolidated" });
      consolidatedChildren++;
    }
    store.upsertMany(updates);
    created.push(record);
  }

  return { created, consolidatedChildren };
}
