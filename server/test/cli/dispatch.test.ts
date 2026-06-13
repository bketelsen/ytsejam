import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli/dispatch.ts";

describe("runCli", () => {
  let dataDir = "";
  let ltmDir = "";
  let stdoutSpy: { mockRestore(): void };
  let stderrSpy: { mockRestore(): void };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "disp-data-"));
    ltmDir = await mkdtemp(join(tmpdir(), "disp-ltm-"));
    process.env.YTSEJAM_DATA_DIR = dataDir;
    process.env.LTM_STORE_DIR = ltmDir;
    // Silence the CLI's process.stdout/process.stderr writes -- they would
    // bleed into the test reporter's output.
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
  });

  afterEach(async () => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.YTSEJAM_DATA_DIR;
    delete process.env.LTM_STORE_DIR;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    if (ltmDir) await rm(ltmDir, { recursive: true, force: true });
  });

  it("returns null for empty argv (server should boot)", async () => {
    expect(await runCli([])).toBeNull();
  });

  it("returns null for unrelated argv (server should boot)", async () => {
    expect(await runCli(["something-else"])).toBeNull();
    expect(await runCli(["--version"])).toBeNull();
  });

  it("returns 0 for --help", async () => {
    expect(await runCli(["--help"])).toBe(0);
    expect(await runCli(["-h"])).toBe(0);
  });

  it("returns 0 for `ltm --help`", async () => {
    expect(await runCli(["ltm", "--help"])).toBe(0);
    expect(await runCli(["ltm", "-h"])).toBe(0);
  });

  it("returns 2 for `ltm` (missing subcommand)", async () => {
    expect(await runCli(["ltm"])).toBe(2);
  });

  it("returns 2 for an unknown subcommand", async () => {
    expect(await runCli(["ltm", "bogus"])).toBe(2);
  });

  it("routes `ltm replay` to ltmReplay (exit 0 on empty store)", async () => {
    // Empty dataDir: nothing to replay -> stats.errors === 0 -> exit 0.
    expect(await runCli(["ltm", "replay"])).toBe(0);
  });

  it("routes `ltm replay --force` (passes force flag) to ltmReplay", async () => {
    // Drop a malformed line so we can prove --force actually scans
    // (otherwise mtime cache could no-op on a second run, but here we
    // just need the file to exist and be parsed once).
    await mkdir(join(dataDir, "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "personal", "observations.md"),
      "MALFORMED\n",
    );
    expect(await runCli(["ltm", "replay", "--force"])).toBe(1);
  });

  it("routes `ltm health` to ltmHealth", async () => {
    expect(await runCli(["ltm", "health"])).toBe(0);
  });
});
