/**
 * End-to-end evaluation harness.
 *
 * 1. Generate a synthetic multi-month corpus in ytsejam session format.
 * 2. Ingest session by session, snapshotting the learned profile after each
 *    (long-horizon view), running consolidation partway through so the run
 *    proves recall survives decay + consolidation.
 * 3. Probe every planted fact; score recall@k / MRR.
 * 4. Score personality mirroring: preference F1, directive recall, identity,
 *    contradiction resolution, and profile stability across the horizon.
 */

import fs from "node:fs";
import path from "node:path";
import { MemorySystem } from "../api/memory-system.ts";
import type { ProfileSummary } from "../types.ts";
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

export interface EvalThresholds {
  recallAt5: number;
  mrr: number;
  preferenceF1: number;
  directiveRecall: number;
  stability: number;
}

export const DEFAULT_THRESHOLDS: EvalThresholds = {
  recallAt5: 0.85,
  mrr: 0.6,
  preferenceF1: 0.75,
  directiveRecall: 1,
  stability: 0.95,
};

export interface EvalReport {
  corpus: { sessions: number; turns: number; seed: number; horizonEnd: string };
  recall: RecallMetrics;
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
  seed?: number;
  sessions?: number;
  turnsPerSession?: number;
  thresholds?: Partial<EvalThresholds>;
  generate?: Partial<GenerateOptions>;
}

export async function runEval(opts: RunEvalOptions): Promise<EvalReport> {
  const seed = opts.seed ?? 42;
  const sessionsDir = path.join(opts.workDir, "sessions");
  const storeDir = path.join(opts.workDir, "store");
  fs.rmSync(opts.workDir, { recursive: true, force: true });

  const truth: GroundTruth = generateFixtures({
    outDir: sessionsDir,
    seed,
    sessions: opts.sessions ?? 12,
    turnsPerSession: opts.turnsPerSession ?? 12,
    ...opts.generate,
  });

  const now = truth.horizonEnd;
  const mem = MemorySystem.open({ storeDir, now: () => now });

  // Long-horizon ingestion: one session at a time, profile snapshot after
  // each, with a consolidation pass two-thirds through the horizon.
  const snapshots: ProfileSummary[] = [];
  let consolidation = { created: 0, folded: 0 };
  const files = truth.sessionIds.map((id) => path.join(sessionsDir, `${id}.jsonl`));
  const consolidateAfter = Math.floor(files.length * 0.66);
  for (let i = 0; i < files.length; i++) {
    await mem.ingestSessionFile(files[i]);
    if (i === consolidateAfter) {
      const result = await mem.consolidate({ now });
      consolidation = { created: result.created, folded: result.folded };
    }
    snapshots.push(mem.profile(now));
  }

  // Recall probes (dryRun so probing doesn't perturb access counts). A probe
  // counts as answered when the answer surfaces in the context the system
  // would hand the assistant: episodic items at their rank, or — for facts
  // the semantic layer distilled (employer, name, …) — profile facts, which
  // composeContext places above the episodic section, i.e. rank 1.
  const outcomes: RecallOutcome[] = [];
  for (const fact of truth.facts) {
    const { items, profile } = await mem.retrieve(fact.probe, { k: 5, now, dryRun: true });
    const needle = fact.answer.toLowerCase();
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
    outcomes.push({ key: fact.key, rank });
  }

  const finalProfile = snapshots[snapshots.length - 1];
  const recall = recallMetrics(outcomes);
  const preferences = preferenceMetrics(finalProfile, truth);
  const directives = directiveRecall(finalProfile, truth);
  const identity = identityCorrect(finalProfile, truth);
  const contradictions = contradictionsResolved(finalProfile, truth);
  const stability = stabilityScore(snapshots, truth);

  const thresholds = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };
  const failures: string[] = [];
  if (recall.at5 < thresholds.recallAt5) {
    failures.push(`recall@5 ${recall.at5.toFixed(2)} < ${thresholds.recallAt5} (missed: ${recall.misses.join(", ")})`);
  }
  if (recall.mrr < thresholds.mrr) failures.push(`MRR ${recall.mrr.toFixed(2)} < ${thresholds.mrr}`);
  if (preferences.f1 < thresholds.preferenceF1) {
    failures.push(
      `preference F1 ${preferences.f1.toFixed(2)} < ${thresholds.preferenceF1}` +
        (preferences.missed.length ? ` (missed: ${preferences.missed.join(", ")})` : ""),
    );
  }
  if (directives < thresholds.directiveRecall) failures.push(`directive recall ${directives.toFixed(2)} < ${thresholds.directiveRecall}`);
  if (!identity) failures.push("identity (name) not learned");
  if (contradictions.correct < contradictions.total) failures.push("contradiction not resolved to latest statement");
  if (stability < thresholds.stability) failures.push(`stability ${stability.toFixed(2)} < ${thresholds.stability}`);

  const turns = truth.sessionIds.length * (opts.turnsPerSession ?? 12);
  return {
    corpus: { sessions: truth.sessionIds.length, turns, seed, horizonEnd: truth.horizonEnd },
    recall,
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

export function formatReport(report: EvalReport): string {
  const pct = (x: number) => `${(100 * x).toFixed(0)}%`;
  const lines = [
    `LTM evaluation — ${report.corpus.sessions} sessions, seed ${report.corpus.seed}, horizon ends ${report.corpus.horizonEnd.slice(0, 10)}`,
    ``,
    `Recall quality (${report.recall.n} planted facts)`,
    `  recall@1  ${pct(report.recall.at1)}`,
    `  recall@5  ${pct(report.recall.at5)}   (threshold ${pct(report.thresholds.recallAt5)})`,
    `  MRR       ${report.recall.mrr.toFixed(2)}   (threshold ${report.thresholds.mrr})`,
    ``,
    `Personality mirroring`,
    `  preference precision ${pct(report.preferences.precision)}  recall ${pct(report.preferences.recall)}  F1 ${report.preferences.f1.toFixed(2)} (threshold ${report.thresholds.preferenceF1})`,
    `  directive recall     ${pct(report.directiveRecall)}`,
    `  identity learned     ${report.identityCorrect ? "yes" : "NO"}`,
    `  contradictions       ${report.contradictions.correct}/${report.contradictions.total} resolved to latest`,
    `  stability (horizon)  ${pct(report.stability)} (threshold ${pct(report.thresholds.stability)})`,
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
