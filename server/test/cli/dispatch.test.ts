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
  ltmBackfill: vi.fn(async () => 0),
  ltmDoctor: vi.fn(async () => 0),
  ltmPurgeFacts: vi.fn(async () => 0),
}));

// Imported AFTER the mock so the mocked symbols are bound.
import { runCli } from "../../src/cli/dispatch.ts";
import {
  ltmReplay,
  ltmHealth,
  ltmBackfill,
  ltmDoctor,
  ltmPurgeFacts,
} from "../../src/cli/ltm-commands.ts";

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
    vi.mocked(ltmBackfill).mockClear();
    vi.mocked(ltmDoctor).mockClear();
    vi.mocked(ltmPurgeFacts).mockClear();
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

  it("routes `ltm replay --verbose` to ltmReplay with verbose=true", async () => {
    expect(await runCli(["ltm", "replay", "--verbose"])).toBe(0);
    expect(ltmReplay).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ltmReplay).mock.calls[0]![0]).toEqual({
      force: false,
      rebuild: false,
      prune: false,
      verbose: true,
    });
  });

  it("routes `ltm replay --quiet` to ltmReplay with quiet=true", async () => {
    expect(await runCli(["ltm", "replay", "--quiet"])).toBe(0);
    expect(ltmReplay).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ltmReplay).mock.calls[0]![0]).toEqual({
      force: false,
      rebuild: false,
      prune: false,
      quiet: true,
    });
  });

  it("routes `ltm health` to ltmHealth", async () => {
    expect(await runCli(["ltm", "health"])).toBe(0);
    expect(ltmHealth).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ltmHealth).mock.calls[0]![0]).toEqual({});
  });

  it("routes `ltm doctor` to ltmDoctor with fix=false", async () => {
    expect(await runCli(["ltm", "doctor"])).toBe(0);
    expect(ltmDoctor).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ltmDoctor).mock.calls[0]![0]).toEqual({ fix: false });
  });

  it("routes `ltm doctor --fix` to ltmDoctor with fix=true", async () => {
    expect(await runCli(["ltm", "doctor", "--fix"])).toBe(0);
    expect(ltmDoctor).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ltmDoctor).mock.calls[0]![0]).toEqual({ fix: true });
  });

  it("routes `ltm purge-facts <dir>` to ltmPurgeFacts", async () => {
    expect(await runCli(["ltm", "purge-facts", "/tmp/fixture"])).toBe(0);
    expect(ltmPurgeFacts).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ltmPurgeFacts).mock.calls[0]![0]).toEqual({
      sessionsDir: "/tmp/fixture",
    });
  });

  it("returns 2 for `ltm purge-facts` (missing <sessions-dir>) without calling ltmPurgeFacts", async () => {
    expect(await runCli(["ltm", "purge-facts"])).toBe(2);
    expect(ltmPurgeFacts).not.toHaveBeenCalled();
  });

  it("routes `ltm backfill <dir>` to ltmBackfill with defaults", async () => {
    expect(await runCli(["ltm", "backfill", "/tmp/fixture"])).toBe(0);
    expect(ltmBackfill).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(ltmBackfill).mock.calls[0]![0];
    expect(opts.dir).toBe("/tmp/fixture");
    expect(opts.rate).toBe(2);
    expect(opts.batch).toBe(10);
    expect(opts.pauseMs).toBe(2000);
    expect(opts.pollMs).toBe(5000);
    expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("routes `ltm backfill <dir> --rate=N --batch=N --pause-ms=N --poll-ms=N` forwarding all flags", async () => {
    expect(
      await runCli([
        "ltm",
        "backfill",
        "/tmp/fixture",
        "--rate=5",
        "--batch=20",
        "--pause-ms=500",
        "--poll-ms=1000",
      ]),
    ).toBe(0);
    expect(ltmBackfill).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(ltmBackfill).mock.calls[0]![0];
    expect(opts.dir).toBe("/tmp/fixture");
    expect(opts.rate).toBe(5);
    expect(opts.batch).toBe(20);
    expect(opts.pauseMs).toBe(500);
    expect(opts.pollMs).toBe(1000);
  });

  it("parseFlag rejects NaN/zero/negative values and falls back to defaults", async () => {
    // --rate=abc (NaN), --batch=0 (≤0), --pause-ms=-1 (≤0), --poll-ms is omitted (default)
    expect(
      await runCli([
        "ltm",
        "backfill",
        "/tmp/fixture",
        "--rate=abc",
        "--batch=0",
        "--pause-ms=-1",
      ]),
    ).toBe(0);
    expect(ltmBackfill).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(ltmBackfill).mock.calls[0]![0];
    expect(opts.dir).toBe("/tmp/fixture");
    expect(opts.rate).toBe(2); // default
    expect(opts.batch).toBe(10); // default
    expect(opts.pauseMs).toBe(2000); // default
    expect(opts.pollMs).toBe(5000); // default (not provided)
  });

  it("returns 2 for `ltm backfill` (missing <dir>) without calling ltmBackfill", async () => {
    expect(await runCli(["ltm", "backfill"])).toBe(2);
    expect(ltmBackfill).not.toHaveBeenCalled();
  });
});
