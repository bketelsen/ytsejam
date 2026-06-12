import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runEval, DEFAULT_THRESHOLDS } from "../src/eval/harness.ts";
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

describe("evaluation harness (long horizon)", () => {
  it(
    "proves recall quality and personality-mirroring consistency over a 12-session horizon",
    { timeout: 120_000 },
    async () => {
      const report = await runEval({ workDir: tmpDir(), seed: 42 });

      // The headline assertions of the spec: recall quality and
      // personality-mirroring consistency over long horizons.
      expect(report.failures).toEqual([]);
      expect(report.passed).toBe(true);
      expect(report.recall.at5).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.recallAt5);
      expect(report.recall.mrr).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.mrr);
      expect(report.preferences.f1).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.preferenceF1);
      expect(report.stability).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.stability);
      expect(report.identityCorrect).toBe(true);
      expect(report.contradictions.correct).toBe(report.contradictions.total);
      // Consolidation actually ran mid-horizon — recall survived it.
      expect(report.consolidation.created).toBeGreaterThan(0);
    },
  );

  it("holds up on a second seed", { timeout: 120_000 }, async () => {
    const report = await runEval({ workDir: tmpDir(), seed: 1337 });
    expect(report.failures).toEqual([]);
  });
});
