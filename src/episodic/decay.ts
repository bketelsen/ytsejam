/**
 * Memory decay model. A record's retention follows an exponential forgetting
 * curve whose half-life stretches with intrinsic salience and with each
 * retrieval access (spaced-repetition flavor: memories that keep proving
 * useful decay slower).
 *
 *   halfLife = base * (1 + accessBonus * accessCount) * (0.5 + salience)
 *   retention = 2 ^ (-ageDays / halfLife)
 *
 * `base` is config.halfLifeDays, overridable per record kind via
 * config.halfLifeDaysByKind (SEAM 2) — deliberate observations outlive
 * conversational turns; Infinity pins a kind at retention 1.
 *
 * Retention multiplies the salience term during ranking and gates
 * consolidation eligibility; nothing is hard-deleted by decay alone.
 */

import type { DecayConfig, EpisodicRecord } from "../types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export function ageDays(timestamp: string, now: string): number {
  const age = (Date.parse(now) - Date.parse(timestamp)) / DAY_MS;
  return Number.isFinite(age) ? Math.max(0, age) : 0;
}

export function retention(
  record: Pick<EpisodicRecord, "kind" | "timestamp" | "salience" | "accessCount">,
  now: string,
  config: DecayConfig,
): number {
  const base = config.halfLifeDaysByKind?.[record.kind] ?? config.halfLifeDays;
  const halfLife =
    base * (1 + config.accessBonus * record.accessCount) * (0.5 + record.salience);
  return Math.pow(2, -ageDays(record.timestamp, now) / halfLife);
}
