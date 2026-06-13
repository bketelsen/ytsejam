import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli/main.ts";
import { MemorySystem } from "../src/api/memory-system.ts";
import { generateFixtures } from "../src/eval/synthetic.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ltm-doc-"));
}

function capture(): { out: (s: string) => void; text: () => string } {
  const lines: string[] = [];
  return { out: (s) => lines.push(s), text: () => lines.join("\n") };
}

async function populatedStore(): Promise<{ storeDir: string; sessionsDir: string }> {
  const work = tmpDir();
  const sessionsDir = path.join(work, "sessions");
  const storeDir = path.join(work, "store");
  const truth = generateFixtures({ outDir: sessionsDir, sessions: 2, turnsPerSession: 6, seed: 5 });
  const mem = MemorySystem.open({ storeDir, now: () => truth.horizonEnd });
  await mem.ingestSessionDir(sessionsDir);
  mem.close();
  return { storeDir, sessionsDir };
}

describe("ltm doctor (PLAN 5.2)", () => {
  it("a healthy store reports healthy and exits 0", async () => {
    const { storeDir } = await populatedStore();
    const c = capture();
    expect(await runCli(["doctor", "--store-dir", storeDir], c.out)).toBe(0);
    expect(c.text()).toContain("healthy");
  });

  it("finds malformed lines and stale ingest-state; --fix repairs both", async () => {
    const { storeDir, sessionsDir } = await populatedStore();
    // Corrupt one line and delete one ingested session file.
    fs.appendFileSync(path.join(storeDir, "episodic.jsonl"), "{broken json\n");
    const victim = fs.readdirSync(sessionsDir)[0];
    fs.rmSync(path.join(sessionsDir, victim));

    let c = capture();
    expect(await runCli(["doctor", "--store-dir", storeDir], c.out)).toBe(1);
    expect(c.text()).toContain("malformed line");
    expect(c.text()).toContain("missing files");

    c = capture();
    expect(await runCli(["doctor", "--fix", "--store-dir", storeDir], c.out)).toBe(0);
    expect(c.text()).toContain("compacted");

    c = capture();
    expect(await runCli(["doctor", "--store-dir", storeDir], c.out)).toBe(0);
    expect(c.text()).toContain("healthy");
    // The fixed store still opens and serves.
    const mem = MemorySystem.open({ storeDir });
    expect(mem.listEpisodic().length).toBeGreaterThan(0);
    mem.close();
  });

  it("flags genuine id collisions but not latest-wins supersedes", async () => {
    const { storeDir } = await populatedStore();
    // Reuse an existing episodic id for a different logical record.
    const firstLine = fs
      .readFileSync(path.join(storeDir, "episodic.jsonl"), "utf8")
      .split("\n")
      .find(Boolean)!;
    const victim = JSON.parse(firstLine) as { id: string };
    fs.appendFileSync(
      path.join(storeDir, "episodic.jsonl"),
      JSON.stringify({
        id: victim.id,
        kind: "turn",
        sessionId: "a-completely-different-session",
        entryId: "zzzzzzzz",
        role: "user",
        text: "impostor record",
        timestamp: "2026-01-01T00:00:00.000Z",
        salience: 0.5,
        accessCount: 0,
        state: "active",
      }) + "\n",
    );
    const c = capture();
    expect(await runCli(["doctor", "--store-dir", storeDir], c.out)).toBe(1);
    expect(c.text()).toContain("id collision");
  });

  it("flags inconsistent embedding dimensions", async () => {
    const { storeDir } = await populatedStore();
    fs.appendFileSync(
      path.join(storeDir, "episodic.jsonl"),
      JSON.stringify({
        id: "odd/dim#0",
        kind: "turn",
        sessionId: "odd",
        role: "user",
        text: "odd dimension record",
        timestamp: "2026-01-01T00:00:00.000Z",
        salience: 0.5,
        accessCount: 0,
        state: "active",
        embedding: [0.1, 0.2, 0.3],
      }) + "\n",
    );
    const c = capture();
    expect(await runCli(["doctor", "--store-dir", storeDir], c.out)).toBe(1);
    expect(c.text()).toContain("inconsistent embedding dimensions");
  });
});
