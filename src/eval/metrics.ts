/**
 * Eval metrics.
 *
 * Recall quality: for each planted fact, probe the retriever and find the
 * rank of the first item containing the answer → recall@1, recall@5, MRR.
 *
 * Personality mirroring: compare the learned profile against the planted
 * persona — preference precision/recall/F1, directive recall, identity
 * correctness, contradiction resolution — and stability: once learned, a
 * preference must stay in the profile (with the right polarity) for every
 * subsequent session snapshot.
 */

import type { ProfileSummary, SemanticFact } from "../types.ts";
import type { GroundTruth } from "./synthetic.ts";

export interface RecallOutcome {
  key: string;
  rank: number | null;
}

export interface RecallMetrics {
  n: number;
  at1: number;
  at5: number;
  mrr: number;
  misses: string[];
}

export function recallMetrics(outcomes: RecallOutcome[]): RecallMetrics {
  const n = outcomes.length || 1;
  let at1 = 0;
  let at5 = 0;
  let mrr = 0;
  const misses: string[] = [];
  for (const o of outcomes) {
    if (o.rank === null) {
      misses.push(o.key);
      continue;
    }
    if (o.rank === 1) at1++;
    if (o.rank <= 5) at5++;
    mrr += 1 / o.rank;
  }
  return { n: outcomes.length, at1: at1 / n, at5: at5 / n, mrr: mrr / n, misses };
}

function matchesObject(fact: SemanticFact, object: string): boolean {
  const norm = object.toLowerCase();
  return fact.objectNorm.includes(norm) || norm.includes(fact.objectNorm);
}

export interface PreferenceMetrics {
  precision: number;
  recall: number;
  f1: number;
  missed: string[];
  spurious: string[];
}

export function preferenceMetrics(profile: ProfileSummary, truth: GroundTruth): PreferenceMetrics {
  const planted = [
    ...truth.preferences,
    ...truth.contradictions.map((c) => ({ object: c.object, polarity: c.finalPolarity })),
  ];
  const learned = profile.preferences;

  const missed: string[] = [];
  let recalled = 0;
  for (const p of planted) {
    const hit = learned.some((f) => matchesObject(f, p.object) && f.polarity === p.polarity);
    if (hit) recalled++;
    else missed.push(`${p.polarity > 0 ? "+" : "-"}${p.object}`);
  }

  const spurious: string[] = [];
  let correct = 0;
  for (const f of learned) {
    const hit = planted.some((p) => matchesObject(f, p.object) && f.polarity === p.polarity);
    if (hit) correct++;
    else spurious.push(`${f.polarity > 0 ? "+" : "-"}${f.object}`);
  }

  const recall = planted.length ? recalled / planted.length : 1;
  const precision = learned.length ? correct / learned.length : 1;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, missed, spurious };
}

export function directiveRecall(profile: ProfileSummary, truth: GroundTruth): number {
  if (truth.directives.length === 0) return 1;
  let hit = 0;
  for (const d of truth.directives) {
    if (profile.directives.some((f) => matchesObject(f, d.object) && f.polarity === d.polarity)) hit++;
  }
  return hit / truth.directives.length;
}

export function identityCorrect(profile: ProfileSummary, truth: GroundTruth): boolean {
  return profile.identity.some(
    (f) => f.predicate === "name" && f.object.toLowerCase() === truth.userName.toLowerCase(),
  );
}

export function contradictionsResolved(profile: ProfileSummary, truth: GroundTruth): { correct: number; total: number } {
  let correct = 0;
  for (const c of truth.contradictions) {
    const final = profile.preferences.find((f) => matchesObject(f, c.object));
    if (final && final.polarity === c.finalPolarity) correct++;
  }
  return { correct, total: truth.contradictions.length };
}

/**
 * Stability over the horizon: for each planted preference, look at the
 * profile snapshots taken after each ingested session; from the first
 * snapshot where the preference appears, count the fraction of later
 * snapshots where it is still present with the right polarity. 1.0 means
 * nothing learned was ever forgotten or flipped. Contradiction objects are
 * excluded (they are *supposed* to flip).
 */
export function stabilityScore(snapshots: ProfileSummary[], truth: GroundTruth): number {
  const scores: number[] = [];
  for (const p of truth.preferences) {
    if (truth.contradictions.some((c) => c.object === p.object)) continue;
    let firstSeen = -1;
    for (let i = 0; i < snapshots.length; i++) {
      const present = snapshots[i].preferences.some(
        (f) => matchesObject(f, p.object) && f.polarity === p.polarity,
      );
      if (firstSeen === -1 && present) firstSeen = i;
    }
    if (firstSeen === -1) {
      scores.push(0);
      continue;
    }
    let kept = 0;
    let total = 0;
    for (let i = firstSeen; i < snapshots.length; i++) {
      total++;
      if (
        snapshots[i].preferences.some((f) => matchesObject(f, p.object) && f.polarity === p.polarity)
      ) {
        kept++;
      }
    }
    scores.push(total ? kept / total : 0);
  }
  return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 1;
}
