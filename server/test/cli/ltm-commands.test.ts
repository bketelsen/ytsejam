import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySystem } from "ltm";
import { ltmReplay, ltmHealth } from "../../src/cli/ltm-commands.ts";

describe("ltmReplay CLI", () => {
  let dataDir = "";
  let ltmDir = "";
  let out: string[] = [];
  let err: string[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "cli-data-"));
    ltmDir = await mkdtemp(join(tmpdir(), "cli-ltm-"));
    out = [];
    err = [];
  });

  afterEach(async () => {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    if (ltmDir) await rm(ltmDir, { recursive: true, force: true });
  });

  it("replays observations into a fresh LTM, exits 0, prints JSON stats", async () => {
    await mkdir(join(dataDir, "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "personal", "observations.md"),
      "- 2026-06-10 [a]: cli line one\n- 2026-06-11 [b]: cli line two\n",
    );
    const code = await ltmReplay({
      dataDir,
      ltmStoreDir: ltmDir,
      force: true,
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
    });
    expect(code).toBe(0);
    expect(out.length).toBe(1);
    const stats = JSON.parse(out[0]!);
    expect(stats.replayed).toBe(2);
    expect(stats.errors).toBe(0);
  });

  it("exits 1 when stats.errors > 0 (malformed line)", async () => {
    await mkdir(join(dataDir, "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "personal", "observations.md"),
      "- 2026-06-10 [a]: good\nMALFORMED\n",
    );
    const code = await ltmReplay({
      dataDir,
      ltmStoreDir: ltmDir,
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
    });
    expect(code).toBe(1);
    expect(out.length).toBe(1);
    const stats = JSON.parse(out[0]!);
    expect(stats.errors).toBeGreaterThanOrEqual(1);
  });

  it("exits 1 with single-writer-lock guidance when LTM is held by another process", async () => {
    // Hold the lock from inside this test process. ltmReplay opens
    // synchronously, so the second open from inside the same process is
    // still treated as a lock conflict by LTM.
    const holder = MemorySystem.open({ storeDir: ltmDir });
    try {
      const code = await ltmReplay({
        dataDir,
        ltmStoreDir: ltmDir,
        stdout: (l) => out.push(l),
        stderr: (l) => err.push(l),
      });
      expect(code).toBe(1);
      expect(err.length).toBeGreaterThanOrEqual(1);
      expect(err.join("\n")).toMatch(/single-writer/);
      expect(err.join("\n")).toMatch(/systemctl --user stop ytsejam/);
    } finally {
      holder.close();
    }
  });

  it("exits 0 with no observations to replay on an empty dataDir", async () => {
    const code = await ltmReplay({
      dataDir,
      ltmStoreDir: ltmDir,
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
    });
    expect(code).toBe(0);
    expect(out.length).toBe(1);
    const stats = JSON.parse(out[0]!);
    expect(stats.replayed).toBe(0);
    expect(stats.scannedFiles).toBe(0);
  });
});

describe("ltmHealth CLI", () => {
  let dataDir = "";
  let ltmDir = "";

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "cli-health-data-"));
    ltmDir = await mkdtemp(join(tmpdir(), "cli-health-ltm-"));
  });

  afterEach(async () => {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    if (ltmDir) await rm(ltmDir, { recursive: true, force: true });
  });

  it("prints stderr warning and a JSON stats line, exits 0 on healthy empty store", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await ltmHealth({
      dataDir,
      ltmStoreDir: ltmDir,
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
    });
    expect(code).toBe(0);
    expect(out.length).toBe(1);
    expect(err.join("\n")).toMatch(/health endpoint/);
  });
});
