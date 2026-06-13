import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { MemorySystem } from "ltm";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LtmReconciler } from "../../../src/memory/bridge/ltm-reconciler.ts";

// Inject a no-op logger in every test so the reconciler's warn/info chatter
// (malformed-line warnings, tick errors) does not leak into the suite's
// stderr. Tests that care about a specific warn can pass their own logger.
const noopLogger = () => {};

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
    reconciler = new LtmReconciler({ ltm, dataDir, logger: noopLogger });
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
    reconciler = new LtmReconciler({ ltm, dataDir, logger: noopLogger });
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
    reconciler = new LtmReconciler({ ltm, dataDir, logger: noopLogger });
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
    reconciler = new LtmReconciler({ ltm, dataDir, logger: noopLogger });
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
    reconciler = new LtmReconciler({ ltm, dataDir, logger: noopLogger });
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
    reconciler = new LtmReconciler({ ltm, dataDir, logger: noopLogger });
    const stats = await reconciler.reconcile();
    expect(stats.replayed).toBe(1);
    expect(stats.errors).toBe(0);
  });

  it("start()/stop() timer lifecycle is idempotent and safe", async () => {
    reconciler = new LtmReconciler({ ltm, dataDir, intervalMs: 1000, logger: noopLogger });
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
    reconciler = new LtmReconciler({ ltm: fakeLtm, dataDir, logger: noopLogger });
    const r1 = await reconciler.reconcile();
    expect(r1.errors).toBe(1);
    expect(reconciler.health().consecutiveFailures).toBe(0); // per-LINE error, not per-TICK
  });

  it("health: tick-level throw (bad dataDir) increments consecutiveFailures", async () => {
    reconciler = new LtmReconciler({ ltm, dataDir: "/nonexistent-path-xyz-12345", logger: noopLogger });
    const r1 = await reconciler.reconcile();
    expect(r1.errors).toBeGreaterThanOrEqual(1);
    expect(reconciler.health().consecutiveFailures).toBe(1);
    const r2 = await reconciler.reconcile();
    expect(reconciler.health().consecutiveFailures).toBe(2);
  });

  it("health: a successful tick clears consecutiveFailures", async () => {
    // First tick: bad dataDir → consecutiveFailures = 1.
    reconciler = new LtmReconciler({ ltm, dataDir: "/nonexistent-path-xyz-67890", logger: noopLogger });
    await reconciler.reconcile();
    expect(reconciler.health().consecutiveFailures).toBe(1);
    // Now: stop, swap to good dataDir, tick — failures should clear.
    await reconciler.stop();
    reconciler = new LtmReconciler({ ltm, dataDir, logger: noopLogger });
    // Empty good dataDir scan = 0 files, 0 errors → success tick.
    const r = await reconciler.reconcile();
    expect(r.errors).toBe(0);
    expect(reconciler.health().consecutiveFailures).toBe(0);
    expect(reconciler.health().reachable).toBe(true);
  });

  it("CRLF lines dedup against the clean live-path origin (no permanent re-replay)", async () => {
    await mkdir(join(dataDir, "personal"), { recursive: true });
    // Write file with CRLF line endings -- the exact pathology from external
    // editors / `git checkout` with core.autocrlf=true.
    await writeFile(
      join(dataDir, "personal", "observations.md"),
      "- 2026-06-10 [a]: line one\r\n- 2026-06-11 [b]: line two\r\n",
    );
    reconciler = new LtmReconciler({ ltm, dataDir, logger: noopLogger });
    const r1 = await reconciler.reconcile();
    expect(r1.replayed).toBe(2);
    expect(r1.errors).toBe(0);
    // Second pass with force (ignore mtime cache): the same lines must dedup,
    // NOT re-replay. This is the bug-was: \r in the segment changed the
    // origin hash so hasObservation() always returned false.
    const r2 = await reconciler.reconcile({ force: true });
    expect(r2.skipped).toBe(2);
    expect(r2.replayed).toBe(0);
    expect(r2.errors).toBe(0);
  });

  it("skips glacier/ and dot-directories during the dataDir walk", async () => {
    // Good: a normal domain observation that SHOULD be picked up.
    await mkdir(join(dataDir, "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "personal", "observations.md"),
      "- 2026-06-10 [a]: should mirror\n",
    );
    // Bad: glacier archives are out of scope. A file under glacier/ named
    // observations.md must be IGNORED. We use a malformed body so that if
    // the walker mistakenly descends, the test fails loudly with errors>0.
    await mkdir(join(dataDir, "glacier", "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "glacier", "personal", "observations.md"),
      "---\ntype: glacier_archive\n---\n# Cold storage\n",
    );
    // Bad: dot-directories (.git, .obsidian) hold no observations and must
    // be skipped. Same loud-fail pattern: malformed content under .git.
    await mkdir(join(dataDir, ".git", "objects"), { recursive: true });
    await writeFile(
      join(dataDir, ".git", "objects", "observations.md"),
      "binary-pack-like garbage\n",
    );
    reconciler = new LtmReconciler({ ltm, dataDir, logger: noopLogger });
    const r = await reconciler.reconcile();
    expect(r.scannedFiles).toBe(1);
    expect(r.replayed).toBe(1);
    expect(r.errors).toBe(0);
  });

  it("health() returns a structurally cloned snapshot that does NOT alias internal state", async () => {
    await mkdir(join(dataDir, "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "personal", "observations.md"),
      "- 2026-06-10 [a]: line one\n",
    );
    reconciler = new LtmReconciler({ ltm, dataDir, logger: noopLogger });
    await reconciler.reconcile();
    const snap = reconciler.health();
    // Mutate the snapshot's nested fields.
    if (snap.lastTickStats) snap.lastTickStats.replayed = 9999;
    if (snap.lastError) snap.lastError.message = "tampered";
    // The reconciler's true state must NOT have absorbed those mutations.
    const fresh = reconciler.health();
    expect(fresh.lastTickStats?.replayed).toBe(1);
    expect(fresh.lastError?.message).not.toBe("tampered");
  });
});
