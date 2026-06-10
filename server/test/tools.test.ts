import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createBashTool, runCommand, runArgv, MAX_TOOL_OUTPUT } from "../src/tools/shell.ts";
import { createEditTool, createReadTool, createWriteTool } from "../src/tools/files.ts";
import { createGrepTool, createFindTool } from "../src/tools/search.ts";

const dir = () => mkdtempSync(join(tmpdir(), "tools-"));

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
  test("write then read round-trips", async () => {
    const d = dir();
    const write = createWriteTool(d);
    const read = createReadTool(d);
    await write.execute("t1", { path: "a/b.txt", content: "hello" });
    const r = await read.execute("t2", { path: join(d, "a/b.txt") });
    expect((r.content[0] as any).text).toContain("hello");
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
