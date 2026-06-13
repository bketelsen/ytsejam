import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatReport, formatBandedResult, runAllBands, runEval, BANDS } from "../src/eval/harness.ts";
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

describe("eval failure output is actionable (PLAN.md Task 3.5)", () => {
  it("a failing report names the misses with probes, answers, and retrieved texts", { timeout: 120_000 }, async () => {
    // Force a paraphrase failure: the lexical embedder can't reach 100%.
    const report = await runEval({
      workDir: tmpDir(),
      seed: 42,
      band: "short",
      thresholds: { paraphraseRecallAt5: 1 },
    });
    expect(report.passed).toBe(false);
    expect(report.diagnostics.recallMisses.length).toBeGreaterThan(0);
    const miss = report.diagnostics.recallMisses[0];
    expect(miss.probe.length).toBeGreaterThan(0);
    expect(miss.answer.length).toBeGreaterThan(0);
    expect(miss.topRetrieved.length).toBeGreaterThan(0);

    const text = formatReport(report);
    expect(text).toContain("Recall misses:");
    expect(text).toContain(miss.probe);
    expect(text).toContain("top1:");
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

  it("the directiveFloor seam surfaces a single-assertion directive at month 24", { timeout: 120_000 }, async () => {
    // FOLLOWUP Task 1: with the medium band's directiveFloor: 0.2 the
    // directive (effective strength ~0.24, below the default 0.3 floor)
    // surfaces again — the per-kind floor seam applied symmetrically with
    // identityFloor, not a weakening of decay.
    const report = await runEval({ workDir: tmpDir(), seed: 42, band: "medium" });
    expect(report.directiveRecall).toBeGreaterThanOrEqual(BANDS.medium.thresholds.directiveRecall);
    expect(report.directiveRecall).toBeGreaterThan(0);
  });

  it("a directive asserted once still retires at the 4yr horizon, even at the lowered floor", { timeout: 120_000 }, async () => {
    // Strength ≈ 0.07 < directiveFloor 0.2 at ~1440 days — decay bites
    // directives exactly like identity (the long band's identityExpected:
    // false). Redaction, not eternal retention, is the forget surface.
    const report = await runEval({ workDir: tmpDir(), seed: 42, band: "long" });
    expect(report.directiveRecall).toBe(0);
  });

  it("preferences flicker out between reassertions at 30d cadence", { timeout: 120_000 }, async () => {
    const report = await runEval({ workDir: tmpDir(), seed: 42, band: "medium" });
    expect(report.stability).toBeLessThan(0.7);
    expect(report.stability).toBeGreaterThan(0); // learned at least once, though
  });
});

describe("formatBandedResult does not spread strings (FOLLOWUP 4)", () => {
  it("renders per-band detail blocks intact, not one character per line", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ltm-fmt-"));
    const result = await runAllBands({ workDir, seed: 42 });
    const text = formatBandedResult(result);
    // Every per-band detail block opens with "[<band>] <N> sessions"; if the
    // string-spread bug returns, those characters get split onto their own
    // lines and the substring is gone.
    for (const band of ["[short]", "[medium]", "[long]"]) {
      expect(text).toContain(band);
    }
    // No line should be a single character (the bug's signature).
    const singleChar = text.split("\n").filter((l) => l.length === 1);
    expect(singleChar.length).toBe(0);
  });
});
