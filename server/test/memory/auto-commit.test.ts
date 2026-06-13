import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { maybeAutoCommit, __resetAutoCommitForTests, AUTO_COMMIT_EVERY } from "../../src/memory/store/auto-commit.ts";
import { ensureRoot } from "../../src/memory/store/paths.ts";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ytsejam-autocommit-"));
  process.env.YTSEJAM_MEMORY_DIR = root;
  __resetAutoCommitForTests();
  await ensureRoot();
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  // Establish an initial commit so HEAD exists.
  await writeFile(join(root, ".gitkeep"), "");
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "root"], { cwd: root });
});

afterEach(async () => {
  delete process.env.YTSEJAM_MEMORY_DIR;
  if (root) await rm(root, { recursive: true, force: true });
});

async function writeFileAt(rel: string, content: string) {
  const abs = join(root, ...rel.split("/"));
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content);
}

function gitLog(): string {
  return execFileSync("git", ["log", "--oneline"], { cwd: root, encoding: "utf8" });
}

describe("memory auto-commit cadence", () => {
  test("AUTO_COMMIT_EVERY default is 10", () => {
    expect(AUTO_COMMIT_EVERY).toBe(10);
  });

  test("first N-1 writes do not produce a commit", async () => {
    for (let i = 0; i < AUTO_COMMIT_EVERY - 1; i++) {
      await writeFileAt(`f${i}.md`, `body ${i}\n`);
      await maybeAutoCommit();
    }
    const log = gitLog().trim().split("\n");
    expect(log).toHaveLength(1); // only the root commit
    expect(log[0]).toContain("root");
  });

  test("the Nth write triggers an auto-commit with the canonical message", async () => {
    for (let i = 0; i < AUTO_COMMIT_EVERY; i++) {
      await writeFileAt(`f${i}.md`, `body ${i}\n`);
      await maybeAutoCommit();
    }
    const log = gitLog().trim().split("\n");
    expect(log).toHaveLength(2);
    expect(log[0]).toMatch(/auto: \d+ memory writes/);
    expect(log[0]).toContain(`auto: ${AUTO_COMMIT_EVERY} memory writes`);
  });

  test("counter resets after a commit — next N-1 writes do not commit again", async () => {
    for (let i = 0; i < AUTO_COMMIT_EVERY; i++) {
      await writeFileAt(`a${i}.md`, "x\n");
      await maybeAutoCommit();
    }
    for (let i = 0; i < AUTO_COMMIT_EVERY - 1; i++) {
      await writeFileAt(`b${i}.md`, "y\n");
      await maybeAutoCommit();
    }
    const log = gitLog().trim().split("\n");
    expect(log).toHaveLength(2); // root + one auto-commit, no second auto-commit yet
  });

  test("startup flush skips when a merge is in progress and warns", async () => {
    await writeFile(join(root, "merge-target.md"), "base\n");
    execFileSync("git", ["add", "merge-target.md"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: root });

    execFileSync("git", ["checkout", "-q", "-b", "side"], { cwd: root });
    await writeFile(join(root, "merge-target.md"), "side change\n");
    execFileSync("git", ["commit", "-q", "-am", "side"], { cwd: root });

    execFileSync("git", ["checkout", "-q", "-"], { cwd: root });
    await writeFile(join(root, "merge-target.md"), "main change\n");
    execFileSync("git", ["commit", "-q", "-am", "main"], { cwd: root });

    try {
      execFileSync("git", ["merge", "side"], { cwd: root, stdio: "ignore" });
    } catch {
      // Expected merge conflict.
    }

    expect(existsSync(join(root, ".git", "MERGE_HEAD"))).toBe(true);
    const headBeforeFlush = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await maybeAutoCommit();

    const headAfterFlush = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    expect(headAfterFlush).toBe(headBeforeFlush);
    expect(existsSync(join(root, ".git", "MERGE_HEAD"))).toBe(true);
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => /git operation in progress/.test(String(c[0])))).toBe(true);
    warn.mockRestore();
  });

  test("concurrent burst of 50 writes produces ~5 auto-commits without losing increments", async () => {
    // Make each auto-commit leave one tracked file dirty so the fixed drain loop
    // can emit multiple real commits. The old `= 0` reset loses the concurrent
    // increments and stops after the first commit.
    await writeFile(join(root, "hook-counter.md"), "base\n");
    execFileSync("git", ["add", "hook-counter.md"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "hook counter"], { cwd: root });
    const commitHook = join(root, ".git", "hooks", "pre-commit");
    await writeFile(commitHook, "#!/bin/sh\nprintf tick >> hook-counter.md\n");
    await chmod(commitHook, 0o755);

    for (let i = 0; i < 50; i++) {
      await writeFileAt(`burst-${i}.md`, `x${i}\n`);
    }

    await Promise.all(Array.from({ length: 50 }, () => maybeAutoCommit()));

    const log = gitLog().trim().split("\n");
    const autoCommits = log.filter((line) => /auto: 10 memory writes/.test(line));
    expect(autoCommits.length).toBeGreaterThanOrEqual(4);

    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
    const dirtyLines = dirty ? dirty.split("\n").length : 0;
    expect(dirtyLines).toBeLessThan(AUTO_COMMIT_EVERY);
  });

  test("write/append/patch hooks: the 10th call across primitives triggers a commit", async () => {
    // Domains.yml so append/patch's rejectIDAsPath has something to read.
    await writeFile(join(root, "domains.yml"), "version: 1\ndomains: []\n");
    const memory = await import("../../src/memory/index.ts");
    // 4 writes (all on allow-listed paths)
    await memory.write("domains.yml", "version: 1\ndomains: []\n");
    await memory.write("link-index.md", "x\n");
    await memory.write("glacier/index.md", "y\n");
    await memory.write("cog-meta/reflect-cursor.md", "z\n");
    // 3 appends (append has no whole-file allow-list; any non-observations path works)
    for (let i = 0; i < 3; i++) {
      await memory.append(`note-${i}.md`, "hello\n");
    }
    // 2 patches (patch has no whole-file allow-list either)
    await memory.patch("note-0.md", "hello", "world");
    await memory.patch("note-1.md", "hello", "world");
    // 9 writes total — no auto-commit yet.
    expect(gitLog().trim().split("\n")).toHaveLength(1);
    // 10th: another append → cadence commit fires.
    await memory.append("note-9.md", "tenth\n");
    const log = gitLog().trim().split("\n");
    expect(log).toHaveLength(2);
    expect(log[0]).toContain("auto: 10 memory writes");
  });

  test("move bumps the counter", async () => {
    await writeFile(join(root, "domains.yml"), "version: 1\ndomains: []\n");
    const memory = await import("../../src/memory/index.ts");
    // 9 appends to put us one short of the threshold.
    for (let i = 0; i < 9; i++) {
      await memory.append(`x-${i}.md`, "x\n");
    }
    expect(gitLog().trim().split("\n")).toHaveLength(1);
    // Seed an allow-listed source DIRECTLY on disk (skip memory.write so
    // the counter stays at 9). INDEX.md is allow-listed for any prefix
    // → we can move between two project INDEX paths.
    await mkdir(join(root, "projects", "foo"), { recursive: true });
    await writeFile(join(root, "projects", "foo", "INDEX.md"), "src\n");
    await memory.move("projects/foo/INDEX.md", "projects/bar/INDEX.md");
    // 10th write → commit fires.
    const log = gitLog().trim().split("\n");
    expect(log).toHaveLength(2);
    expect(log[0]).toContain("auto: 10 memory writes");
  });

  test("failed mutations do NOT bump the counter", async () => {
    // Negative-path coverage: the hook must run AFTER a successful mutation,
    // never before. A rejected write/append/patch/move leaves the counter
    // unchanged so it can't poison the next session's cadence.
    await writeFile(join(root, "domains.yml"), "version: 1\ndomains: []\n");
    const memory = await import("../../src/memory/index.ts");
    // 9 SUCCESSFUL appends to put the counter at 9.
    for (let i = 0; i < 9; i++) {
      await memory.append(`ok-${i}.md`, "ok\n");
    }
    expect(gitLog().trim().split("\n")).toHaveLength(1);

    // write to a non-allow-listed path → should throw, must NOT bump.
    await expect(memory.write("not-allowed.md", "x\n"))
      .rejects.toThrow(/write path not allowed/);

    // append to a path that uses a domain-id as its top-level path → throws.
    await writeFile(join(root, "domains.yml"),
      "version: 1\ndomains:\n  - id: foo\n    path: projects/foo\n");
    await expect(memory.append("foo/things.md", "hello\n"))
      .rejects.toThrow(/domain id used as path/);

    // patch with oldText absent → throws.
    await expect(memory.patch("ok-0.md", "NOT-THERE", "x"))
      .rejects.toThrow(/oldText not found/);

    // move to a non-allow-listed destination → throws.
    await expect(memory.move("ok-1.md", "also-not-allowed.md"))
      .rejects.toThrow(/write path not allowed/);

    // Counter is still at 9 — no commit yet.
    expect(gitLog().trim().split("\n")).toHaveLength(1);

    // 10th SUCCESSFUL write fires the commit, proving the counter is at 9
    // and not 13 (which it would be if failed mutations had bumped it).
    await memory.append("ok-9.md", "ok\n");
    const log = gitLog().trim().split("\n");
    expect(log).toHaveLength(2);
    expect(log[0]).toContain("auto: 10 memory writes");
  });
});
