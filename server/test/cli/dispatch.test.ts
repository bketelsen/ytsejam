import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the command module so the routing tests can assert on the EXACT
// arguments runCli forwarded -- the empirical "exit code happened to
// be N" assertion doesn't prove flag wiring (a regression that silently
// dropped --force would still see the same exit code because the CLI is
// one-shot and the mtime cache doesn't persist across calls).
vi.mock("../../src/cli/ltm-commands.ts", () => ({
  ltmReplay: vi.fn(async () => 0),
  ltmHealth: vi.fn(async () => 0),
}));

// Imported AFTER the mock so the mocked symbols are bound.
import { runCli } from "../../src/cli/dispatch.ts";
import { ltmReplay, ltmHealth } from "../../src/cli/ltm-commands.ts";

describe("runCli", () => {
  let dataDir = "";
  let ltmDir = "";
  let stdoutSpy: { mockRestore(): void };
  let stderrSpy: { mockRestore(): void };
  let prevDataDir: string | undefined;
  let prevLtmStoreDir: string | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "disp-data-"));
    ltmDir = await mkdtemp(join(tmpdir(), "disp-ltm-"));
    // Save/restore the parent env rather than unconditional delete -- avoids
    // clobbering a deliberately-set test env from a wrapper or CI runner.
    prevDataDir = process.env.YTSEJAM_DATA_DIR;
    prevLtmStoreDir = process.env.LTM_STORE_DIR;
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
    // Reset call history per test so routing assertions are independent.
    vi.mocked(ltmReplay).mockClear();
    vi.mocked(ltmHealth).mockClear();
  });

  afterEach(async () => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    if (prevDataDir === undefined) delete process.env.YTSEJAM_DATA_DIR;
    else process.env.YTSEJAM_DATA_DIR = prevDataDir;
    if (prevLtmStoreDir === undefined) delete process.env.LTM_STORE_DIR;
    else process.env.LTM_STORE_DIR = prevLtmStoreDir;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    if (ltmDir) await rm(ltmDir, { recursive: true, force: true });
  });

  it("returns null for empty argv (server should boot)", async () => {
    expect(await runCli([])).toBeNull();
    expect(ltmReplay).not.toHaveBeenCalled();
    expect(ltmHealth).not.toHaveBeenCalled();
  });

  it("returns null for unrelated argv (server should boot)", async () => {
    expect(await runCli(["something-else"])).toBeNull();
    expect(await runCli(["--version"])).toBeNull();
    expect(ltmReplay).not.toHaveBeenCalled();
    expect(ltmHealth).not.toHaveBeenCalled();
  });

  it("returns 0 for --help", async () => {
    expect(await runCli(["--help"])).toBe(0);
    expect(await runCli(["-h"])).toBe(0);
  });

  it("returns 0 for `ltm --help`", async () => {
    expect(await runCli(["ltm", "--help"])).toBe(0);
    expect(await runCli(["ltm", "-h"])).toBe(0);
    // --help is a parse-time terminator; ltmReplay must NOT have been called.
    expect(ltmReplay).not.toHaveBeenCalled();
  });

  it("returns 2 for `ltm` (missing subcommand)", async () => {
    expect(await runCli(["ltm"])).toBe(2);
    expect(ltmReplay).not.toHaveBeenCalled();
  });

  it("returns 2 for an unknown subcommand", async () => {
    expect(await runCli(["ltm", "bogus"])).toBe(2);
    expect(ltmReplay).not.toHaveBeenCalled();
  });

  it("routes `ltm replay` to ltmReplay with force=false", async () => {
    expect(await runCli(["ltm", "replay"])).toBe(0);
    expect(ltmReplay).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ltmReplay).mock.calls[0]![0]).toEqual({
      force: false,
      rebuild: false,
      prune: false,
    });
  });

  it("routes `ltm replay --force` to ltmReplay with force=true", async () => {
    // This assertion is what proves --force ACTUALLY plumbs through the
    // dispatcher into the command. A regression that silently dropped the
    // flag (e.g. by removing rest.includes("--force")) would still exit 0
    // on an empty dataDir, so an exit-code-only test cannot catch it.
    expect(await runCli(["ltm", "replay", "--force"])).toBe(0);
    expect(ltmReplay).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ltmReplay).mock.calls[0]![0]).toEqual({
      force: true,
      rebuild: false,
      prune: false,
    });
  });

  it("routes `ltm replay --rebuild` to ltmReplay with rebuild=true", async () => {
    expect(await runCli(["ltm", "replay", "--rebuild"])).toBe(0);
    expect(ltmReplay).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ltmReplay).mock.calls[0]![0]).toEqual({
      force: false,
      rebuild: true,
      prune: false,
    });
  });

  it("routes `ltm replay --rebuild --prune` to ltmReplay with rebuild and prune true", async () => {
    expect(await runCli(["ltm", "replay", "--rebuild", "--prune"])).toBe(0);
    expect(ltmReplay).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ltmReplay).mock.calls[0]![0]).toEqual({
      force: false,
      rebuild: true,
      prune: true,
    });
  });

  it("routes `ltm health` to ltmHealth", async () => {
    expect(await runCli(["ltm", "health"])).toBe(0);
    expect(ltmHealth).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ltmHealth).mock.calls[0]![0]).toEqual({});
  });
});
