/**
 * End-to-end evaluation harness, banded by horizon (PLAN.md Phase 1).
 *
 * Three bands run the same persona over increasingly long horizons so the
 * eval measures the regime where decay actually bites instead of only the
 * regime where nothing has decayed yet:
 *
 *   short  — 12 sessions × 14d ≈ 6mo  (decay barely engaged)
 *   medium — 24 sessions × 30d ≈ 24mo (preferences decay out between
 *            reassertions; identity hangs on)
 *   long   — 24 sessions × 60d ≈ 48mo (identity itself decays below the
 *            profile floor — asserted as CORRECT behavior, see Task 1.3)
 *
 * Honesty rules baked in:
 * - Profile snapshots and the mid-run consolidation pass use the clock of
 *   that point in the corpus timeline, not the horizon end — evaluating a
 *   2-year-old snapshot "from the future" would understate decay.
 * - Thresholds are PER BAND and calibrated to measured behavior (minus
 *   headroom), not aspiration. A band where decay correctly erodes a metric
 *   has a low threshold and an explicit identityExpected flag; "fixing" a
 *   long-band failure by weakening decay is the failure mode this structure
 *   exists to catch.
 *
 * Per run: ingest session-by-session (snapshotting the profile after each at
 * that session's clock), consolidate two-thirds through at that point's
 * clock, then probe every planted fact and score recall + personality
 * mirroring at horizon end.
 */

import fs from "node:fs";
import path from "node:path";
import { MemorySystem } from "../api/memory-system.ts";
import type { LtmConfigPatch, ProfileSummary } from "../types.ts";
import { generateFixtures, type GenerateOptions, type GroundTruth } from "./synthetic.ts";
import {
  contradictionsResolved,
  directiveRecall,
  identityCorrect,
  preferenceMetrics,
  recallMetrics,
  stabilityScore,
  type PreferenceMetrics,
  type RecallMetrics,
  type RecallOutcome,
} from "./metrics.ts";

export type EvalBand = "short" | "medium" | "long";

export interface EvalThresholds {
  recallAt5: number;
  mrr: number;
  /**
   * Recall@5 over the paraphrase probe set (probes sharing no content words
   * with their plants). Low by design with the lexical HashEmbedder — this
   * number is the honest baseline that Phase 4 must move.
   */
  paraphraseRecallAt5: number;
  preferenceF1: number;
  directiveRecall: number;
  /**
   * Exact expectation, not a floor: a band where decay should have erased
   * the identity FAILS if identity survives (that would mean decay stopped
   * doing its job — see PLAN.md Task 1.3).
   */
  identityExpected: boolean;
  /** Whether the mid-horizon contradiction must resolve to the latest statement. */
  contradictionRequired: boolean;
  stability: number;
}

export interface BandSpec {
  sessions: number;
  intervalDays: number;
  turnsPerSession: number;
  thresholds: EvalThresholds;
  /** MemorySystem config for this band (e.g. profile floors, Task 2.1). */
  config?: LtmConfigPatch;
}

/**
 * Thresholds reflect measured behavior of the current system minus headroom
 * (see PLAN.md "Defaults reflect the current code's actual behavior — these
 * are not aspirational"). Calibration notes per band:
 *
 * - short: everything alive; near-perfect is the honest bar.
 * - medium: at per-session clocks, preferences planted with 2–3 statements
 *   over 24 months spend the gaps between reassertions below the profile
 *   floor (stability ≈ 0.5 measured) and have fully decayed by horizon end
 *   8 months after their last assertion (F1 ≈ 0.3 measured: only the
 *   late-flipped contradiction survives). Directives (one assertion at
 *   month ~1, 365d half-life) are below the floor by month 24 — recall 0
 *   until the Phase 2 floor seam / Phase 4 work raises it.
 * - long: identity itself is below the floor (identityExpected: false —
 *   this band PROVES decay bites); episodic recall stays high because decay
 *   never deletes text, it only re-ranks.
 */
export const BANDS: Record<EvalBand, BandSpec> = {
  short: {
    sessions: 12,
    intervalDays: 14,
    turnsPerSession: 12,
    thresholds: {
      recallAt5: 0.85,
      mrr: 0.6,
      paraphraseRecallAt5: 0.2,
      preferenceF1: 0.75,
      directiveRecall: 1,
      identityExpected: true,
      contradictionRequired: true,
      stability: 0.95,
    },
  },
  medium: {
    sessions: 24,
    intervalDays: 30,
    turnsPerSession: 12,
    // Identity at 24mo sits at effective strength ~0.24 — below the default
    // 0.3 floor but real. The medium band accepts the Task 2.1 tradeoff
    // (identityFloor 0.2: keep slot-like identity surfacing at the cost of
    // staler positives), which is exactly the seam's intended use. The
    // default floors are unchanged; the long band shows identity retiring
    // even at the lowered floor.
    config: { profile: { identityFloor: 0.2 } },
    thresholds: {
      recallAt5: 0.85,
      mrr: 0.6,
      paraphraseRecallAt5: 0,
      preferenceF1: 0.25,
      directiveRecall: 0,
      identityExpected: true,
      contradictionRequired: true,
      stability: 0.3,
    },
  },
  long: {
    sessions: 24,
    intervalDays: 60,
    turnsPerSession: 12,
    // Same lowered identityFloor as medium: identity STILL retires at 48mo
    // (0.9·2^(-1380/365) ≈ 0.065 < 0.2) — the decay-bites assertion holds
    // against the seam, not just against the default.
    config: { profile: { identityFloor: 0.2 } },
    thresholds: {
      recallAt5: 0.7,
      mrr: 0.4,
      paraphraseRecallAt5: 0,
      preferenceF1: 0.2,
      directiveRecall: 0,
      identityExpected: false,
      contradictionRequired: false,
      stability: 0.15,
    },
  },
};

export interface EvalReport {
  band: EvalBand;
  corpus: { sessions: number; intervalDays: number; turns: number; seed: number; horizonEnd: string };
  recall: RecallMetrics;
  paraphrase: RecallMetrics;
  preferences: PreferenceMetrics;
  directiveRecall: number;
  identityCorrect: boolean;
  contradictions: { correct: number; total: number };
  stability: number;
  consolidation: { created: number; folded: number };
  thresholds: EvalThresholds;
  passed: boolean;
  failures: string[];
}

export interface RunEvalOptions {
  workDir: string;
  band?: EvalBand;
  seed?: number;
  /** Override the band's corpus shape (tests use small corpora). */
  sessions?: number;
  turnsPerSession?: number;
  thresholds?: Partial<EvalThresholds>;
  generate?: Partial<GenerateOptions>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function runEval(opts: RunEvalOptions): Promise<EvalReport> {
  const band = opts.band ?? "short";
  const spec = BANDS[band];
  const seed = opts.seed ?? 42;
  const sessionsDir = path.join(opts.workDir, "sessions");
  const storeDir = path.join(opts.workDir, "store");
  fs.rmSync(opts.workDir, { recursive: true, force: true });

  const truth: GroundTruth = generateFixtures({
    outDir: sessionsDir,
    seed,
    sessions: opts.sessions ?? spec.sessions,
    turnsPerSession: opts.turnsPerSession ?? spec.turnsPerSession,
    intervalDays: spec.intervalDays,
    ...opts.generate,
  });

  const horizonEnd = truth.horizonEnd;
  // Clock at "just before the next session" for mid-run snapshots: the
  // moment this point in history would actually be observed.
  const clockAfter = (i: number): string =>
    new Date(
      Math.min(
        Date.parse(horizonEnd),
        Date.parse(truth.sessionStarts[i]) + truth.intervalDays * DAY_MS,
      ),
    ).toISOString();

  let now = truth.sessionStarts[0];
  const mem = MemorySystem.open({ storeDir, now: () => now, config: spec.config });

  const snapshots: ProfileSummary[] = [];
  let consolidation = { created: 0, folded: 0 };
  const files = truth.sessionIds.map((id) => path.join(sessionsDir, `${id}.jsonl`));
  const consolidateAfter = Math.floor(files.length * 0.66);
  for (let i = 0; i < files.length; i++) {
    now = clockAfter(i);
    await mem.ingestSessionFile(files[i]);
    if (i === consolidateAfter) {
      const result = await mem.consolidate({ now });
      consolidation = { created: result.created, folded: result.folded };
    }
    snapshots.push(mem.profile(now));
  }
  now = horizonEnd;

  // Recall probes (dryRun so probing doesn't perturb access counts). A probe
  // counts as answered when the answer surfaces in the context the system
  // would hand the assistant: episodic items at their rank, or — for facts
  // the semantic layer distilled (employer, name, …) — profile facts, which
  // composeContext places above the episodic section, i.e. rank 1.
  const probeFact = async (probe: string, answer: string): Promise<number | null> => {
    const { items, profile } = await mem.retrieve(probe, { k: 5, now, dryRun: true });
    const needle = answer.toLowerCase();
    let rank: number | null = null;
    for (let i = 0; i < items.length; i++) {
      if (items[i].record.text.toLowerCase().includes(needle)) {
        rank = i + 1;
        break;
      }
    }
    const inProfile = [
      ...profile.identity,
      ...profile.attributes,
      ...profile.preferences,
    ].some((f) => f.object.toLowerCase().includes(needle));
    if (inProfile) rank = 1;
    return rank;
  };

  const outcomes: RecallOutcome[] = [];
  const paraphraseOutcomes: RecallOutcome[] = [];
  for (const fact of truth.facts) {
    outcomes.push({ key: fact.key, rank: await probeFact(fact.probe, fact.answer) });
    paraphraseOutcomes.push({
      key: fact.key,
      rank: await probeFact(fact.paraphraseProbe, fact.answer),
    });
  }

  const finalProfile = mem.profile(horizonEnd);
  const recall = recallMetrics(outcomes);
  const paraphrase = recallMetrics(paraphraseOutcomes);
  const preferences = preferenceMetrics(finalProfile, truth);
  const directives = directiveRecall(finalProfile, truth);
  const identity = identityCorrect(finalProfile, truth);
  const contradictions = contradictionsResolved(finalProfile, truth);
  const stability = stabilityScore(snapshots, truth);

  const thresholds = { ...spec.thresholds, ...opts.thresholds };
  const failures: string[] = [];
  if (recall.at5 < thresholds.recallAt5) {
    failures.push(`recall@5 ${recall.at5.toFixed(2)} < ${thresholds.recallAt5} (missed: ${recall.misses.join(", ")})`);
  }
  if (recall.mrr < thresholds.mrr) failures.push(`MRR ${recall.mrr.toFixed(2)} < ${thresholds.mrr}`);
  if (paraphrase.at5 < thresholds.paraphraseRecallAt5) {
    failures.push(
      `paraphrase recall@5 ${paraphrase.at5.toFixed(2)} < ${thresholds.paraphraseRecallAt5} (missed: ${paraphrase.misses.join(", ")})`,
    );
  }
  if (preferences.f1 < thresholds.preferenceF1) {
    failures.push(
      `preference F1 ${preferences.f1.toFixed(2)} < ${thresholds.preferenceF1}` +
        (preferences.missed.length ? ` (missed: ${preferences.missed.join(", ")})` : ""),
    );
  }
  if (directives < thresholds.directiveRecall) {
    failures.push(`directive recall ${directives.toFixed(2)} < ${thresholds.directiveRecall}`);
  }
  if (identity !== thresholds.identityExpected) {
    failures.push(
      thresholds.identityExpected
        ? "identity (name) not learned"
        : "identity survived a horizon where decay should have retired it",
    );
  }
  if (thresholds.contradictionRequired && contradictions.correct < contradictions.total) {
    failures.push("contradiction not resolved to latest statement");
  }
  if (stability < thresholds.stability) failures.push(`stability ${stability.toFixed(2)} < ${thresholds.stability}`);

  const turns = truth.sessionIds.length * (opts.turnsPerSession ?? spec.turnsPerSession);
  return {
    band,
    corpus: {
      sessions: truth.sessionIds.length,
      intervalDays: truth.intervalDays,
      turns,
      seed,
      horizonEnd,
    },
    recall,
    paraphrase,
    preferences,
    directiveRecall: directives,
    identityCorrect: identity,
    contradictions,
    stability,
    consolidation,
    thresholds,
    passed: failures.length === 0,
    failures,
  };
}

export interface BandedEvalResult {
  bands: EvalReport[];
  passed: boolean;
}

export async function runAllBands(opts: Omit<RunEvalOptions, "band">): Promise<BandedEvalResult> {
  const bands: EvalReport[] = [];
  for (const band of Object.keys(BANDS) as EvalBand[]) {
    bands.push(await runEval({ ...opts, workDir: path.join(opts.workDir, band), band }));
  }
  return { bands, passed: bands.every((b) => b.passed) };
}

export function formatReport(report: EvalReport): string {
  const pct = (x: number) => `${(100 * x).toFixed(0)}%`;
  const t = report.thresholds;
  const lines = [
    `[${report.band}] ${report.corpus.sessions} sessions × ${report.corpus.intervalDays}d, seed ${report.corpus.seed}, horizon ends ${report.corpus.horizonEnd.slice(0, 10)}`,
    ``,
    `Recall quality (${report.recall.n} planted facts)`,
    `  recall@1  ${pct(report.recall.at1)}`,
    `  recall@5  ${pct(report.recall.at5)}   (threshold ${pct(t.recallAt5)})`,
    `  MRR       ${report.recall.mrr.toFixed(2)}   (threshold ${t.mrr})`,
    `  paraphrase recall@5 ${pct(report.paraphrase.at5)}  MRR ${report.paraphrase.mrr.toFixed(2)}   (threshold ${pct(t.paraphraseRecallAt5)})`,
    ``,
    `Personality mirroring`,
    `  preference precision ${pct(report.preferences.precision)}  recall ${pct(report.preferences.recall)}  F1 ${report.preferences.f1.toFixed(2)} (threshold ${t.preferenceF1})`,
    `  directive recall     ${pct(report.directiveRecall)} (threshold ${pct(t.directiveRecall)})`,
    `  identity surfaced    ${report.identityCorrect ? "yes" : "no"} (expected: ${t.identityExpected ? "yes" : "no — decay should retire it"})`,
    `  contradictions       ${report.contradictions.correct}/${report.contradictions.total} resolved${t.contradictionRequired ? "" : " (informational)"}`,
    `  stability (horizon)  ${pct(report.stability)} (threshold ${pct(t.stability)})`,
    ``,
    `Consolidation: ${report.consolidation.created} summaries folded ${report.consolidation.folded} turn records`,
    ``,
    report.passed ? `PASSED` : `FAILED:\n${report.failures.map((f) => `  - ${f}`).join("\n")}`,
  ];
  if (report.preferences.spurious.length) {
    lines.push(``, `Spurious learned preferences: ${report.preferences.spurious.join("; ")}`);
  }
  return lines.join("\n");
}

export function formatBandedResult(result: BandedEvalResult): string {
  const pct = (x: number) => `${(100 * x).toFixed(0)}%`;
  const rows = result.bands.map((b) =>
    [
      b.band.padEnd(7),
      `r@5 ${pct(b.recall.at5).padStart(4)}`,
      `para ${pct(b.paraphrase.at5).padStart(4)}`,
      `MRR ${b.recall.mrr.toFixed(2)}`,
      `prefF1 ${b.preferences.f1.toFixed(2)}`,
      `dir ${pct(b.directiveRecall).padStart(4)}`,
      `id ${b.identityCorrect ? "yes" : "no "}`,
      `stab ${pct(b.stability).padStart(4)}`,
      b.passed ? "PASS" : "FAIL",
    ].join("  "),
  );
  return [
    ...result.bands.map((b) => formatReport(b)).join("\n\n" + "─".repeat(72) + "\n\n"),
    "",
    "═".repeat(72),
    "Summary",
    ...rows,
    "",
    result.passed ? "ALL BANDS PASSED" : "ONE OR MORE BANDS FAILED",
  ].join("\n");
}
