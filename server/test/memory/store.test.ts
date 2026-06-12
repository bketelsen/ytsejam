import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { append, git, health, list, move, outline, patch, read, search, stats, write } from "../../src/memory/index.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ytsejam-store-"));
  process.env.YTSEJAM_MEMORY_DIR = root;
});
afterEach(async () => {
  delete process.env.YTSEJAM_MEMORY_DIR;
  if (root) await rm(root, { recursive: true, force: true });
});

async function seed(rel: string, content: string) {
  const abs = join(root, ...rel.split("/"));
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
}
async function slurp(rel: string) { return readFile(join(root, ...rel.split("/")), "utf8"); }
async function seedManifest() {
  await seed("domains.yml", `version: 1
domains:
  - id: dakota
    path: projects/dakota
    files: [hot-memory, observations, action-items]
  - id: work
    path: work/microsoft
    files: [hot-memory]
`);
}

const allowedWrites = [
  "projects/dakota/INDEX.md",
  "link-index.md",
  "glacier/index.md",
  "domains.yml",
  "cog-meta/scenario-calibration.md",
  "cog-meta/scenarios/s1.md",
  "cog-meta/reflect-cursor.md",
  "cog-meta/foresight-nudge.md",
  "cog-meta/evolve-log.md",
  "cog-meta/evolve-observations.md",
  "cog-meta/scorecard.md",
];

describe("memory primitive store", () => {
  test("TestRead / TestReadMissing / extraction", async () => {
    await seed("hot-memory.md", "hello world\n");
    expect(await read("hot-memory.md")).toEqual({ content: "hello world\n", found: true });
    expect(await read("nonexistent.md")).toEqual({ content: "", found: false });
    await seed("projects.md", "# Projects\n\n## Backlog\nold\n\n## Active Projects\nalpha\nbeta\n\n## Done\nomega\n");
    expect((await read("projects.md", { section: "## Active Projects" })).content).toBe("## Active Projects\nalpha\nbeta\n");
    await expect(read("projects.md", { section: "## Missing" })).rejects.toThrow(/section not found/);
    await seed("lines.md", "line1\nline2\nline3\nline4\nline5\n");
    expect((await read("lines.md", { start: 2, end: 4 })).content).toBe("line2\nline3\nline4");
    expect((await read("lines.md", { end: 3 })).content).toBe("line1\nline2\nline3");
    expect((await read("lines.md", { start: 5 })).content).toBe("line5");
  });

  test("TestReadL0INDEX and TestReadLIST", async () => {
    await seed("hot-memory.md", "<!-- L0: Current state overview -->\n# Hot Memory\n");
    await seed("sub/other.md", "no l0 here\n");
    expect((await read("L0_INDEX")).content).toContain("hot-memory.md: Current state overview");
    expect((await read("LIST")).content.split("\n")).toEqual(["hot-memory.md", "sub/other.md"]);
  });

  test("write allow-list, overwrite, subdir, id-as-path rejection", async () => {
    await seedManifest();
    await expect(write("dakota/INDEX.md", "# stray\n")).rejects.toThrow(/projects\/dakota/);
    for (const p of allowedWrites) await expect(write(p, "new content\n")).resolves.toEqual({ bytes: 12 });
    expect(await slurp("projects/dakota/INDEX.md")).toBe("new content\n");
    await expect(write("notes.md", "nope\n")).rejects.toThrow(/not allowed/);
    await expect(write("projects/dakota/hot-memory.md", "canonical\n")).rejects.toThrow(/use append or patch/);
    await expect(write("../evil.md", "bad")).rejects.toThrow(/traversal|absolute/);
  });

  test("append EOF, creates file, newline handling, obs enforcement, id-as-path", async () => {
    await seedManifest();
    await seed("log.md", "line1\n");
    await append("log.md", "line2\n");
    expect(await slurp("log.md")).toBe("line1\nline2\n");
    await append("new.md", "hello");
    expect((await read("new.md")).content).toBe("hello\n");
    await seed("noeol.md", "line1");
    await append("noeol.md", "line2");
    expect(await slurp("noeol.md")).toBe("line1\nline2\n");
    await seed("already.md", "line1");
    await append("already.md", "\nline2");
    expect(await slurp("already.md")).toBe("line1\nline2\n");
    await expect(append("domain/observations.md", "- 2025-01-01 [insight]: valid observation\n")).resolves.toEqual({ ok: true });
    await expect(append("observations.md", "- 2025-06-15 [work]: bare path test\n")).resolves.toEqual({ ok: true });
    await expect(append("domain/observations.md", "this is not an observation\n")).rejects.toThrow(/observation format/);
    await expect(append("notes.md", "anything goes here\n")).resolves.toEqual({ ok: true });
    await expect(append("dakota/observations.md", "- 2026-06-10 [test]: stray append\n")).rejects.toThrow(/projects\/dakota/);
  });

  test("append section semantics", async () => {
    await seed("ai.md", "# Title\n\n## Open\n- existing\n\n## Completed\n- done\n");
    await append("ai.md", "- new item", { section: "## Open" });
    expect(await slurp("ai.md")).toBe("# Title\n\n## Open\n- existing\n- new item\n\n## Completed\n- done\n");
    await seed("bare.md", "## Open\n- existing\n\n## Completed\n- done\n");
    await append("bare.md", "- new", { section: "Open" });
    expect(await slurp("bare.md")).toContain("- existing\n- new\n\n## Completed");
    await expect(append("bare.md", "- x", { section: "## Nonexistent" })).rejects.toThrow(/heading not found/);
    await seed("nested.md", "## Open\n- a\n### Sub\n- b\n## Next\n- c\n");
    await append("nested.md", "- new", { section: "## Open" });
    expect(await slurp("nested.md")).toBe("## Open\n- a\n### Sub\n- b\n- new\n\n## Next\n- c\n");
  });

  test("patch exact occurrence", async () => {
    await seed("doc.md", "hello world\n");
    await expect(patch("doc.md", "hello", "goodbye")).resolves.toEqual({ ok: true });
    expect(await slurp("doc.md")).toBe("goodbye world\n");
    await expect(patch("doc.md", "xyz", "abc")).rejects.toThrow(/not found/);
    await seed("ambig.md", "hello hello\n");
    await expect(patch("ambig.md", "hello", "hi")).rejects.toThrow(/2 times/);
  });

  test("outline includes L0 and markdown headings, missing errors", async () => {
    await seed("notes.md", ["<!-- L0: Summary -->", "intro", "# ignored h1", "## Section One", "body", "### Detail", "#### H4", "## Section Two"].join("\n"));
    expect(await outline("notes.md")).toEqual({ entries: [
      { line: 1, text: "Summary", level: 0 },
      { line: 4, text: "Section One", level: 2 },
      { line: 6, text: "Detail", level: 3 },
      { line: 7, text: "H4", level: 4 },
      { line: 8, text: "Section Two", level: 2 },
    ] });
    await expect(outline("missing.md")).rejects.toThrow();
  });

  test("move rename rejects existing/traversal and enforces destination allow-list", async () => {
    await seed("old/path.md", "content\n");
    await expect(move("old/path.md", "new/path.md")).rejects.toThrow(/not allowed/);
    await move("old/path.md", "new/INDEX.md");
    expect(existsSync(join(root, "old/path.md"))).toBe(false);
    expect(await slurp("new/INDEX.md")).toBe("content\n");
    await seed("source.md", "source\n"); await seed("dest/INDEX.md", "dest\n");
    await expect(move("source.md", "dest/INDEX.md")).rejects.toThrow(/destination exists/);
    await expect(move("../source.md", "x/INDEX.md")).rejects.toThrow(/traversal|absolute/);
  });

  test("search/list/stats skip git and sort/filter", async () => {
    await seed("notes.md", "hello world\nfoo bar\n");
    await seed("other.md", "no match here\nHELLO again\n");
    await seed("projects/a.md", "line1\nline2\n");
    await seed("projects/sub/b.md", "alpha\nbeta\ngamma\n");
    await seed(".git/HEAD", "hello git\n");
    expect((await search("hello")).results.map((r) => r.path)).toEqual(["notes.md", "other.md"]);
    expect((await list()).paths).toEqual(["notes.md", "other.md", "projects/a.md", "projects/sub/b.md"]);
    const st = await stats("projects/");
    expect(st.files).toBe(2);
    expect(st.per_file.map((f) => f.path)).toEqual(["projects/a.md", "projects/sub/b.md"]);
    expect(st.lines).toBe(5);
    expect((await stats("project")).files).toBe(0);
    expect((await stats("projects/a.md")).files).toBe(1);
  });

  test("search is case-insensitive literal substring", async () => {
    await seed("notes.md", "Hello World\n");
    const result = await search("hello");
    expect(result.results).toEqual([{ path: "notes.md", line: 1, text: "Hello World" }]);
    expect(result.count).toBe(1);
  });

  test("search matches regex metacharacters literally", async () => {
    await seed("literal.md", "a+b=c\n");
    await seed("regex-match.md", "aaab=c\n");
    const result = await search("a+b");
    expect(result.results.map((r) => r.path)).toEqual(["literal.md"]);
    expect(result.count).toBe(1);
  });

  test("search bracket and paren queries do not throw", async () => {
    await seed("notes.md", "plain text\n");
    await expect(search("[oops")).resolves.toEqual({ results: [], count: 0 });
    await expect(search("(unclosed")).resolves.toEqual({ results: [], count: 0 });
  });

  test("health and git operations", async () => {
    try { execFileSync("git", ["--version"]); } catch { return; }
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    expect(await git({ op: "status" })).toEqual({ output: "" });
    await seed("tracked.md", "one\n");
    expect((await git({ op: "status" })).output).toContain("tracked.md");
    await expect(git({ op: "commit" })).rejects.toThrow(/requires message/);
    expect((await git({ op: "commit", message: "initial" })).output).toContain("initial");
    await seed("tracked.md", "two\n");
    expect((await git({ op: "diff", paths: ["tracked.md"] })).output).toContain("two");
    expect((await git({ op: "log", limit: 1 })).output).toContain("initial");
    const h = await health();
    expect(h.ok).toBe(true); expect(h.memory_root).toBe(root); expect(h.last_commit).toMatch(/[0-9a-f]{7,}/);
    await expect(git({ op: "nope" as never })).rejects.toThrow(/unknown op/);
  });
});
