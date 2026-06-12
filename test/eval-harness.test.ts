import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runEval, BANDS } from "../src/eval/harness.ts";
import { generateFixtures } from "../src/eval/synthetic.ts";
import { readSessionFile } from "../src/session/reader.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ltm-eval-"));
}

describe("synthetic fixture generator", () => {
  it("emits valid pi-v3 session files, deterministically per seed", () => {
    const a = tmpDir();
    const b = tmpDir();
    const truthA = generateFixtures({ outDir: a, seed: 42, sessions: 3, turnsPerSession: 6 });
    const truthB = generateFixtures({ outDir: b, seed: 42, sessions: 3, turnsPerSession: 6 });

    expect(truthA.sessionIds).toEqual(truthB.sessionIds);
    expect(truthA.sessionStarts).toHaveLength(3);
    for (const id of truthA.sessionIds) {
      const fileA = fs.readFileSync(path.join(a, `${id}.jsonl`), "utf8");
      const fileB = fs.readFileSync(path.join(b, `${id}.jsonl`), "utf8");
      expect(fileA).toBe(fileB);
      const session = readSessionFile(path.join(a, `${id}.jsonl`));
      expect(session.warnings).toEqual([]);
      expect(session.turns.length).toBeGreaterThan(0);
    }
    // Every planted fact's entry must really exist in its session file.
    for (const fact of truthA.facts) {
      const session = readSessionFile(path.join(a, `${fact.sessionId}.jsonl`));
      const turn = session.turns.find((t) => t.entryId === fact.entryId);
      expect(turn, `fact ${fact.key}`).toBeDefined();
      expect(turn!.text).toContain(fact.answer);
    }
  });
});

describe("evaluation bands (PLAN.md Task 1.1)", () => {
  it("short band: everything alive, near-perfect mirroring", { timeout: 120_000 }, async () => {
    const report = await runEval({ workDir: tmpDir(), seed: 42, band: "short" });
    expect(report.failures).toEqual([]);
    expect(report.recall.at5).toBeGreaterThanOrEqual(BANDS.short.thresholds.recallAt5);
    expect(report.preferences.f1).toBeGreaterThanOrEqual(BANDS.short.thresholds.preferenceF1);
    expect(report.identityCorrect).toBe(true);
    expect(report.contradictions.correct).toBe(report.contradictions.total);
    // Consolidation actually ran mid-horizon — recall survived it.
    expect(report.consolidation.created).toBeGreaterThan(0);
    // Paraphrase probes run and are honestly bad with the lexical embedder:
    // well below plain-probe recall. Phase 4 owns moving this number.
    expect(report.paraphrase.n).toBe(report.recall.n);
    expect(report.paraphrase.at5).toBeLessThan(report.recall.at5);
  });

  it("medium band: decay erodes preferences but episodic recall holds", { timeout: 120_000 }, async () => {
    const report = await runEval({ workDir: tmpDir(), seed: 42, band: "medium" });
    expect(report.failures).toEqual([]);
    // The failure modes the review surfaced, asserted so a future
    // "improvement" that silently re-calibrates them away is caught:
    // preferences planted 8+ months before horizon end have decayed out.
    expect(report.preferences.recall).toBeLessThan(0.6);
    // Episodic memory does NOT decay away — text is re-ranked, not deleted.
    expect(report.recall.at5).toBeGreaterThanOrEqual(0.85);
  });

  it("long band: decay bites identity too (Task 1.3 lives in its own test)", { timeout: 120_000 }, async () => {
    const report = await runEval({ workDir: tmpDir(), seed: 42, band: "long" });
    expect(report.failures).toEqual([]);
  });

  it("holds up on a second seed across all bands", { timeout: 240_000 }, async () => {
    for (const band of ["short", "medium", "long"] as const) {
      const report = await runEval({ workDir: tmpDir(), seed: 1337, band });
      expect(report.failures, `band ${band}`).toEqual([]);
    }
  });
});

describe("decay bites (PLAN.md Task 1.3)", () => {
  // These tests INVERT the usual make-it-pass pressure: the decay model is
  // correct as designed, and the eval must acknowledge the regime. If a
  // future change makes these fail, the right response is profile-floor
  // calibration (Task 2.1) or a real embedder (Phase 4) — NOT weakening
  // decay so an old fact pretends to be fresh.
  it("identity name decays below profile floor at 4yr horizon", { timeout: 120_000 }, async () => {
    const report = await runEval({ workDir: tmpDir(), seed: 42, band: "long" });
    expect(report.identityCorrect).toBe(false); // decay IS doing its job
  });

  it("a directive asserted once at month ~1 is gone by month 24", { timeout: 120_000 }, async () => {
    const report = await runEval({ workDir: tmpDir(), seed: 42, band: "medium" });
    expect(report.directiveRecall).toBe(0);
  });

  it("preferences flicker out between reassertions at 30d cadence", { timeout: 120_000 }, async () => {
    const report = await runEval({ workDir: tmpDir(), seed: 42, band: "medium" });
    expect(report.stability).toBeLessThan(0.7);
    expect(report.stability).toBeGreaterThan(0); // learned at least once, though
  });
});
