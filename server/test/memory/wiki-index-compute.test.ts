import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { wikiIndexCompute } from "../../src/memory/index.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ytsejam-wiki-"));
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

describe("wikiIndexCompute", () => {
  test("TestWikiIndexComputeMethod", async () => {
    await seed("wiki/research/honcho/index.md", `---
title: Honcho
summary: Eval as memory layer for Hermes agent; verdict deferred.
updated: 2026-05-19
entity_type: research
status: active
tags: [memory, self-hosting, agents]
related: [wiki/topics/semantic-memory-search, wiki/tools/monet]
---
content
`);
    await seed("wiki/topics/orphan.md", "no frontmatter\n");
    await seed("wiki/index.md", "---\ntitle: Catalog\n---\n");
    await seed("wiki/_meta/registry.md", "---\ntitle: Registry\n---\n");

    const result = await wikiIndexCompute();
    expect(result.count).toBe(2);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toEqual({
      path: "wiki/research/honcho/index.md",
      category: "research",
      title: "Honcho",
      status: "active",
      tags: ["memory", "self-hosting", "agents"],
      summary: "Eval as memory layer for Hermes agent; verdict deferred.",
      updated: "2026-05-19",
      related: ["wiki/topics/semantic-memory-search", "wiki/tools/monet"],
    });
    expect(result.entries[1]).toEqual({ path: "wiki/topics/orphan.md", tags: [] });
    expect(result.entries.map((e) => e.path)).not.toContain("wiki/index.md");
    expect(result.entries.map((e) => e.path)).not.toContain("wiki/_meta/registry.md");
  });

  test("TestWikiIndexComputeRBACFilters is obsolete after RBAC removal", async () => {
    await seed("wiki/projects/a.md", "---\ntitle: A\nentity_type: projects\n---\n");
    await seed("wiki/personal/p.md", "---\ntitle: P\nentity_type: people\n---\n");
    const result = await wikiIndexCompute();
    expect(result.entries.map((e) => e.path)).toEqual(["wiki/personal/p.md", "wiki/projects/a.md"]);
    expect(result.count).toBe(2);
  });

  test("normalizes CRLF frontmatter before parsing", async () => {
    await seed("wiki/topics/crlf.md", "<!-- L0: hi -->\r\n---\r\ntitle: CRLF\r\nsummary: No carriage return\r\n---\r\nbody\r\n");

    const [entry] = (await wikiIndexCompute()).entries;
    expect(entry.summary).toBe("No carriage return");
    expect(entry.summary).not.toContain("\r");
  });

  test("sorts paths byte-wise after scanning", async () => {
    await seed("wiki/topics/alpha.md", "---\ntitle: alpha\n---\n");
    await seed("wiki/topics/Zeta.md", "---\ntitle: Zeta\n---\n");

    const result = await wikiIndexCompute();
    expect(result.entries.map((e) => e.path)).toEqual(["wiki/topics/Zeta.md", "wiki/topics/alpha.md"]);
  });
});
