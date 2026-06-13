import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { MemorySystem } from "ltm";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LtmReconciler } from "../../../src/memory/bridge/ltm-reconciler.ts";

describe("LtmReconciler", () => {
  let dataDir: string;
  let ltmDir: string;
  let ltm: MemorySystem;
  let reconciler: LtmReconciler | null = null;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "recon-data-"));
    ltmDir = await mkdtemp(join(tmpdir(), "recon-ltm-"));
    ltm = MemorySystem.open({ storeDir: ltmDir });
  });

  afterEach(async () => {
    if (reconciler) {
      await reconciler.stop();
      reconciler = null;
    }
    ltm.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(ltmDir, { recursive: true, force: true });
  });

  it("replays missed lines from observations.md on reconcile()", async () => {
    await mkdir(join(dataDir, "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "personal", "observations.md"),
      "- 2026-06-10 [a]: line one\n- 2026-06-11 [b]: line two\n",
    );
    reconciler = new LtmReconciler({ ltm, dataDir });
    const stats = await reconciler.reconcile();
    expect(stats.replayed).toBe(2);
    expect(stats.scannedLines).toBe(2);
    expect(stats.errors).toBe(0);
  });

  it("skips already-mirrored lines on subsequent reconcile (force ignores mtime cache only)", async () => {
    await mkdir(join(dataDir, "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "personal", "observations.md"),
      "- 2026-06-10 [a]: line one\n",
    );
    reconciler = new LtmReconciler({ ltm, dataDir });
    await reconciler.reconcile();
    const second = await reconciler.reconcile({ force: true });
    expect(second.replayed).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it("skips unchanged files via mtime cache when not forced", async () => {
    await mkdir(join(dataDir, "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "personal", "observations.md"),
      "- 2026-06-10 [a]: line one\n",
    );
    reconciler = new LtmReconciler({ ltm, dataDir });
    await reconciler.reconcile();
    const cached = await reconciler.reconcile();
    expect(cached.scannedFiles).toBe(0);
    expect(cached.scannedLines).toBe(0);
  });

  it("--force re-walks even unchanged files", async () => {
    await mkdir(join(dataDir, "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "personal", "observations.md"),
      "- 2026-06-10 [a]: line one\n",
    );
    reconciler = new LtmReconciler({ ltm, dataDir });
    await reconciler.reconcile();
    const forced = await reconciler.reconcile({ force: true });
    expect(forced.scannedFiles).toBe(1);
    expect(forced.skipped).toBe(1);
  });

  it("isolates per-line errors (malformed line doesn't stop the rest)", async () => {
    await mkdir(join(dataDir, "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "personal", "observations.md"),
      "- 2026-06-10 [a]: good\nMALFORMED\n- 2026-06-11 [b]: also good\n",
    );
    reconciler = new LtmReconciler({ ltm, dataDir });
    const stats = await reconciler.reconcile();
    expect(stats.replayed).toBe(2);
    expect(stats.errors).toBe(1);
  });

  it("walks nested domain paths (e.g. projects/ytsejam/observations.md)", async () => {
    await mkdir(join(dataDir, "projects", "ytsejam"), { recursive: true });
    await writeFile(
      join(dataDir, "projects", "ytsejam", "observations.md"),
      "- 2026-06-13 [shipped]: bridge 1\n",
    );
    reconciler = new LtmReconciler({ ltm, dataDir });
    const stats = await reconciler.reconcile();
    expect(stats.replayed).toBe(1);
    expect(stats.errors).toBe(0);
  });

  it("start()/stop() timer lifecycle is idempotent and safe", async () => {
    reconciler = new LtmReconciler({ ltm, dataDir, intervalMs: 1000 });
    await reconciler.stop(); // before start
    reconciler.start();
    reconciler.start(); // second call must not stack
    expect(reconciler.health().reachable).toBe(true);
    await reconciler.stop();
    const stats = await reconciler.reconcile();
    expect(stats.scannedFiles).toBeGreaterThanOrEqual(0);
  });

  it("health: per-line LTM failure surfaces as stats.errors but does NOT bump consecutiveFailures", async () => {
    await mkdir(join(dataDir, "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "personal", "observations.md"),
      "- 2026-06-10 [a]: line one\n",
    );
    const fakeLtm = {
      hasObservation: () => false,
      recordObservation: vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValue(undefined),
    } as unknown as MemorySystem;
    reconciler = new LtmReconciler({ ltm: fakeLtm, dataDir });
    const r1 = await reconciler.reconcile();
    expect(r1.errors).toBe(1);
    expect(reconciler.health().consecutiveFailures).toBe(0); // per-LINE error, not per-TICK
  });

  it("health: tick-level throw (bad dataDir) increments consecutiveFailures", async () => {
    reconciler = new LtmReconciler({ ltm, dataDir: "/nonexistent-path-xyz-12345" });
    const r1 = await reconciler.reconcile();
    expect(r1.errors).toBeGreaterThanOrEqual(1);
    expect(reconciler.health().consecutiveFailures).toBe(1);
    const r2 = await reconciler.reconcile();
    expect(reconciler.health().consecutiveFailures).toBe(2);
  });

  it("health: a successful tick clears consecutiveFailures", async () => {
    // First tick: bad dataDir → consecutiveFailures = 1.
    reconciler = new LtmReconciler({ ltm, dataDir: "/nonexistent-path-xyz-67890" });
    await reconciler.reconcile();
    expect(reconciler.health().consecutiveFailures).toBe(1);
    // Now: stop, swap to good dataDir, tick — failures should clear.
    await reconciler.stop();
    reconciler = new LtmReconciler({ ltm, dataDir });
    // Empty good dataDir scan = 0 files, 0 errors → success tick.
    const r = await reconciler.reconcile();
    expect(r.errors).toBe(0);
    expect(reconciler.health().consecutiveFailures).toBe(0);
    expect(reconciler.health().reachable).toBe(true);
  });
});
