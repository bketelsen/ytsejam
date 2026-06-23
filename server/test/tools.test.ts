import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createBashTool, runCommand, runArgv, MAX_TOOL_OUTPUT } from "../src/tools/shell.ts";
import { createEditTool, createReadTool, createWriteTool } from "../src/tools/files.ts";
import { createGrepTool, createFindTool } from "../src/tools/search.ts";

const dir = () => mkdtempSync(join(tmpdir(), "tools-"));

async function withSandboxEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.YTSEJAM_SANDBOX;
  if (value === undefined) delete process.env.YTSEJAM_SANDBOX;
  else process.env.YTSEJAM_SANDBOX = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.YTSEJAM_SANDBOX;
    else process.env.YTSEJAM_SANDBOX = prev;
  }
}

describe("bash tool", () => {
  test("captures stdout+stderr and exit code", async () => {
    const result = await runCommand("echo out; echo err >&2; exit 3", { cwd: dir(), timeoutMs: 5000 });
    expect(result.output).toContain("out");
    expect(result.output).toContain("err");
    expect(result.exitCode).toBe(3);
  });

  test("kills on timeout", async () => {
    const result = await runCommand("sleep 10", { cwd: dir(), timeoutMs: 200 });
    expect(result.output).toContain("[timed out");
  });

  test("tool wrapper returns text content", async () => {
    const tool = createBashTool(dir());
    const r = await tool.execute("t1", { command: "echo hi" });
    expect(r.content[0]).toMatchObject({ type: "text" });
    expect((r.content[0] as any).text).toContain("hi");
  });
});

describe("search tools", () => {
  test("grep finds matches and does not execute shell metacharacters", async () => {
    const d = dir();
    writeFileSync(join(d, "data.txt"), "price: $5\nother line");
    const grep = createGrepTool(d);
    const r = await grep.execute("t1", { pattern: "\\$5", path: d });
    expect((r.content[0] as any).text).toContain("price: $5");

    const marker = join(d, "PWNED");
    await grep.execute("t2", { pattern: `$(touch ${marker})`, path: d });
    expect(existsSync(marker)).toBe(false);
  });

  test("find matches globs without shell expansion", async () => {
    const d = dir();
    writeFileSync(join(d, "a.md"), "");
    writeFileSync(join(d, "b.txt"), "");
    const find = createFindTool(d);
    const r = await find.execute("t1", { namePattern: "*.md", path: d });
    const text = (r.content[0] as any).text;
    expect(text).toContain("a.md");
    expect(text).not.toContain("b.txt");
  });

  test("grep rejects path arguments outside the workspace", async () => {
    await withSandboxEnv(undefined, async () => {
      const d = dir();
      const outside = dir();
      writeFileSync(join(outside, "secret.txt"), "needle\n");
      const grep = createGrepTool(d);

      await expect(
        grep.execute("t1", { pattern: "needle", path: outside }),
      ).rejects.toThrow(/outside the workspace.*tools-/i);
    });
  });

  test("runArgv output is capped at MAX_TOOL_OUTPUT", async () => {
    const d = dir();
    const result = await runCommand(
      "head -c 200000 /dev/zero | tr '\\0' 'a'",
      { cwd: d, timeoutMs: 5000 },
    );
    expect(result.output.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT + 100);
  });
});

describe("file tools", () => {
  test("relative and absolute paths inside the workspace round-trip", async () => {
    const d = dir();
    const write = createWriteTool(d);
    const read = createReadTool(d);
    const edit = createEditTool(d);
    await write.execute("t1", { path: "a/b.txt", content: "hello" });
    await edit.execute("t2", { path: "a/b.txt", oldText: "hello", newText: "hello inside" });
    const r = await read.execute("t2", { path: join(d, "a/b.txt") });
    expect((r.content[0] as any).text).toContain("hello inside");
  });

  test("rejects relative traversal outside the workspace", async () => {
    await withSandboxEnv(undefined, async () => {
      const parent = dir();
      const d = join(parent, "workspace");
      mkdirSync(d);
      const write = createWriteTool(d);

      await expect(
        write.execute("t1", { path: "../escape.txt", content: "nope" }),
      ).rejects.toThrow(/outside the workspace.*escape\.txt/i);
      expect(existsSync(join(parent, "escape.txt"))).toBe(false);
    });
  });

  test("rejects absolute paths outside the workspace", async () => {
    await withSandboxEnv(undefined, async () => {
      const d = dir();
      const outside = dir();
      const target = join(outside, "secret.txt");
      writeFileSync(target, "secret\n");
      const read = createReadTool(d);

      await expect(read.execute("t1", { path: target })).rejects.toThrow(
        /outside the workspace.*secret\.txt/i,
      );
    });
  });

  test("rejects symlink paths that resolve outside the workspace", async () => {
    await withSandboxEnv(undefined, async () => {
      const d = dir();
      const outside = dir();
      writeFileSync(join(outside, "secret.txt"), "secret\n");
      symlinkSync(outside, join(d, "outside-link"));
      const read = createReadTool(d);

      await expect(read.execute("t1", { path: "outside-link/secret.txt" })).rejects.toThrow(
        /outside the workspace.*outside-link/,
      );
    });
  });

  test("YTSEJAM_SANDBOX=0 restores permissive path resolution", async () => {
    await withSandboxEnv("0", async () => {
      const d = dir();
      const outside = dir();
      const target = join(outside, "secret.txt");
      writeFileSync(target, "secret\n");
      const read = createReadTool(d);

      const r = await read.execute("t1", { path: target });
      expect((r.content[0] as any).text).toContain("secret");
    });
  });

  test("edit replaces a unique occurrence and rejects ambiguous ones", async () => {
    const d = dir();
    writeFileSync(join(d, "f.txt"), "one two two");
    const edit = createEditTool(d);
    await edit.execute("t1", { path: join(d, "f.txt"), oldText: "one", newText: "ONE" });
    expect(readFileSync(join(d, "f.txt"), "utf8")).toBe("ONE two two");
    await expect(
      edit.execute("t2", { path: join(d, "f.txt"), oldText: "two", newText: "TWO" }),
    ).rejects.toThrow(/2 times/);
  });
});
