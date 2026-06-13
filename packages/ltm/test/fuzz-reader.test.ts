import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSessionFile } from "../src/session/reader.ts";
import { generateFixtures, mulberry32 } from "../src/eval/synthetic.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ltm-fuzz-"));
}

/**
 * Deterministically corrupt a fraction of entry lines (never the header).
 * Every corruption mode is guaranteed to make the line unparseable as a
 * session entry, so warnings must match corruption count exactly.
 */
function corrupt(filePath: string, fraction: number, seed: number): { outPath: string; corrupted: number } {
  const rand = mulberry32(seed);
  const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  let corrupted = 0;
  const out = lines.map((line, i) => {
    if (i === 0) return line; // header stays intact in this fuzzer
    if (rand() >= fraction) return line;
    corrupted++;
    const mode = Math.floor(rand() * 3);
    if (mode === 0) {
      // Truncated JSON: cutting before the closing brace is always invalid.
      return line.slice(0, Math.max(5, Math.floor(line.length / 2)));
    }
    if (mode === 1) {
      // Missing required field: drop the id.
      const obj = JSON.parse(line) as Record<string, unknown>;
      delete obj.id;
      return JSON.stringify(obj);
    }
    // Wrong type on a required field.
    const obj = JSON.parse(line) as Record<string, unknown>;
    obj.timestamp = 42;
    return JSON.stringify(obj);
  });
  const outPath = `${filePath}.fuzzed`;
  fs.writeFileSync(outPath, out.join("\n") + "\n");
  return { outPath, corrupted };
}

describe("malformed-session fuzz (PLAN 3.2)", () => {
  it("reader never throws on corrupted entries; recovered turns ⊆ intact; warnings == corruptions", () => {
    const dir = tmpDir();
    generateFixtures({ outDir: dir, sessions: 2, turnsPerSession: 10, seed: 21 });
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBeGreaterThan(0);

    for (const seed of [1, 7, 42, 99, 1337]) {
      for (const fraction of [0.05, 0.2, 0.5]) {
        for (const file of files) {
          const filePath = path.join(dir, file);
          const intact = readSessionFile(filePath);
          const intactByEntry = new Map(intact.turns.map((t) => [t.entryId, t.text]));

          const { outPath, corrupted } = corrupt(filePath, fraction, seed * 31 + Math.round(fraction * 100));
          const fuzzed = readSessionFile(outPath); // must not throw
          expect(fuzzed.warnings).toHaveLength(corrupted);
          // Strict subset: every recovered turn matches an intact one.
          for (const turn of fuzzed.turns) {
            expect(intactByEntry.get(turn.entryId)).toBe(turn.text);
          }
          expect(fuzzed.turns.length).toBeLessThanOrEqual(intact.turns.length);
        }
      }
    }
  });

  it("header corruption is the one intentional throw", () => {
    const dir = tmpDir();
    generateFixtures({ outDir: dir, sessions: 1, turnsPerSession: 4, seed: 3 });
    const file = path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith(".jsonl"))!);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines[0] = lines[0].slice(0, 10);
    const broken = path.join(dir, "broken-header.jsonl");
    fs.writeFileSync(broken, lines.join("\n"));
    expect(() => readSessionFile(broken)).toThrow(/Not a v3 session file/);
  });
});
