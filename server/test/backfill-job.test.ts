import { afterEach, describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { BackfillJob } from "../src/memory/bridge/backfill-job.ts";

function makeFakeJsonl(dir: string, sid: string): string {
  const filepath = path.join(dir, `2026-06-10T00-00-00-000Z_${sid}.jsonl`);
  fs.writeFileSync(
    filepath,
    JSON.stringify({
      type: "session",
      version: 3,
      id: sid,
      timestamp: "2026-06-10T00:00:00.000Z",
      cwd: "chat",
    }) + "\n",
  );
  return filepath;
}

describe("BackfillJob", () => {
  const tmpdirs: string[] = [];

  afterEach(() => {
    while (tmpdirs.length)
      fs.rmSync(tmpdirs.pop()!, { recursive: true, force: true });
  });

  it("processes files in order, fires onProgress per file, reports done status", async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-test-"));
    tmpdirs.push(tmpdir);
    for (let i = 0; i < 3; i++)
      makeFakeJsonl(tmpdir, `019eb000-0000-7000-0000-00000000000${i}`);
    const progressLog: number[] = [];
    const fakeLtm = {
      ingestSessionFile: async () => ({
        sessionsSeen: 1,
        turnsIngested: 5,
        recordsCreated: 5,
        warnings: [],
      }),
    };
    const job = new BackfillJob({
      ltm: fakeLtm,
      dir: tmpdir,
      ratePerSec: 1000, // fast for test
      batchSize: 2,
      pauseMs: 0,
      onProgress: (s) => progressLog.push(s.processed),
    });
    await job.run();
    expect(job.status).toBe("done");
    expect(job.processed).toBe(3);
    expect(job.total).toBe(3);
    expect(progressLog).toEqual([1, 2, 3]); // strict order check
    expect(job.warnings).toEqual([]);
  });

  it("honors cancellation between files", async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-cancel-"));
    tmpdirs.push(tmpdir);
    for (let i = 0; i < 10; i++)
      makeFakeJsonl(tmpdir, `019eb000-0000-7000-0000-00000000001${i}`);
    const fakeLtm = {
      ingestSessionFile: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return { sessionsSeen: 1, turnsIngested: 1, recordsCreated: 1, warnings: [] };
      },
    };
    const job = new BackfillJob({
      ltm: fakeLtm,
      dir: tmpdir,
      ratePerSec: 100,
      batchSize: 100,
      pauseMs: 0,
    });
    const runP = job.run();
    setTimeout(() => job.cancel(), 50);
    await runP;
    expect(job.status).toBe("cancelled");
    expect(job.processed).toBeGreaterThanOrEqual(1);
    expect(job.processed).toBeLessThan(10);
  });

  it("aggregates per-file failures into warnings and keeps going", async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-warn-"));
    tmpdirs.push(tmpdir);
    for (let i = 0; i < 3; i++)
      makeFakeJsonl(tmpdir, `019eb000-0000-7000-0000-00000000002${i}`);
    let n = 0;
    const fakeLtm = {
      ingestSessionFile: async () => {
        n++;
        if (n === 2) throw new Error("simulated ingest fail");
        return { sessionsSeen: 1, turnsIngested: 1, recordsCreated: 1, warnings: [] };
      },
    };
    const job = new BackfillJob({
      ltm: fakeLtm,
      dir: tmpdir,
      ratePerSec: 1000,
      batchSize: 100,
      pauseMs: 0,
    });
    await job.run();
    expect(job.status).toBe("done");
    expect(job.processed).toBe(2); // 2 of 3 succeeded
    expect(job.warnings.length).toBe(1);
    expect(job.warnings[0]).toContain("simulated ingest fail");
  });

  it("double-run is a no-op", async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-doublerun-"));
    tmpdirs.push(tmpdir);
    for (let i = 0; i < 2; i++)
      makeFakeJsonl(tmpdir, `019eb000-0000-7000-0000-00000000003${i}`);
    let calls = 0;
    const fakeLtm = {
      ingestSessionFile: async () => {
        calls++;
        return { sessionsSeen: 1, turnsIngested: 1, recordsCreated: 1, warnings: [] };
      },
    };
    const job = new BackfillJob({
      ltm: fakeLtm,
      dir: tmpdir,
      ratePerSec: 1000,
      batchSize: 10,
      pauseMs: 0,
    });
    await job.run();
    expect(job.status).toBe("done");
    expect(job.processed).toBe(2);
    expect(calls).toBe(2);

    // Second run should be a no-op.
    await job.run();
    expect(job.status).toBe("done");
    expect(job.processed).toBe(2);
    expect(calls).toBe(2);
  });

  it("sets failed status when dir doesn't exist", async () => {
    const job = new BackfillJob({
      ltm: {
        ingestSessionFile: async () => ({
          sessionsSeen: 0,
          turnsIngested: 0,
          recordsCreated: 0,
          warnings: [],
        }),
      },
      dir: "/nonexistent/path/should/not/exist",
      ratePerSec: 100,
      batchSize: 10,
      pauseMs: 0,
    });
    await job.run();
    expect(job.status).toBe("failed");
    expect(job.warnings.length).toBeGreaterThan(0);
  });
});
