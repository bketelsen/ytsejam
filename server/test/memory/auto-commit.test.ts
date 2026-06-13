import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
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
});
