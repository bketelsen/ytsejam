import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createApplyPatchTool } from "../src/tools/apply-patch.ts";

const dir = () => mkdtempSync(join(tmpdir(), "apply-patch-"));

function text(r: { content: { type: string; text?: string }[] }): string {
  return (r.content[0] as { text: string }).text;
}

describe("apply_patch tool", () => {
  test("applies a single hunk to one file", async () => {
    const d = dir();
    writeFileSync(join(d, "a.txt"), "line1\nline2\nline3\n");
    const tool = createApplyPatchTool(d);
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      " line1",
      "-line2",
      "+LINE2",
      " line3",
      "*** End Patch",
    ].join("\n");
    const r = await tool.execute("t1", { patch });
    expect(text(r)).toContain("a.txt");
    expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("line1\nLINE2\nline3\n");
  });

  test("applies multiple hunks across multiple files atomically", async () => {
    const d = dir();
    writeFileSync(join(d, "a.txt"), "alpha\nbeta\ngamma\ndelta\n");
    writeFileSync(join(d, "b.txt"), "one\ntwo\n");
    const tool = createApplyPatchTool(d);
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      " alpha",
      "-beta",
      "+BETA",
      "@@",
      " gamma",
      "-delta",
      "+DELTA",
      "*** Update File: b.txt",
      "-one",
      "+ONE",
      " two",
      "*** End Patch",
    ].join("\n");
    await tool.execute("t1", { patch });
    expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("alpha\nBETA\ngamma\nDELTA\n");
    expect(readFileSync(join(d, "b.txt"), "utf8")).toBe("ONE\ntwo\n");
  });

  test("rolls back all files when any hunk fails to apply", async () => {
    const d = dir();
    writeFileSync(join(d, "a.txt"), "keep\nchange\n");
    writeFileSync(join(d, "b.txt"), "untouched\n");
    const tool = createApplyPatchTool(d);
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      " keep",
      "-change",
      "+CHANGED",
      "*** Update File: b.txt",
      "-does-not-exist",
      "+nope",
      "*** End Patch",
    ].join("\n");
    await expect(tool.execute("t1", { patch })).rejects.toThrow(/b\.txt/);
    // Neither file may be modified — atomic rollback.
    expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("keep\nchange\n");
    expect(readFileSync(join(d, "b.txt"), "utf8")).toBe("untouched\n");
  });

  test("errors when context is not found", async () => {
    const d = dir();
    writeFileSync(join(d, "a.txt"), "hello\nworld\n");
    const tool = createApplyPatchTool(d);
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "-not-present",
      "+x",
      "*** End Patch",
    ].join("\n");
    await expect(tool.execute("t1", { patch })).rejects.toThrow(/not found|context/i);
  });

  test("errors when context is ambiguous", async () => {
    const d = dir();
    writeFileSync(join(d, "a.txt"), "dup\ndup\n");
    const tool = createApplyPatchTool(d);
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "-dup",
      "+changed",
      "*** End Patch",
    ].join("\n");
    await expect(tool.execute("t1", { patch })).rejects.toThrow(/ambiguous|occurs/i);
    // No partial write.
    expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("dup\ndup\n");
  });

  test("creates a new file, including parent directories", async () => {
    const d = dir();
    const tool = createApplyPatchTool(d);
    const patch = [
      "*** Begin Patch",
      "*** Add File: nested/dir/new.txt",
      "+first",
      "+second",
      "*** End Patch",
    ].join("\n");
    await tool.execute("t1", { patch });
    expect(readFileSync(join(d, "nested/dir/new.txt"), "utf8")).toBe("first\nsecond\n");
  });

  test("refuses to add a file that already exists", async () => {
    const d = dir();
    writeFileSync(join(d, "exists.txt"), "old\n");
    const tool = createApplyPatchTool(d);
    const patch = [
      "*** Begin Patch",
      "*** Add File: exists.txt",
      "+new",
      "*** End Patch",
    ].join("\n");
    await expect(tool.execute("t1", { patch })).rejects.toThrow(/exists/i);
    expect(readFileSync(join(d, "exists.txt"), "utf8")).toBe("old\n");
  });

  test("deletes a file", async () => {
    const d = dir();
    writeFileSync(join(d, "gone.txt"), "bye\n");
    const tool = createApplyPatchTool(d);
    const patch = [
      "*** Begin Patch",
      "*** Delete File: gone.txt",
      "*** End Patch",
    ].join("\n");
    await tool.execute("t1", { patch });
    expect(existsSync(join(d, "gone.txt"))).toBe(false);
  });

  test("uses @@ heading to disambiguate repeated context", async () => {
    const d = dir();
    writeFileSync(
      join(d, "a.txt"),
      "section one\n  value\nsection two\n  value\n",
    );
    const tool = createApplyPatchTool(d);
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@ section two",
      "-  value",
      "+  CHANGED",
      "*** End Patch",
    ].join("\n");
    await tool.execute("t1", { patch });
    expect(readFileSync(join(d, "a.txt"), "utf8")).toBe(
      "section one\n  value\nsection two\n  CHANGED\n",
    );
  });

  test("rejects a malformed envelope", async () => {
    const d = dir();
    const tool = createApplyPatchTool(d);
    await expect(
      tool.execute("t1", { patch: "Update File: a.txt\n-x\n+y" }),
    ).rejects.toThrow(/Begin Patch|envelope|malformed/i);
  });
});
