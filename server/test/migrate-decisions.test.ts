import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrateDecisions } from "../../scripts/migrate-decisions.ts";

describe("migrate-decisions", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "migrate-decisions-"));
  });

  it("converts wiki entries to projects/<slug>/decisions.md format", async () => {
    mkdirSync(path.join(root, "wiki/projects/foo"), { recursive: true });
    mkdirSync(path.join(root, "projects/foo"), { recursive: true });
    writeFileSync(path.join(root, "wiki/projects/foo/decisions.md"), [
      "# foo decisions",
      "",
      "- 2026-06-12: **Use SQLite for cache** — fast, embedded, zero ops. Origin: PR #100.",
      "- 2026-06-13: **Switch cache to LMDB** — supersedes prior; SQLite too slow on writes. Origin: PR #110.",
      "",
    ].join("\n"));

    await migrateDecisions({ root, domainPath: "projects/foo" });

    const out = await readFile(path.join(root, "projects/foo/decisions.md"), "utf8");
    expect(out).toMatch(/^<!-- L0: Decisions for projects\/foo -->/);
    expect(out).toMatch(/- 2026-06-12 \[d-use-sqlite-cache\]:/);
    expect(out).toMatch(/- 2026-06-13 \[d-switch-cache-lmdb\]:/);
    expect(out).toMatch(/<!-- origin: PR #100 -->/);
    expect(out).toMatch(/<!-- origin: PR #110 -->/);
  });

  it("disambiguates colliding slugs with -2, -3 suffix", async () => {
    mkdirSync(path.join(root, "wiki/projects/foo"), { recursive: true });
    mkdirSync(path.join(root, "projects/foo"), { recursive: true });
    writeFileSync(path.join(root, "wiki/projects/foo/decisions.md"), [
      "- 2026-06-12: **Use SQLite** — fast. Origin: PR #1.",
      "- 2026-06-13: **Use SQLite** — different decision, same title. Origin: PR #2.",
      "",
    ].join("\n"));

    await migrateDecisions({ root, domainPath: "projects/foo" });
    const out = await readFile(path.join(root, "projects/foo/decisions.md"), "utf8");
    expect(out).toMatch(/\[d-use-sqlite\]:/);
    expect(out).toMatch(/\[d-use-sqlite-2\]:/);
  });

  it("is a no-op when source file doesn't exist", async () => {
    await expect(
      migrateDecisions({ root, domainPath: "projects/missing" })
    ).resolves.toBeUndefined();
  });

  it("preserves stop-words handling: drops a/an/the/of/for/and/or/to/in/on/with", async () => {
    mkdirSync(path.join(root, "wiki/projects/foo"), { recursive: true });
    mkdirSync(path.join(root, "projects/foo"), { recursive: true });
    writeFileSync(path.join(root, "wiki/projects/foo/decisions.md"), [
      "- 2026-06-12: **The use of a cache for the system** — fast. Origin: PR #1.",
      "",
    ].join("\n"));

    await migrateDecisions({ root, domainPath: "projects/foo" });
    const out = await readFile(path.join(root, "projects/foo/decisions.md"), "utf8");
    // significant words after dropping stop-words from the title: "use cache system"
    expect(out).toMatch(/\[d-use-cache-system\]:/);
  });


  it("throws when destination already exists (no --force)", async () => {
    mkdirSync(path.join(root, "wiki/projects/foo"), { recursive: true });
    mkdirSync(path.join(root, "projects/foo"), { recursive: true });
    writeFileSync(path.join(root, "wiki/projects/foo/decisions.md"), [
      "- 2026-06-12: **Use SQLite** — fast. Origin: PR #1.",
      "",
    ].join("\n"));
    writeFileSync(path.join(root, "projects/foo/decisions.md"), "existing content\n");

    await expect(
      migrateDecisions({ root, domainPath: "projects/foo" })
    ).rejects.toThrow(/Destination already exists/);

    // existing content preserved
    const out = await readFile(path.join(root, "projects/foo/decisions.md"), "utf8");
    expect(out).toBe("existing content\n");
  });

  it("overwrites destination when force: true", async () => {
    mkdirSync(path.join(root, "wiki/projects/foo"), { recursive: true });
    mkdirSync(path.join(root, "projects/foo"), { recursive: true });
    writeFileSync(path.join(root, "wiki/projects/foo/decisions.md"), [
      "- 2026-06-12: **Use SQLite** — fast. Origin: PR #1.",
      "",
    ].join("\n"));
    writeFileSync(path.join(root, "projects/foo/decisions.md"), "existing content\n");

    await migrateDecisions({ root, domainPath: "projects/foo", force: true });

    const out = await readFile(path.join(root, "projects/foo/decisions.md"), "utf8");
    expect(out).toMatch(/^<!-- L0:/);
    expect(out).toMatch(/\[d-use-sqlite\]:/);
  });

  it("falls back to d-decision when title is all stopwords", async () => {
    mkdirSync(path.join(root, "wiki/projects/foo"), { recursive: true });
    mkdirSync(path.join(root, "projects/foo"), { recursive: true });
    writeFileSync(path.join(root, "wiki/projects/foo/decisions.md"), [
      "- 2026-06-12: **The and or** — body. Origin: PR #1.",
      "",
    ].join("\n"));

    await migrateDecisions({ root, domainPath: "projects/foo" });
    const out = await readFile(path.join(root, "projects/foo/decisions.md"), "utf8");
    expect(out).toMatch(/\[d-decision\]:/);
  });
});
