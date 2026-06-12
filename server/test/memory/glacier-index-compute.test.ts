import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { glacierIndexCompute } from "../../src/memory/index.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ytsejam-glacier-"));
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

describe("glacierIndexCompute", () => {
  test("TestGlacierIndexEmpty", async () => {
    await expect(glacierIndexCompute()).resolves.toEqual({ entries: [], count: 0 });
  });

  test("TestGlacierIndexParsesFrontmatter / TestGlacierIndexComputeMethod", async () => {
    await seed("glacier/projects/action-items-done.md", `<!-- L0: Archived completed project action items 2026-05-18 to 2026-05-22 -->
---
type: action-items-done
domain: projects
date_range: 2026-05-18 to 2026-05-22
entries: 14
summary: Completed v0.14.6 through v0.24.4 sprint items
tags: [housekeeping, milestone]
---
# Projects — Completed Action Items
- [x] one
`);
    await seed("glacier/projects/orphan.md", "no frontmatter here\n");
    await seed("glacier/projects/notes.txt", "ignored");

    const result = await glacierIndexCompute();
    expect(result.count).toBe(2);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toEqual({
      path: "glacier/projects/action-items-done.md",
      type: "action-items-done",
      domain: "projects",
      date_range: "2026-05-18 to 2026-05-22",
      entries: 14,
      summary: "Completed v0.14.6 through v0.24.4 sprint items",
      tags: ["housekeeping", "milestone"],
    });
    expect(result.entries[1]).toEqual({ path: "glacier/projects/orphan.md", tags: [] });
  });

  test("omits entries when frontmatter count is zero", async () => {
    await seed("glacier/zero.md", "---\nentries: 0\n---\nbody\n");

    const [entry] = (await glacierIndexCompute()).entries;
    expect(entry).not.toHaveProperty("entries");
  });

  test("truncates fractional entries like Go int YAML decoding", async () => {
    await seed("glacier/fractional.md", "---\nentries: 3.7\n---\nbody\n");

    const [entry] = (await glacierIndexCompute()).entries;
    expect(entry.entries).toBe(3);
  });

  test("empty frontmatter does not add undefined-valued keys", async () => {
    await seed("glacier/empty.md", "---\n---\nbody\n");

    const [entry] = (await glacierIndexCompute()).entries;
    expect(Object.keys(entry).sort()).toEqual(["path", "tags"]);
  });

  test("TestGlacierIndexSkipsTmp", async () => {
    await seed("glacier/x.md.tmp", "---\ntype: x\n---\n");
    expect(await glacierIndexCompute()).toEqual({ entries: [], count: 0 });
  });

  test("TestGlacierIndexComputeRBACFilters is obsolete after RBAC removal", async () => {
    await seed("glacier/projects/p.md", "---\ndomain: projects\n---\n");
    await seed("glacier/personal/priv.md", "---\ndomain: personal\n---\n");
    const result = await glacierIndexCompute();
    expect(result.entries.map((e) => e.path)).toEqual(["glacier/personal/priv.md", "glacier/projects/p.md"]);
    expect(result.count).toBe(2);
  });
});
