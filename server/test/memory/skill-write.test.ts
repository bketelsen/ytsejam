import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { skillWrite } from "../../src/memory/index.ts";

let dataDir = "";
let savedDataDir: string | undefined;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ytsejam-skill-write-"));
  savedDataDir = process.env.YTSEJAM_DATA_DIR;
  process.env.YTSEJAM_DATA_DIR = dataDir;
  await mkdir(join(dataDir, "skills"), { recursive: true });
});
afterEach(async () => {
  if (savedDataDir === undefined) delete process.env.YTSEJAM_DATA_DIR;
  else process.env.YTSEJAM_DATA_DIR = savedDataDir;
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe("skill_write", () => {
  test("writes skill file with valid frontmatter and body", async () => {
    const result = await skillWrite({
      id: "intuneme",
      description: "intuneme — test routing skill",
      triggers: ["intune", "intuneme"],
      body: "Use this skill for intuneme work.\n",
    });
    expect(result.path).toBe(join(dataDir, "skills", "intuneme.md"));
    expect(result.bytes).toBeGreaterThan(0);
    const content = await readFile(result.path, "utf8");
    expect(content).toContain("---\n");
    expect(content).toContain("name: intuneme\n");
    expect(content).toContain("description: intuneme — test routing skill\n");
    expect(content).toContain("triggers: [intune, intuneme]\n");
    expect(content).toContain("Use this skill for intuneme work.");
  });

  test("emits triggers as inline YAML array", async () => {
    const result = await skillWrite({
      id: "demo",
      description: "demo",
      triggers: ["a", "b", "c"],
      body: "body",
    });
    const content = await readFile(result.path, "utf8");
    expect(content).toContain("triggers: [a, b, c]\n");
  });

  test("overwrites an existing skill file", async () => {
    await skillWrite({
      id: "demo",
      description: "first",
      triggers: ["demo"],
      body: "first body",
    });
    const second = await skillWrite({
      id: "demo",
      description: "second",
      triggers: ["demo"],
      body: "second body",
    });
    const content = await readFile(second.path, "utf8");
    expect(content).toContain("description: second\n");
    expect(content).toContain("second body");
    expect(content).not.toContain("first body");
  });

  test("rejects id slug with underscore", async () => {
    await expect(skillWrite({
      id: "demo_skill",
      description: "x",
      triggers: ["demo"],
      body: "body",
    })).rejects.toThrow(/id .* must match/);
  });

  test("rejects id slug with capital letter", async () => {
    await expect(skillWrite({
      id: "Demo",
      description: "x",
      triggers: ["demo"],
      body: "body",
    })).rejects.toThrow(/id .* must match/);
  });

  test("rejects id slug starting with digit", async () => {
    await expect(skillWrite({
      id: "1demo",
      description: "x",
      triggers: ["demo"],
      body: "body",
    })).rejects.toThrow(/id .* must match/);
  });

  test("rejects empty triggers array", async () => {
    await expect(skillWrite({
      id: "demo",
      description: "x",
      triggers: [],
      body: "body",
    })).rejects.toThrow(/triggers must be non-empty/);
  });

  test("rejects empty description", async () => {
    await expect(skillWrite({
      id: "demo",
      description: "",
      triggers: ["demo"],
      body: "body",
    })).rejects.toThrow(/description is required/);
  });

  test("resolves path via YTSEJAM_DATA_DIR override", async () => {
    // beforeEach already set YTSEJAM_DATA_DIR; verify the written path uses it
    const result = await skillWrite({
      id: "demo",
      description: "x",
      triggers: ["demo"],
      body: "body",
    });
    expect(result.path.startsWith(dataDir)).toBe(true);
    expect(existsSync(result.path)).toBe(true);
  });

  test("rejects unknown param keys", async () => {
    await expect(skillWrite({
      id: "demo",
      description: "x",
      triggers: ["demo"],
      body: "body",
      extra: "no",
    } as unknown as never)).rejects.toThrow(/unknown param key/);
  });
});
