import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createGitTool } from "../src/tools/git.ts";
import { runArgv } from "../src/tools/shell.ts";

const dir = () => mkdtempSync(join(tmpdir(), "git-tool-"));

async function git(cwd: string, args: string[]) {
  const result = await runArgv("git", args, { cwd, timeoutMs: 5000 });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.output}`);
  }
  return result.output;
}

async function initRepo(): Promise<string> {
  const cwd = dir();
  await git(cwd, ["init", "-b", "main"]);
  await git(cwd, ["config", "user.email", "agent@example.com"]);
  await git(cwd, ["config", "user.name", "Agent Test"]);
  writeFileSync(join(cwd, "file.txt"), "one\n");
  await git(cwd, ["add", "file.txt"]);
  await git(cwd, ["commit", "-m", "initial"]);
  return cwd;
}

function text(result: Awaited<ReturnType<ReturnType<typeof createGitTool>["execute"]>>): string {
  return (result.content[0] as any).text;
}

describe("git tool", () => {
  test("status reports clean and dirty working trees", async () => {
    const cwd = await initRepo();
    const tool = createGitTool(cwd);

    const clean = await tool.execute("t1", { op: "status" });
    expect(text(clean)).toContain("exit code: 0");
    expect(text(clean)).toContain("(clean)");
    expect(clean.details).toMatchObject({ exitCode: 0, op: "status", truncated: false });

    writeFileSync(join(cwd, "file.txt"), "two\n");
    const dirty = await tool.execute("t2", { op: "status" });
    expect(text(dirty)).toContain(" M file.txt");
  });

  test("add and commit create a new commit", async () => {
    const cwd = await initRepo();
    const tool = createGitTool(cwd);
    writeFileSync(join(cwd, "new.txt"), "new\n");

    expect((await tool.execute("t1", { op: "add", path: "new.txt" })).details).toMatchObject({
      exitCode: 0,
      op: "add",
    });
    const commit = await tool.execute("t2", { op: "commit", message: "add new file" });
    expect(commit.details).toMatchObject({ exitCode: 0, op: "commit" });

    const log = await tool.execute("t3", { op: "log", count: 1 });
    expect(text(log)).toContain("add new file");
  });

  test("diff supports unstaged and staged changes", async () => {
    const cwd = await initRepo();
    const tool = createGitTool(cwd);
    writeFileSync(join(cwd, "file.txt"), "one\ntwo\n");

    const unstaged = await tool.execute("t1", { op: "diff", path: "file.txt" });
    expect(text(unstaged)).toContain("+two");

    await tool.execute("t2", { op: "add", path: "file.txt" });
    const staged = await tool.execute("t3", { op: "diff", staged: true, path: "file.txt" });
    expect(text(staged)).toContain("+two");
  });

  test("log count is bounded", async () => {
    const cwd = await initRepo();
    const tool = createGitTool(cwd);

    for (const name of ["a", "b", "c"]) {
      writeFileSync(join(cwd, `${name}.txt`), `${name}\n`);
      await tool.execute(`add-${name}`, { op: "add", path: `${name}.txt` });
      await tool.execute(`commit-${name}`, { op: "commit", message: `add ${name}` });
    }

    const log = await tool.execute("log", { op: "log", count: 2 });
    expect(text(log)).toContain("add c");
    expect(text(log)).toContain("add b");
    expect(text(log)).not.toContain("add a");
  });

  test("branch can create and switch branches", async () => {
    const cwd = await initRepo();
    const tool = createGitTool(cwd);

    const created = await tool.execute("t1", { op: "branch", branchMode: "create", branch: "feature" });
    expect(created.details).toMatchObject({ exitCode: 0, op: "branch" });
    const switched = await tool.execute("t2", { op: "branch", branchMode: "switch", branch: "feature" });
    expect(switched.details).toMatchObject({ exitCode: 0, op: "branch" });

    const list = await tool.execute("t3", { op: "branch", branchMode: "list" });
    expect(text(list)).toContain("* feature");
  });

  test("throws a clear error outside a git repo", async () => {
    const tool = createGitTool(dir());
    await expect(tool.execute("t1", { op: "status" })).rejects.toThrow(/not a git repository/i);
  });

  test("show returns a commit or path", async () => {
    const cwd = await initRepo();
    const tool = createGitTool(cwd);
    const shown = await tool.execute("t1", { op: "show", rev: "HEAD:file.txt" });
    expect(text(shown)).toContain("one");
  });

  test("restore reverts a dirty path", async () => {
    const cwd = await initRepo();
    const tool = createGitTool(cwd);
    writeFileSync(join(cwd, "file.txt"), "changed\n");

    const restored = await tool.execute("t1", { op: "restore", path: "file.txt" });
    expect(restored.details).toMatchObject({ exitCode: 0, op: "restore" });
    expect(readFileSync(join(cwd, "file.txt"), "utf8")).toBe("one\n");
  });

  test("checkout rejects leading-dash branch values and preserves dirty files", async () => {
    const cwd = await initRepo();
    const tool = createGitTool(cwd);
    writeFileSync(join(cwd, "file.txt"), "dirty\n");

    await expect(tool.execute("t1", { op: "checkout", branch: "-f" })).rejects.toThrow(/leading-dash/i);
    expect(readFileSync(join(cwd, "file.txt"), "utf8")).toBe("dirty\n");
  });

  test("show rejects leading-dash rev values", async () => {
    const cwd = await initRepo();
    const tool = createGitTool(cwd);

    await expect(tool.execute("t1", { op: "show", rev: "-s" })).rejects.toThrow(/leading-dash/i);
  });

  test("branch create rejects leading-dash names", async () => {
    const cwd = await initRepo();
    const tool = createGitTool(cwd);

    await expect(
      tool.execute("t1", { op: "branch", branchMode: "create", branch: "--list" }),
    ).rejects.toThrow(/leading-dash/i);
  });

  test("branch switch rejects dash instead of using previous-branch shorthand", async () => {
    const cwd = await initRepo();
    const tool = createGitTool(cwd);
    await tool.execute("create", { op: "branch", branchMode: "create", branch: "feature" });
    await tool.execute("switch-feature", { op: "branch", branchMode: "switch", branch: "feature" });
    await tool.execute("switch-main", { op: "branch", branchMode: "switch", branch: "main" });

    await expect(
      tool.execute("switch-dash", { op: "branch", branchMode: "switch", branch: "-" }),
    ).rejects.toThrow(/leading-dash/i);
    const branches = await tool.execute("list", { op: "branch", branchMode: "list" });
    expect(text(branches)).toContain("* main");
  });
});
