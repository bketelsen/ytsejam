import type { Model } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  estimateContextTokens,
  shouldCompact,
  type CompactionSettings,
} from "@earendil-works/pi-agent-core";

/**
 * Compute the per-model reserve token budget.
 *
 * Invariant: after compaction, the next turn must fit one full-size model
 * output PLUS reasonable input. Formula: `max(model.maxTokens + 16k, 32k)`.
 *
 * The 16k cushion covers user message + tool calls + cache headers + slack.
 * The 32k floor protects small-output models (e.g. nova-2-lite has 4k output
 * but we still want >= 32k headroom on the input side of next turn).
 */
export function computeReserveTokens(model: Model<any>): number {
  return Math.max(model.maxTokens + 16_384, 32_768);
}

/**
 * Build the CompactionSettings for a given model.
 *
 * `enabled`: always true here — the kill switch is checked at the call site
 *   (compactionEnabled()), not by toggling the settings field.
 * `keepRecentTokens`: pi's default of 20k — how much of the tail to preserve
 *   unsummarized. Larger = more recent context preserved; smaller = more
 *   reclaimed space.
 */
export function buildSettings(model: Model<any>): CompactionSettings {
  return {
    enabled: true,
    reserveTokens: computeReserveTokens(model),
    keepRecentTokens: 20_000,
  };
}

export interface CompactionDecision {
  shouldFire: boolean;
  reason: string;
  tokensBefore: number;
  budget: number;
}

/**
 * Decide whether to compact based on current message stream and model.
 *
 * Pure function — caller wires it into a turn_end hook. Uses pi's
 * estimateContextTokens (provider-truth for measured turns + char/4 for
 * trailing) and pi's shouldCompact predicate.
 */
export function decideCompaction(
  messages: AgentMessage[],
  model: Model<any>,
): CompactionDecision {
  const estimate = estimateContextTokens(messages);
  const settings = buildSettings(model);
  const budget = model.contextWindow - settings.reserveTokens;
  const fire = shouldCompact(estimate.tokens, model.contextWindow, settings);
  return {
    shouldFire: fire,
    reason: fire
      ? `${estimate.tokens} tokens above ${budget} budget (contextWindow=${model.contextWindow}, reserve=${settings.reserveTokens})`
      : `${estimate.tokens} tokens within ${budget} budget`,
    tokensBefore: estimate.tokens,
    budget,
  };
}
