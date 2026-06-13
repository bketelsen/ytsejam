import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli/main.ts";
import { generateFixtures } from "../src/eval/synthetic.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ltm-cli-"));
}

function capture(): { out: (s: string) => void; text: () => string } {
  const lines: string[] = [];
  return { out: (s) => lines.push(s), text: () => lines.join("\n") };
}

describe("ltm CLI (PLAN 5.1)", () => {
  it("ingest → stats → retrieve → explain → profile → redact → export round trip", async () => {
    const work = tmpDir();
    generateFixtures({ outDir: path.join(work, "sessions"), sessions: 3, turnsPerSession: 8, seed: 7 });
    const store = ["--store-dir", path.join(work, "store")];

    let c = capture();
    expect(await runCli(["ingest", path.join(work, "sessions"), ...store], c.out)).toBe(0);
    expect(c.text()).toMatch(/sessions 3 {2}turns \d+ {2}records \d+/);

    c = capture();
    expect(await runCli(["stats", ...store], c.out)).toBe(0);
    expect(c.text()).toContain("episodic:");

    c = capture();
    expect(await runCli(["retrieve", "what", "is", "my", "sister's", "name?", ...store], c.out)).toBe(0);
    expect(c.text()).toContain("Alice");

    c = capture();
    expect(await runCli(["explain", "sister", ...store], c.out)).toBe(0);
    expect(c.text()).toMatch(/rank\s+total\s+vec\s+lex/);

    c = capture();
    expect(await runCli(["profile", ...store], c.out)).toBe(0);
    expect(c.text()).toContain("Brian");

    c = capture();
    expect(await runCli(["redact", "--entity", "Alice", ...store], c.out)).toBe(0);
    expect(c.text()).toMatch(/redacted: \d+ episodic/);

    c = capture();
    expect(await runCli(["export", ...store], c.out)).toBe(0);
    const dump = JSON.parse(c.text()) as { episodic: unknown[]; facts: unknown[] };
    expect(dump.episodic.length).toBeGreaterThan(0);
    expect(c.text()).not.toContain("Alice");
  });

  it("bad invocations exit 2 with usage", async () => {
    const store = ["--store-dir", path.join(tmpDir(), "store")];
    let c = capture();
    expect(await runCli([], c.out)).toBe(2);
    expect(c.text()).toContain("usage: ltm");
    c = capture();
    expect(await runCli(["frobnicate", ...store], c.out)).toBe(2);
    c = capture();
    expect(await runCli(["redact", ...store], c.out)).toBe(2);
  });

  it("respects LTM_STORE_DIR", async () => {
    const work = tmpDir();
    const prev = process.env.LTM_STORE_DIR;
    process.env.LTM_STORE_DIR = path.join(work, "store");
    try {
      const c = capture();
      expect(await runCli(["stats"], c.out)).toBe(0);
      expect(fs.existsSync(path.join(work, "store"))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.LTM_STORE_DIR;
      else process.env.LTM_STORE_DIR = prev;
    }
  });
});
