import { execFileSync } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemorySystem } from "ltm";
import {
  attachLtm,
  recordObservation,
} from "../../src/memory/index.ts";

let memRoot = "";
let ltmDir = "";

async function setupMemRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ytsejam-recobs-"));
  process.env.YTSEJAM_MEMORY_DIR = root;
  // git init so auto-commit doesn't crash
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "root"], { cwd: root });
  return root;
}

beforeEach(async () => {
  memRoot = await setupMemRoot();
  ltmDir = await mkdtemp(join(tmpdir(), "ltm-recobs-"));
});

afterEach(async () => {
  attachLtm(null);
  delete process.env.YTSEJAM_MEMORY_DIR;
  if (memRoot) await rm(memRoot, { recursive: true, force: true });
  if (ltmDir) await rm(ltmDir, { recursive: true, force: true });
});

describe("memory.recordObservation", () => {
  it("appends the formatted line to <domain>/observations.md and mirrors to LTM", async () => {
    const ltm = MemorySystem.open({ storeDir: ltmDir });
    attachLtm(ltm);
    try {
      const r = await recordObservation({
        domainPath: "personal",
        text: "feeling great",
        tags: ["mood"],
        timestamp: new Date("2026-06-13T12:00:00Z"),
      });
      expect(r.cog).toEqual({ ok: true, line: "- 2026-06-13 [mood]: feeling great" });
      expect(r.ltm).toEqual({ ok: true });
      const file = await readFile(join(memRoot, "personal", "observations.md"), "utf8");
      expect(file).toContain("- 2026-06-13 [mood]: feeling great");
    } finally {
      ltm.close();
    }
  });

  it("rejects untagged observations (tags mandatory per cog SSOT)", async () => {
    await expect(
      recordObservation({ domainPath: "personal", text: "needs tags" } as unknown as Parameters<typeof recordObservation>[0]),
    ).rejects.toThrow(/tags are mandatory/);
  });

  it("rejects empty tags array (tags mandatory per cog SSOT)", async () => {
    await expect(
      recordObservation({ domainPath: "personal", text: "needs tags", tags: [] }),
    ).rejects.toThrow(/tags are mandatory/);
  });

  it("defaults timestamp to now when omitted", async () => {
    const ltm = MemorySystem.open({ storeDir: ltmDir });
    attachLtm(ltm);
    try {
      const today = new Date().toISOString().slice(0, 10);
      await recordObservation({
        domainPath: "personal",
        text: "now-ish",
        tags: ["time"],
      });
      const file = await readFile(join(memRoot, "personal", "observations.md"), "utf8");
      expect(file).toContain(`- ${today} [time]: now-ish`);
    } finally {
      ltm.close();
    }
  });

  it("cog write succeeds even when LTM throws", async () => {
    const fakeLtm = {
      recordObservation: async () => {
        throw new Error("ltm exploded");
      },
    } as unknown as MemorySystem;
    attachLtm(fakeLtm);
    const r = await recordObservation({
      domainPath: "personal",
      text: "still gets written",
      tags: ["resilience"],
    });
    expect(r.cog.ok).toBe(true);
    expect(r.ltm.ok).toBe(false);
    if (!r.ltm.ok) {
      expect(r.ltm.error).toBeInstanceOf(Error);
      expect(r.ltm.error.message).toBe("ltm exploded");
    }
    const file = await readFile(join(memRoot, "personal", "observations.md"), "utf8");
    expect(file).toContain("still gets written");
  });

  it("works without attachLtm (cog-only mode)", async () => {
    const r = await recordObservation({
      domainPath: "personal",
      text: "cog only",
      tags: ["cog"],
    });
    expect(r.cog.ok).toBe(true);
    expect(r.ltm).toEqual({ ok: true, skipped: "ltm-not-attached" });
  });
});
