import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createBashTool, runCommand } from "../src/tools/shell.ts";
import { createEditTool, createReadTool, createWriteTool } from "../src/tools/files.ts";

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
