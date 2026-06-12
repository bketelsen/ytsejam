import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { l0index } from "../../src/memory/index.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ytsejam-l0-"));
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

describe("l0index", () => {
  test("TestL0Index", async () => {
    await seed("hot-memory.md", "<!-- L0: Current overview -->\n# Hot Memory\n");
    await seed("projects/hot-memory.md", "<!-- L0: Projects overview -->\n# Projects\n");
    await seed("work/hot-memory.md", "<!-- L0: Work overview -->\n# Work\n");
    await seed("no-l0.md", "# No L0 header\n");

    const result = (await l0index()).index;
    expect(result).toContain("Current overview");
    expect(result).toContain("projects/hot-memory.md: Projects overview");
    expect(result).toContain("work/hot-memory.md: Work overview");
    expect(result).not.toContain("no-l0.md");
  });

  test("TestL0IndexFiltersByDomain", async () => {
    await seed("hot-memory.md", "<!-- L0: Root overview -->\n# Hot Memory\n");
    await seed("projects/hot-memory.md", "<!-- L0: Projects overview -->\n# Projects\n");
    await seed("projects/cogmemory/hot-memory.md", "<!-- L0: Cogmemory overview -->\n# Cogmemory\n");
    await seed("work/hot-memory.md", "<!-- L0: Work overview -->\n# Work\n");

    const result = (await l0index({ domain: "projects" })).index;
    for (const line of result.split("\n")) if (line) expect(line.startsWith("projects/")).toBe(true);
    expect(result).toContain("projects/hot-memory.md: Projects overview");
    expect(result).toContain("projects/cogmemory/hot-memory.md: Cogmemory overview");
    expect(result).not.toContain("work/hot-memory.md");
  });

  test("TestL0IndexMissingDomainReturnsEmpty", async () => {
    await seed("projects/hot-memory.md", "<!-- L0: Projects overview -->\n# Projects\n");
    expect(await l0index({ domain: "nonexistent" })).toEqual({ index: "" });
  });

  test("strict params rejects unknown keys", async () => {
    await expect(l0index({ domain: "projects", by_domain: "projects" } as any)).rejects.toThrow(/unknown key.*by_domain/);
  });
});
