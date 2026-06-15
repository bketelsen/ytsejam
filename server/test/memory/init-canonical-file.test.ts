import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { initCanonicalFile } from "../../src/memory/index.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ytsejam-init-canonical-"));
  process.env.YTSEJAM_MEMORY_DIR = root;
  await writeFile(join(root, "domains.yml"), `version: 1
domains:
  - id: intuneme
    path: projects/intuneme
    label: "intuneme — test"
    files: [hot-memory, observations, action-items, dev-log, decisions]
`, "utf8");
});
afterEach(async () => {
  delete process.env.YTSEJAM_MEMORY_DIR;
  if (root) await rm(root, { recursive: true, force: true });
});

describe("init_canonical_file", () => {
  test("creates hot-memory with standard template", async () => {
    const result = await initCanonicalFile({
      path: "projects/intuneme/hot-memory.md",
      file_type: "hot-memory",
      label: "intuneme",
    });
    expect(result.created).toBe(true);
    expect(result.path).toBe("projects/intuneme/hot-memory.md");
    expect(result.bytes).toBeGreaterThan(0);
    const content = await readFile(join(root, "projects/intuneme/hot-memory.md"), "utf8");
    expect(content).toContain("<!-- L0: Current state and top-of-mind for intuneme -->");
    expect(content).toContain("# intuneme — Hot Memory");
    expect(content).toContain("<!-- Rewrite freely. Keep under 50 lines. -->");
  });

  test("creates observations with standard template", async () => {
    const result = await initCanonicalFile({
      path: "projects/intuneme/observations.md",
      file_type: "observations",
      label: "intuneme",
    });
    expect(result.created).toBe(true);
    const content = await readFile(join(root, "projects/intuneme/observations.md"), "utf8");
    expect(content).toContain("<!-- L0: Timestamped observations and events for intuneme -->");
    expect(content).toContain("# intuneme — Observations");
    expect(content).toContain("Format: - YYYY-MM-DD [tags]: observation");
  });

  test("creates action-items with Open and Completed sections", async () => {
    const result = await initCanonicalFile({
      path: "projects/intuneme/action-items.md",
      file_type: "action-items",
      label: "intuneme",
    });
    expect(result.created).toBe(true);
    const content = await readFile(join(root, "projects/intuneme/action-items.md"), "utf8");
    expect(content).toContain("<!-- L0: Open and completed tasks for intuneme -->");
    expect(content).toContain("# intuneme — Action Items");
    expect(content).toContain("## Open");
    expect(content).toContain("## Completed");
  });

  test("creates dev-log with standard template", async () => {
    const result = await initCanonicalFile({
      path: "projects/intuneme/dev-log.md",
      file_type: "dev-log",
      label: "intuneme",
    });
    expect(result.created).toBe(true);
    const content = await readFile(join(root, "projects/intuneme/dev-log.md"), "utf8");
    expect(content).toContain("<!-- L0: Development log and architectural decisions for intuneme -->");
    expect(content).toContain("# intuneme — Dev Log");
  });

  test("creates decisions.md with the decisions template", async () => {
    const result = await initCanonicalFile({
      path: "projects/intuneme/decisions.md",
      file_type: "decisions",
      label: "intuneme",
    });
    expect(result.created).toBe(true);
    const content = await readFile(join(root, "projects/intuneme/decisions.md"), "utf8");
    expect(content.split("\n")[0]).toBe("<!-- L0: Decisions for intuneme -->");
    expect(content).toContain("# intuneme — Decisions");
    expect(content).toContain("Append-only log of architectural decisions");
    expect(content).toContain("[d-<slug>]");
    expect(content).toContain("superseded-by");
    expect(content).toMatch(/```[\s\S]*?- YYYY-MM-DD \[d-<slug>\]:[\s\S]*?```/);
  });

  test("decisions template body has no nested HTML comments that would leak on render", async () => {
    const result = await initCanonicalFile({
      path: "projects/intuneme/decisions.md",
      file_type: "decisions",
      label: "intuneme",
    });
    expect(result.created).toBe(true);
    const content = await readFile(join(root, "projects/intuneme/decisions.md"), "utf8");

    let residue = content;
    while (true) {
      const start = residue.indexOf("<!--");
      if (start === -1) break;
      const end = residue.indexOf("-->", start);
      if (end === -1) break;
      residue = residue.slice(0, start) + residue.slice(end + 3);
    }

    expect(residue).not.toContain("-->");
  });

  test("creates generic file with basename-title-cased header", async () => {
    const result = await initCanonicalFile({
      path: "projects/intuneme/entities.md",
      file_type: "generic",
      label: "intuneme",
    });
    expect(result.created).toBe(true);
    const content = await readFile(join(root, "projects/intuneme/entities.md"), "utf8");
    expect(content).toContain("<!-- L0: Entities for intuneme -->");
    expect(content).toContain("# intuneme — Entities");
  });

  test("title-cases multi-segment basenames in generic template", async () => {
    const result = await initCanonicalFile({
      path: "projects/intuneme/hot-memory.md",
      file_type: "generic",
      label: "intuneme",
    });
    expect(result.created).toBe(true);
    const content = await readFile(join(root, "projects/intuneme/hot-memory.md"), "utf8");
    expect(content).toContain("# intuneme — Hot Memory");
  });

  test("returns created:false when file already exists (idempotent)", async () => {
    const first = await initCanonicalFile({
      path: "projects/intuneme/hot-memory.md",
      file_type: "hot-memory",
      label: "intuneme",
    });
    expect(first.created).toBe(true);
    const beforeBytes = first.bytes;

    const second = await initCanonicalFile({
      path: "projects/intuneme/hot-memory.md",
      file_type: "hot-memory",
      label: "intuneme",
    });
    expect(second.created).toBe(false);
    expect(second.bytes).toBe(0);

    // File content unchanged
    const content = await readFile(join(root, "projects/intuneme/hot-memory.md"), "utf8");
    expect(Buffer.byteLength(content)).toBe(beforeBytes);
  });

  test("rejects paths not under any registered domain", async () => {
    await expect(initCanonicalFile({
      path: "personal/observations.md",
      file_type: "observations",
      label: "personal",
    })).rejects.toThrow(/not under any registered domain/);
  });

  test("rejects basename with underscore (slug rule)", async () => {
    await expect(initCanonicalFile({
      path: "projects/intuneme/hot_memory.md",
      file_type: "hot-memory",
      label: "intuneme",
    })).rejects.toThrow(/basename .* must match/);
  });

  test("rejects basename with capital letter (slug rule)", async () => {
    await expect(initCanonicalFile({
      path: "projects/intuneme/Hot-memory.md",
      file_type: "hot-memory",
      label: "intuneme",
    })).rejects.toThrow(/basename .* must match/);
  });

  test("rejects basename with space (slug rule)", async () => {
    await expect(initCanonicalFile({
      path: "projects/intuneme/hot memory.md",
      file_type: "hot-memory",
      label: "intuneme",
    })).rejects.toThrow(/basename .* must match/);
  });

  test("rejects unknown param keys", async () => {
    await expect(initCanonicalFile({
      path: "projects/intuneme/hot-memory.md",
      file_type: "hot-memory",
      label: "intuneme",
      extra: "nope",
    } as unknown as never)).rejects.toThrow(/unknown param key/);
  });

  test("defaults to generic template when file_type is unrecognized", async () => {
    const result = await initCanonicalFile({
      path: "projects/intuneme/entities.md",
      file_type: "some-unknown-type" as unknown as "generic",
      label: "intuneme",
    });
    expect(result.created).toBe(true);
    const content = await readFile(join(root, "projects/intuneme/entities.md"), "utf8");
    expect(content).toContain("# intuneme — Entities");
  });
});
