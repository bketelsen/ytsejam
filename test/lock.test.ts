import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemorySystem } from "../src/api/memory-system.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ltm-lock-"));
}

describe("single-writer lock (PLAN 3.4)", () => {
  it("a second open() of the same store while one is live throws clearly", () => {
    const storeDir = tmpDir();
    const first = MemorySystem.open({ storeDir });
    expect(() => MemorySystem.open({ storeDir })).toThrow(/single-writer/);
    first.close();
  });

  it("after close(), the store can be reopened", () => {
    const storeDir = tmpDir();
    const first = MemorySystem.open({ storeDir });
    first.close();
    const second = MemorySystem.open({ storeDir });
    second.close();
    expect(fs.existsSync(path.join(storeDir, "lock.pid"))).toBe(false);
  });

  it("takes over a stale lock left by a dead process", () => {
    const storeDir = tmpDir();
    // A pid that definitely ran and definitely exited.
    const dead = spawnSync("true").pid!;
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(
      path.join(storeDir, "lock.pid"),
      JSON.stringify({ pid: dead, at: "2026-01-01T00:00:00.000Z" }),
    );
    const mem = MemorySystem.open({ storeDir });
    const lock = JSON.parse(fs.readFileSync(path.join(storeDir, "lock.pid"), "utf8")) as { pid: number };
    expect(lock.pid).toBe(process.pid);
    mem.close();
  });

  it("a lock held by a live foreign process blocks open()", () => {
    const storeDir = tmpDir();
    // A process that is alive for the duration of the test: pid 1.
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, "lock.pid"), JSON.stringify({ pid: 1, at: "2026-01-01T00:00:00.000Z" }));
    expect(() => MemorySystem.open({ storeDir })).toThrow(/locked by live pid 1/);
  });

  it("close() is idempotent", () => {
    const storeDir = tmpDir();
    const mem = MemorySystem.open({ storeDir });
    mem.close();
    mem.close();
    const again = MemorySystem.open({ storeDir });
    again.close();
  });
});
