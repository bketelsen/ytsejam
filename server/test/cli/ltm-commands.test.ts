import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySystem } from "ltm";
import { ltmReplay, ltmHealth } from "../../src/cli/ltm-commands.ts";

const ltmEmbedderEnvKeys = [
  "YTSEJAM_LTM_EMBEDDER",
  "YTSEJAM_LTM_COPILOT_MODEL",
  "YTSEJAM_LTM_COPILOT_URL",
  "YTSEJAM_LTM_OLLAMA_MODEL",
  "YTSEJAM_LTM_OLLAMA_URL",
] as const;

let savedLtmEmbedderEnv: Record<
  (typeof ltmEmbedderEnvKeys)[number],
  string | undefined
> = {
  YTSEJAM_LTM_EMBEDDER: undefined,
  YTSEJAM_LTM_COPILOT_MODEL: undefined,
  YTSEJAM_LTM_COPILOT_URL: undefined,
  YTSEJAM_LTM_OLLAMA_MODEL: undefined,
  YTSEJAM_LTM_OLLAMA_URL: undefined,
};

beforeEach(() => {
  savedLtmEmbedderEnv = Object.fromEntries(
    ltmEmbedderEnvKeys.map((key) => [key, process.env[key]]),
  ) as Record<(typeof ltmEmbedderEnvKeys)[number], string | undefined>;
  process.env.YTSEJAM_LTM_EMBEDDER = "hash";
  delete process.env.YTSEJAM_LTM_COPILOT_MODEL;
  delete process.env.YTSEJAM_LTM_COPILOT_URL;
  delete process.env.YTSEJAM_LTM_OLLAMA_MODEL;
  delete process.env.YTSEJAM_LTM_OLLAMA_URL;
});

afterEach(() => {
  for (const key of ltmEmbedderEnvKeys) {
    const value = savedLtmEmbedderEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("ltmReplay CLI", () => {
  let dataDir = "";
  let ltmDir = "";
  let out: string[] = [];
  let err: string[] = [];
  let prevLtmEmbedder: string | undefined;
  let prevOllamaUrl: string | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "cli-data-"));
    ltmDir = await mkdtemp(join(tmpdir(), "cli-ltm-"));
    out = [];
    err = [];
    prevLtmEmbedder = process.env.YTSEJAM_LTM_EMBEDDER;
    prevOllamaUrl = process.env.YTSEJAM_LTM_OLLAMA_URL;
  });

  afterEach(async () => {
    if (prevLtmEmbedder === undefined) delete process.env.YTSEJAM_LTM_EMBEDDER;
    else process.env.YTSEJAM_LTM_EMBEDDER = prevLtmEmbedder;
    if (prevOllamaUrl === undefined) delete process.env.YTSEJAM_LTM_OLLAMA_URL;
    else process.env.YTSEJAM_LTM_OLLAMA_URL = prevOllamaUrl;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    if (ltmDir) await rm(ltmDir, { recursive: true, force: true });
  });

  it("replays observations into a fresh LTM, exits 0, prints JSON stats", async () => {
    await mkdir(join(dataDir, "memory", "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "memory", "personal", "observations.md"),
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
    await mkdir(join(dataDir, "memory", "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "memory", "personal", "observations.md"),
      "- 2026-06-10 [a]: good\n- not-a-date [bad]: malformed\n",
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
    expect(err.join("\n")).toContain(
      "[ltm replay] [warn] malformed line skipped",
    );
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

  it("exits 1 and reports invalid embedder config when YTSEJAM_LTM_EMBEDDER cannot be parsed", async () => {
    process.env.YTSEJAM_LTM_EMBEDDER = "garbage";

    const code = await ltmReplay({
      dataDir,
      ltmStoreDir: ltmDir,
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
    });

    expect(code).toBe(1);
    expect(err.join("\n")).toContain("Invalid YTSEJAM_LTM_EMBEDDER");
  });

  it("exits 1 and reports embedder factory failures with nested Ollama URL details", async () => {
    process.env.YTSEJAM_LTM_EMBEDDER = "ollama";
    process.env.YTSEJAM_LTM_OLLAMA_URL = "http://127.0.0.1:1";

    const code = await ltmReplay({
      dataDir,
      ltmStoreDir: ltmDir,
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
    });

    expect(code).toBe(1);
    expect(err.join("\n")).toContain("could not create LTM embedder");
    expect(err.join("\n")).toContain("http://127.0.0.1:1");
  });

  it("exits 0 with no observations to replay on an empty memory tree", async () => {
    await mkdir(join(dataDir, "memory"), { recursive: true });
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

  it("warns and ignores prune when rebuild is false", async () => {
    await mkdir(join(dataDir, "memory"), { recursive: true });
    const code = await ltmReplay({
      dataDir,
      ltmStoreDir: ltmDir,
      prune: true,
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
    });
    expect(code).toBe(0);
    expect(err).toContain(
      "[ltm replay] --prune requires --rebuild; ignoring prune",
    );
    const stats = JSON.parse(out[0]!);
    expect(stats.pruned).toBe(0);
  });

  it("accepts rebuild and threads it to the reconciler", async () => {
    await mkdir(join(dataDir, "memory", "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "memory", "personal", "observations.md"),
      "- 2026-06-10 [a]: rebuild cli line\n",
    );
    const first = await ltmReplay({
      dataDir,
      ltmStoreDir: ltmDir,
      stdout: () => {},
      stderr: (l) => err.push(l),
    });
    expect(first).toBe(0);

    const rebuiltOut: string[] = [];
    const rebuiltErr: string[] = [];
    const code = await ltmReplay({
      dataDir,
      ltmStoreDir: ltmDir,
      rebuild: true,
      stdout: (l) => rebuiltOut.push(l),
      stderr: (l) => rebuiltErr.push(l),
    });
    expect(code).toBe(0);
    const stats = JSON.parse(rebuiltOut[0]!);
    expect(stats.rebuilt).toBe(1);
    expect(stats.replayed).toBe(0);
    expect(stats.skipped).toBe(0);
    expect(rebuiltErr).toEqual([]);
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
    await mkdir(join(dataDir, "memory"), { recursive: true });
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

describe("ltmReplay resolution + open-failure independence", () => {
  // These two probes exercise paths not covered by the in-process
  // single-writer-lock trick above: the empty-string coercion contract and
  // the LTM-open failure mode via a path that cannot be created at all.
  let dataDir = "";
  let envLtmDir = "";
  let prevLtmStoreDir: string | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "cli-res-data-"));
    envLtmDir = await mkdtemp(join(tmpdir(), "cli-res-envltm-"));
    prevLtmStoreDir = process.env.LTM_STORE_DIR;
  });

  afterEach(async () => {
    if (prevLtmStoreDir === undefined) delete process.env.LTM_STORE_DIR;
    else process.env.LTM_STORE_DIR = prevLtmStoreDir;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    if (envLtmDir) await rm(envLtmDir, { recursive: true, force: true });
  });

  it("opts.ltmStoreDir='' coerces to LTM_STORE_DIR env (|| semantics, not ??)", async () => {
    // Empty-string opts.ltmStoreDir MUST fall through to env (`||` not `??`),
    // matching server boot's resolution. With `??` this would attempt
    // MemorySystem.open({storeDir: ""}) and fail with a cryptic LTM error.
    process.env.LTM_STORE_DIR = envLtmDir;
    await mkdir(join(dataDir, "memory", "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "memory", "personal", "observations.md"),
      "- 2026-06-10 [a]: coerce-test\n",
    );
    const out: string[] = [];
    const err: string[] = [];
    const code = await ltmReplay({
      dataDir,
      ltmStoreDir: "",
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
    });
    expect(code).toBe(0);
    expect(out.length).toBe(1);
    const stats = JSON.parse(out[0]!);
    expect(stats.replayed).toBe(1);
  });

  it("exits 1 with guidance when ltmStoreDir cannot be opened (path under a file)", async () => {
    // /dev/null is a character device; mkdirSync under it always fails with
    // ENOTDIR. Proves the open-failure branch independent of the in-process
    // single-writer-lock trick (which collides with the test process itself).
    // Using /dev/null (not /proc/...) avoids any /proc-quirk weirdness.
    const err: string[] = [];
    const code = await ltmReplay({
      dataDir,
      ltmStoreDir: "/dev/null/cannot-create-here",
      stdout: () => {},
      stderr: (l) => err.push(l),
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/single-writer/);
    expect(err.join("\n")).toMatch(/systemctl --user stop ytsejam/);
  });
});
