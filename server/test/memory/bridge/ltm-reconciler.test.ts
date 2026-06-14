import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { HashEmbedder, MemorySystem, type Embedder } from "ltm";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LtmReconciler } from "../../../src/memory/bridge/ltm-reconciler.ts";
import { computeOrigin } from "../../../src/memory/bridge/ltm-observer.ts";

// Inject a no-op logger in every test so the reconciler's warn/info chatter
// (malformed-line warnings, tick errors) does not leak into the suite's
// stderr. Tests that care about a specific warn can pass their own logger.
const noopLogger = () => {};

function markerEmbedder(dimension: number, marker: number): Embedder {
  return {
    dimension,
    embed: async () => {
      const v = new Array<number>(dimension).fill(0);
      v[0] = marker;
      return v;
    },
  };
}

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
    await mkdir(join(dataDir, "memory", "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "memory", "personal", "observations.md"),
      "- 2026-06-10 [a]: line one\n- 2026-06-11 [b]: line two\n",
    );
    reconciler = new LtmReconciler({ ltm, dataDir, logger: noopLogger });
    const stats = await reconciler.reconcile();
    expect(stats.replayed).toBe(2);
    expect(stats.scannedLines).toBe(2);
    expect(stats.errors).toBe(0);
  });

  it("skips already-mirrored lines on subsequent reconcile (force ignores mtime cache only)", async () => {
    await mkdir(join(dataDir, "memory", "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "memory", "personal", "observations.md"),
      "- 2026-06-10 [a]: line one\n",
    );
    reconciler = new LtmReconciler({ ltm, dataDir, logger: noopLogger });
    await reconciler.reconcile();
    const second = await reconciler.reconcile({ force: true });
    expect(second.replayed).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it("rebuild re-embeds already-mirrored observations under the current embedder", async () => {
    await mkdir(join(dataDir, "memory", "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "memory", "personal", "observations.md"),
      "- 2026-06-10 [a]: line one\n- 2026-06-11 [b]: line two\n",
    );

    ltm.close();
    ltm = MemorySystem.open({
      storeDir: ltmDir,
      embedder: new HashEmbedder(3),
    });
    reconciler = new LtmReconciler({ ltm, dataDir, logger: noopLogger });
    const initial = await reconciler.reconcile({ force: true });
    expect(initial.replayed).toBe(2);
    expect(ltm.listEpisodic().map((r) => r.embedding?.length)).toEqual([3, 3]);

    await reconciler.stop();
    reconciler = null;
    ltm.close();
    ltm = MemorySystem.open({
      storeDir: ltmDir,
      embedder: markerEmbedder(5, 42),
    });
    reconciler = new LtmReconciler({ ltm, dataDir, logger: noopLogger });

    const rebuilt = await reconciler.reconcile({ rebuild: true });
    expect(rebuilt.rebuilt).toBe(2);
    expect(rebuilt.replayed).toBe(0);
    expect(rebuilt.skipped).toBe(0);
    expect(rebuilt.errors).toBe(0);
    expect(ltm.listEpisodic().map((r) => r.embedding)).toEqual([
      [42, 0, 0, 0, 0],
      [42, 0, 0, 0, 0],
    ]);
  });

  it("rebuild prune tombstones orphan cog-origin observations", async () => {
    const lines = [
      "- 2026-06-10 [a]: prune line one",
      "- 2026-06-11 [b]: prune line two",
      "- 2026-06-12 [c]: prune line three",
    ];
    await mkdir(join(dataDir, "memory", "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "memory", "personal", "observations.md"),
      `${lines.join("\n")}\n`,
    );

    reconciler = new LtmReconciler({ ltm, dataDir, logger: noopLogger });
    const initial = await reconciler.reconcile({ force: true });
    expect(initial.replayed).toBe(3);

    const orphan1 = await ltm.recordObservation({
      text: "orphan observation one",
      timestamp: "2026-06-13T00:00:00.000Z",
      origin: "cog:personal/observations.md#orphan001",
    });
    const orphan2 = await ltm.recordObservation({
      text: "orphan observation two",
      timestamp: "2026-06-13T00:00:01.000Z",
      origin: "cog:personal/observations.md#orphan002",
    });

    const stats = await reconciler.reconcile({ rebuild: true, prune: true });
    expect(stats.rebuilt).toBe(3);
    expect(stats.pruned).toBe(2);
    expect(stats.errors).toBe(0);
    expect(ltm.getRecord(orphan1.id)?.state).toBe("redacted");
    expect(ltm.getRecord(orphan1.id)?.text).toBe("");
    expect(ltm.getRecord(orphan2.id)?.state).toBe("redacted");
    expect(ltm.getRecord(orphan2.id)?.text).toBe("");
  });

  it("ignores prune without rebuild", async () => {
    await mkdir(join(dataDir, "memory", "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "memory", "personal", "observations.md"),
      "- 2026-06-10 [a]: prune guard line\n",
    );
    const orphan = await ltm.recordObservation({
      text: "orphan remains without rebuild",
      timestamp: "2026-06-13T00:00:00.000Z",
      origin: "cog:personal/observations.md#guard-orphan",
    });
    const logger = vi.fn();
    reconciler = new LtmReconciler({ ltm, dataDir, logger });

    const stats = await reconciler.reconcile({ prune: true });
    expect(stats.pruned).toBe(0);
    expect(ltm.getRecord(orphan.id)?.state).toBe("active");
    expect(logger).toHaveBeenCalledWith(
      "warn",
      "--prune requires --rebuild; ignoring prune",
    );
  });

  it("force preserves already-mirrored observations without re-embedding", async () => {
    await mkdir(join(dataDir, "memory", "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "memory", "personal", "observations.md"),
      "- 2026-06-10 [a]: line one\n- 2026-06-11 [b]: line two\n",
    );

    ltm.close();
    ltm = MemorySystem.open({
      storeDir: ltmDir,
      embedder: new HashEmbedder(3),
    });
    reconciler = new LtmReconciler({ ltm, dataDir, logger: noopLogger });
    await reconciler.reconcile({ force: true });

    await reconciler.stop();
    reconciler = null;
    ltm.close();
    ltm = MemorySystem.open({
      storeDir: ltmDir,
      embedder: markerEmbedder(5, 42),
    });
    reconciler = new LtmReconciler({ ltm, dataDir, logger: noopLogger });

    const forced = await reconciler.reconcile({ force: true });
    expect(forced.skipped).toBe(2);
    expect(forced.rebuilt).toBe(0);
    expect(forced.replayed).toBe(0);
    expect(forced.errors).toBe(0);
    expect(ltm.listEpisodic().map((r) => r.embedding?.length)).toEqual([3, 3]);
  });

  it("skips unchanged files via mtime cache when not forced", async () => {
    await mkdir(join(dataDir, "memory", "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "memory", "personal", "observations.md"),
      "- 2026-06-10 [a]: line one\n",
    );
    reconciler = new LtmReconciler({ ltm, dataDir, logger: noopLogger });
    await reconciler.reconcile();
    const cached = await reconciler.reconcile();
    expect(cached.scannedFiles).toBe(0);
    expect(cached.scannedLines).toBe(0);
  });

  it("--force re-walks even unchanged files", async () => {
    await mkdir(join(dataDir, "memory", "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "memory", "personal", "observations.md"),
      "- 2026-06-10 [a]: line one\n",
    );
    reconciler = new LtmReconciler({ ltm, dataDir, logger: noopLogger });
    await reconciler.reconcile();
    const forced = await reconciler.reconcile({ force: true });
    expect(forced.scannedFiles).toBe(1);
    expect(forced.skipped).toBe(1);
  });

  it("isolates per-line errors (malformed line doesn't stop the rest)", async () => {
    await mkdir(join(dataDir, "memory", "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "memory", "personal", "observations.md"),
      "- 2026-06-10 [a]: good\n- not-a-date [bad]: malformed\n- 2026-06-11 [b]: also good\n",
    );
    reconciler = new LtmReconciler({ ltm, dataDir, logger: noopLogger });
    const stats = await reconciler.reconcile();
    expect(stats.replayed).toBe(2);
    expect(stats.errors).toBe(1);
  });

  it("walks nested domain paths (e.g. projects/ytsejam/observations.md)", async () => {
    await mkdir(join(dataDir, "memory", "projects", "ytsejam"), {
      recursive: true,
    });
    await writeFile(
      join(dataDir, "memory", "projects", "ytsejam", "observations.md"),
      "- 2026-06-13 [shipped]: bridge 1\n",
    );
    reconciler = new LtmReconciler({ ltm, dataDir, logger: noopLogger });
    const stats = await reconciler.reconcile();
    expect(stats.replayed).toBe(1);
    expect(stats.errors).toBe(0);
  });

  it("writes origin matching the cog domain path, not the data-dir relative path", async () => {
    const line = "- 2026-06-13 [tag1,tag2]: test text";
    await mkdir(join(dataDir, "memory", "cog-meta"), { recursive: true });
    await writeFile(
      join(dataDir, "memory", "cog-meta", "observations.md"),
      `${line}\n`,
    );

    reconciler = new LtmReconciler({ ltm, dataDir, logger: noopLogger });
    const stats = await reconciler.reconcile();

    const expectedOrigin = computeOrigin("cog-meta", "observations.md", line);
    const badOrigin = computeOrigin("memory/cog-meta", "observations.md", line);
    expect(stats.replayed).toBe(1);
    expect(stats.errors).toBe(0);
    expect(ltm.hasObservation(expectedOrigin)).toBe(true);
    expect(ltm.hasObservation(badOrigin)).toBe(false);
    expect(expectedOrigin).toMatch(
      /^cog:cog-meta\/observations\.md#[0-9a-f]{12}$/,
    );
  });

  it("start()/stop() timer lifecycle is idempotent and safe", async () => {
    // start() now kicks an immediate tick. Give it a valid (empty) memory
    // root so that first tick succeeds and reachable stays true; without
    // this, the immediate tick would fail readdir and flip reachable=false.
    await mkdir(join(dataDir, "memory"), { recursive: true });
    reconciler = new LtmReconciler({
      ltm,
      dataDir,
      intervalMs: 1000,
      logger: noopLogger,
    });
    await reconciler.stop(); // before start
    reconciler.start();
    reconciler.start(); // second call must not stack
    await reconciler.stop(); // waits for inFlight immediate tick
    expect(reconciler.health().reachable).toBe(true);
    const stats = await reconciler.reconcile();
    expect(stats.scannedFiles).toBeGreaterThanOrEqual(0);
  });

  it("start() kicks an immediate first tick (no waiting for intervalMs)", async () => {
    // Cold-restart UX: a freshly-armed reconciler must back-fill within
    // microtasks, not after intervalMs. Use a 60-second intervalMs and
    // assert reconcile() is called once shortly after start() returns,
    // with no second call before the interval elapses. We never actually
    // wait the 60s -- the test asserts the call happens FAR earlier than
    // the scheduled tick would.
    await mkdir(join(dataDir, "memory", "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "memory", "personal", "observations.md"),
      "- 2026-06-13 [boot]: should mirror immediately\n",
    );
    reconciler = new LtmReconciler({
      ltm,
      dataDir,
      intervalMs: 60_000,
      logger: noopLogger,
    });
    const spy = vi.spyOn(reconciler, "reconcile");
    const tStart = Date.now();
    reconciler.start();
    // Capture the spy's first invocation promise and await it directly so
    // the immediate tick's reconcile() fully completes (inFlight cleared).
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1), {
      timeout: 1000,
    });
    const firstResult = spy.mock.results[0]?.value as
      | Promise<unknown>
      | undefined;
    if (firstResult) await firstResult;
    const elapsedAfterFirst = Date.now() - tStart;
    // The immediate tick must have happened FAR before the 60s interval.
    expect(elapsedAfterFirst).toBeLessThan(5_000);
    expect(spy).toHaveBeenCalledTimes(1);
    // Wait 200ms of real time -- nowhere near the 60s interval, so no new
    // scheduled tick should have fired. Catches the regression where someone
    // misuses setInterval (e.g. fires immediately AND on schedule from t=0).
    await new Promise((r) => setTimeout(r, 200));
    expect(spy).toHaveBeenCalledTimes(1);
    // Mirror landed?
    expect(spy.mock.results[0]?.value).toBeDefined();
  });

  it("health: per-line LTM failure surfaces as stats.errors but does NOT bump consecutiveFailures", async () => {
    await mkdir(join(dataDir, "memory", "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "memory", "personal", "observations.md"),
      "- 2026-06-10 [a]: line one\n",
    );
    const fakeLtm = {
      hasObservation: () => false,
      recordObservation: vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValue(undefined),
    } as unknown as MemorySystem;
    reconciler = new LtmReconciler({
      ltm: fakeLtm,
      dataDir,
      logger: noopLogger,
    });
    const r1 = await reconciler.reconcile();
    expect(r1.errors).toBe(1);
    expect(reconciler.health().consecutiveFailures).toBe(0); // per-LINE error, not per-TICK
  });

  it("health: tick-level throw (bad dataDir) increments consecutiveFailures", async () => {
    reconciler = new LtmReconciler({
      ltm,
      dataDir: "/nonexistent-path-xyz-12345",
      logger: noopLogger,
    });
    const r1 = await reconciler.reconcile();
    expect(r1.errors).toBeGreaterThanOrEqual(1);
    expect(reconciler.health().consecutiveFailures).toBe(1);
    const r2 = await reconciler.reconcile();
    expect(reconciler.health().consecutiveFailures).toBe(2);
  });

  it("health: a successful tick clears consecutiveFailures", async () => {
    // First tick: bad dataDir → consecutiveFailures = 1.
    reconciler = new LtmReconciler({
      ltm,
      dataDir: "/nonexistent-path-xyz-67890",
      logger: noopLogger,
    });
    await reconciler.reconcile();
    expect(reconciler.health().consecutiveFailures).toBe(1);
    // Now: stop, swap to good dataDir, tick — failures should clear.
    await reconciler.stop();
    reconciler = new LtmReconciler({ ltm, dataDir, logger: noopLogger });
    // Empty good memory tree scan = 0 files, 0 errors → success tick.
    await mkdir(join(dataDir, "memory"), { recursive: true });
    const r = await reconciler.reconcile();
    expect(r.errors).toBe(0);
    expect(reconciler.health().consecutiveFailures).toBe(0);
    expect(reconciler.health().reachable).toBe(true);
  });

  it("CRLF lines dedup against the clean live-path origin (no permanent re-replay)", async () => {
    await mkdir(join(dataDir, "memory", "personal"), { recursive: true });
    // Write file with CRLF line endings -- the exact pathology from external
    // editors / `git checkout` with core.autocrlf=true.
    await writeFile(
      join(dataDir, "memory", "personal", "observations.md"),
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
    await mkdir(join(dataDir, "memory", "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "memory", "personal", "observations.md"),
      "- 2026-06-10 [a]: should mirror\n",
    );
    // Bad: glacier archives are out of scope. A file under glacier/ named
    // observations.md must be IGNORED. We use a malformed body so that if
    // the walker mistakenly descends, the test fails loudly with errors>0.
    await mkdir(join(dataDir, "memory", "glacier", "personal"), {
      recursive: true,
    });
    await writeFile(
      join(dataDir, "memory", "glacier", "personal", "observations.md"),
      "---\ntype: glacier_archive\n---\n# Cold storage\n",
    );
    // Bad: dot-directories (.git, .obsidian) hold no observations and must
    // be skipped. Same loud-fail pattern: malformed content under .git.
    await mkdir(join(dataDir, "memory", ".git", "objects"), {
      recursive: true,
    });
    await writeFile(
      join(dataDir, "memory", ".git", "objects", "observations.md"),
      "binary-pack-like garbage\n",
    );
    reconciler = new LtmReconciler({ ltm, dataDir, logger: noopLogger });
    const r = await reconciler.reconcile();
    expect(r.scannedFiles).toBe(1);
    expect(r.replayed).toBe(1);
    expect(r.errors).toBe(0);
  });

  it("health() returns a structurally cloned snapshot that does NOT alias internal state", async () => {
    await mkdir(join(dataDir, "memory", "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "memory", "personal", "observations.md"),
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

  it("emits exactly one INFO 'tick complete' summary per reconcile() with all seven numeric fields", async () => {
    // Mix a good line and a malformed line so we can also assert that the
    // per-line WARN path (separate issue #100) is still emitted alongside
    // the new INFO rollup -- the summary line is additive, not a replacement.
    // The malformed line must LOOK like an observation (leading `- `) so
    // that it reaches processLine post-#100 fix (lines that don't even look
    // like list items are now silently skipped to match the read-side parser).
    await mkdir(join(dataDir, "memory", "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "memory", "personal", "observations.md"),
      "- 2026-06-10 [a]: good line\n- not-a-date [bad]: malformed\n",
    );
    const logger = vi.fn();
    reconciler = new LtmReconciler({ ltm, dataDir, logger });
    await reconciler.reconcile();

    const infoCalls = logger.mock.calls.filter(
      (c) => c[0] === "info" && c[1] === "tick complete",
    );
    expect(infoCalls).toHaveLength(1);
    const meta = infoCalls[0]![2] as Record<string, unknown>;
    expect(typeof meta.scannedFiles).toBe("number");
    expect(typeof meta.scannedLines).toBe("number");
    expect(typeof meta.replayed).toBe("number");
    expect(typeof meta.rebuilt).toBe("number");
    expect(typeof meta.pruned).toBe("number");
    expect(typeof meta.skipped).toBe("number");
    expect(typeof meta.errors).toBe("number");

    // The per-line malformed-line WARN must still fire -- this fix is the
    // rollup line, NOT a replacement for the detail line (#100's scope).
    const warnCalls = logger.mock.calls.filter(
      (c) => c[0] === "warn" && c[1] === "malformed line skipped",
    );
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ---- issue #100 regression: markdown-noise classification ---------------

  it("silently skips markdown noise (HTML comments, headings, archive markers)", async () => {
    // The exact noise classes that flooded the journal pre-fix: L0 header
    // comment, section heading, blank line, archive-marker comment. Only
    // the trailing list item is a real observation.
    await mkdir(join(dataDir, "memory", "work"), { recursive: true });
    await writeFile(
      join(dataDir, "memory", "work", "observations.md"),
      [
        "<!-- L0: Timestamped work observations -->",
        "# Work — Observations",
        "",
        "<!-- 8 entries archived 2026-06-13 -> glacier/work/observations-foo.md -->",
        "",
        "- 2026-06-13 [test]: the only real observation",
        "",
      ].join("\n"),
    );
    const logger = vi.fn();
    reconciler = new LtmReconciler({ ltm, dataDir, logger });
    const stats = await reconciler.reconcile();

    // Acceptance #1: zero malformed-line warnings against a noise-heavy file.
    const malformedWarns = logger.mock.calls.filter(
      (c) => c[0] === "warn" && c[1] === "malformed line skipped",
    );
    expect(malformedWarns).toEqual([]);

    // Acceptance: scannedLines counts only lines that survived the noise
    // filter AND looked like a list item -- exactly one here.
    expect(stats.scannedLines).toBe(1);
    expect(stats.replayed).toBe(1);
    expect(stats.errors).toBe(0);
  });

  it("still warns on lines that look like observations but don't parse", async () => {
    // A line shaped like an observation (`- ` prefix) but with a bogus date
    // is the boundary case the fix must NOT silence -- both
    // parseObservationLine implementations validate calendar dates via
    // new Date() round-trip, so "not-a-date" is rejected as malformed.
    await mkdir(join(dataDir, "memory", "work"), { recursive: true });
    await writeFile(
      join(dataDir, "memory", "work", "observations.md"),
      [
        "<!-- L0: Timestamped work observations -->",
        "# Work — Observations",
        "",
        "- not-a-date [bad]: this looks like an observation but the date is invalid",
        "- 2026-06-13 [good]: this one is valid",
      ].join("\n"),
    );
    const logger = vi.fn();
    reconciler = new LtmReconciler({ ltm, dataDir, logger });
    const stats = await reconciler.reconcile();

    // Exactly one malformed-line WARN for the bad-date line, no false
    // positives on the comment or the heading.
    const malformedWarns = logger.mock.calls.filter(
      (c) => c[0] === "warn" && c[1] === "malformed line skipped",
    );
    expect(malformedWarns).toHaveLength(1);
    const meta = malformedWarns[0]![2] as { file: string; line: number };
    expect(meta.file).toBe("work/observations.md");
    expect(meta.line).toBe(4); // 1-based line number of the bad-date line

    // Both `- …` lines reach processLine; the good one is replayed and the
    // bad one is counted as an error. Noise lines do NOT contribute to
    // scannedLines.
    expect(stats.scannedLines).toBe(2);
    expect(stats.replayed).toBe(1);
    expect(stats.errors).toBe(1);
  });

  describe("lastError path sanitization (issue #118)", () => {
    it("replaces the absolute dataDir with <data> in lastError.message on a real ENOENT", async () => {
      // Don't create <dataDir>/memory at all. findObservationFiles() will throw
      // ENOENT scandir '<dataDir>/memory' — the exact error class the issue cites.
      reconciler = new LtmReconciler({ ltm, dataDir, logger: noopLogger });
      const stats = await reconciler.reconcile();

      expect(stats.errors).toBe(1);
      const snap = reconciler.health();
      expect(snap.lastError).toBeDefined();
      const msg = snap.lastError!.message;
      // The sanitized token must be present...
      expect(msg).toContain("<data>");
      // ...and the absolute dataDir must NOT leak through.
      expect(msg).not.toContain(dataDir);
      // Belt-and-suspenders: the relativized path tail (memory/) survives the
      // sanitization — only the prefix was scrubbed, not the whole path.
      expect(msg).toContain("memory");
    });

    it("replaces EVERY occurrence of dataDir (not just the first)", async () => {
      // Synthesize an error whose message mentions dataDir twice and feed it
      // through the same bumpTickError path used by reconcile()'s catch
      // sites. We hit bumpTickError via the public reconcile() entry by
      // pre-mocking findObservationFiles to throw our crafted error.
      reconciler = new LtmReconciler({ ltm, dataDir, logger: noopLogger });
      const crafted = new Error(
        `ENOENT scandir '${dataDir}/memory' (was looking under ${dataDir}/memory)`,
      );
      // @ts-expect-error -- private member access in a test for an internal
      // throw-path; the alternative (chmod 000 the real dir) is fragile in
      // CI and root-bypassed locally.
      reconciler.findObservationFiles = async () => {
        throw crafted;
      };
      await reconciler.reconcile();

      const msg = reconciler.health().lastError!.message;
      expect(msg).not.toContain(dataDir);
      // Token appears twice — once per original mention.
      expect((msg.match(/<data>/g) || []).length).toBe(2);
    });
  });
});
