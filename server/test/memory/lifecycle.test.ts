import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemorySystem } from "ltm";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LtmReconciler } from "../../src/memory/bridge/ltm-reconciler.ts";
import * as memory from "../../src/memory/index.ts";

const noopLogger = () => {};

describe("memory + reconciler lifecycle", () => {
  let dataDir = "";
  let ltmDir = "";
  let ltm: MemorySystem | null = null;
  let reconciler: LtmReconciler | null = null;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "lc-data-"));
    process.env.YTSEJAM_MEMORY_DIR = dataDir;
    execFileSync("git", ["init", "-q"], { cwd: dataDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dataDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dataDir });
    execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "root"], { cwd: dataDir });
    await mkdir(join(dataDir, "memory"), { recursive: true });
    ltmDir = await mkdtemp(join(tmpdir(), "lc-ltm-"));
    // Belt-and-suspenders: module-level attach state lives between tests in
    // the same process. afterEach resets, but if a prior test's
    // reconciler.stop() ever rejected, the reset would have been skipped
    // and contaminated this test. Reset here too. Mirrors the pattern
    // record-observation.test.ts already uses for attachLtm.
    memory.attachReconciler(null);
    memory.attachLtm(null);
  });

  afterEach(async () => {
    if (reconciler) {
      await reconciler.stop();
      reconciler = null;
    }
    memory.attachReconciler(null);
    memory.attachLtm(null);
    if (ltm) {
      ltm.close();
      ltm = null;
    }
    delete process.env.YTSEJAM_MEMORY_DIR;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    if (ltmDir) await rm(ltmDir, { recursive: true, force: true });
  });

  it("attach + start + stop without throwing; health surfaces reconciler state", async () => {
    ltm = MemorySystem.open({ storeDir: ltmDir });
    reconciler = new LtmReconciler({
      ltm,
      dataDir,
      intervalMs: 60_000,
      logger: noopLogger,
    });
    memory.attachLtm(ltm);
    memory.attachReconciler(reconciler);
    reconciler.start();
    const h = await memory.health();
    expect(h.ok).toBe(true);
    expect(h.ltm).toBeDefined();
    expect(h.ltm?.reachable).toBe(true);
    expect(h.ltm?.consecutiveFailures).toBe(0);
  });

  it("memory.health() omits ltm when no reconciler is attached", async () => {
    // Do not attach anything.
    const h = await memory.health();
    expect(h.ok).toBe(true);
    // Both assertions are necessary: toBeUndefined() also passes for an
    // explicitly-injected {ltm: undefined}, which would violate the spec's
    // "OMIT the field" requirement (and break for...in / JSON serialisation).
    // "ltm" in h kills that mutant.
    expect(h.ltm).toBeUndefined();
    expect("ltm" in h).toBe(false);
  });

  it("reconcileNow throws when no reconciler is attached", async () => {
    await expect(memory.reconcileNow()).rejects.toThrow(
      /no reconciler attached/,
    );
  });

  it("reconcileNow pass-through returns stats", async () => {
    ltm = MemorySystem.open({ storeDir: ltmDir });
    reconciler = new LtmReconciler({
      ltm,
      dataDir,
      intervalMs: 60_000,
      logger: noopLogger,
    });
    memory.attachLtm(ltm);
    memory.attachReconciler(reconciler);
    const stats = await memory.reconcileNow();
    expect(stats.errors).toBe(0);
    expect(stats.scannedFiles).toBeGreaterThanOrEqual(0);
  });

  it("attachReconciler(null) detaches and memory.health() reflects it", async () => {
    ltm = MemorySystem.open({ storeDir: ltmDir });
    reconciler = new LtmReconciler({
      ltm,
      dataDir,
      intervalMs: 60_000,
      logger: noopLogger,
    });
    memory.attachLtm(ltm);
    memory.attachReconciler(reconciler);
    const h1 = await memory.health();
    expect(h1.ltm).toBeDefined();
    memory.attachReconciler(null);
    const h2 = await memory.health();
    // Both assertions for the same reason as the "omits ltm" test above:
    // toBeUndefined() also accepts {ltm: undefined}; "ltm" in h pins OMIT.
    expect(h2.ltm).toBeUndefined();
    expect("ltm" in h2).toBe(false);
  });
});

describe("getLtm read accessor", () => {
  it("returns null when no LTM is attached", () => {
    // belt-and-suspenders: another test may have left state dirty
    memory.attachLtm(null);
    expect(memory.getLtm()).toBeNull();
  });

  it("returns the attached MemorySystem instance", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "ltm-getltm-"));
    const ltm = MemorySystem.open({ storeDir });
    try {
      memory.attachLtm(ltm);
      expect(memory.getLtm()).toBe(ltm); // identity, not just equality
    } finally {
      memory.attachLtm(null);
      ltm.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  it("returns null after detach", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "ltm-getltm-"));
    const ltm = MemorySystem.open({ storeDir });
    try {
      memory.attachLtm(ltm);
      memory.attachLtm(null);
      expect(memory.getLtm()).toBeNull();
    } finally {
      ltm.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  });
});
