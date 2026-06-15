import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { write } from "../../src/memory/index.ts";

let root = "";
let warnSpy: ReturnType<typeof vi.spyOn> | null = null;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ytsejam-validate-domains-"));
  process.env.YTSEJAM_MEMORY_DIR = root;
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(async () => {
  warnSpy?.mockRestore();
  warnSpy = null;
  delete process.env.YTSEJAM_MEMORY_DIR;
  if (root) await rm(root, { recursive: true, force: true });
});

const validManifest = `version: 1
domains:
  - id: demo
    path: projects/demo
    label: demo
    files: [hot-memory]
`;

describe("write(domains.yml) — validate on write", () => {
  test("accepts a valid manifest", async () => {
    const result = await write("domains.yml", validManifest);
    expect(result.bytes).toBeGreaterThan(0);
    const persisted = await readFile(join(root, "domains.yml"), "utf8");
    expect(persisted).toBe(validManifest);
  });

  test("rejects a manifest with duplicate ids — bytes not written", async () => {
    const bad = `version: 1
domains:
  - id: dup
    path: projects/dup-a
    files: [hot-memory]
  - id: dup
    path: projects/dup-b
    files: [hot-memory]
`;
    await expect(write("domains.yml", bad)).rejects.toThrow(/duplicate domain id "dup"/);
    expect(existsSync(join(root, "domains.yml"))).toBe(false);
  });

  test("rejects manifest with empty id — bytes not written", async () => {
    const bad = `version: 1
domains:
  - id: ""
    path: projects/x
    files: [hot-memory]
`;
    await expect(write("domains.yml", bad)).rejects.toThrow(/empty id/);
    expect(existsSync(join(root, "domains.yml"))).toBe(false);
  });

  test("rejects manifest with absolute path — bytes not written", async () => {
    const bad = `version: 1
domains:
  - id: x
    path: /absolute/bad
    files: [hot-memory]
`;
    await expect(write("domains.yml", bad)).rejects.toThrow(/path must be relative/);
    expect(existsSync(join(root, "domains.yml"))).toBe(false);
  });

  test("rejects unparseable YAML — bytes not written", async () => {
    const bad = `version: 1
domains:
  - id: x
    path: bad
   indented_wrong: yes
`;
    await expect(write("domains.yml", bad)).rejects.toThrow(/parse|validate/);
    expect(existsSync(join(root, "domains.yml"))).toBe(false);
  });

  test("does not validate non-manifest writes (regression guard)", async () => {
    // link-index.md is in the canonical allowlist and is NOT a manifest;
    // its writer must pass through unaffected.
    const result = await write("link-index.md", "# Link index\n\n- foo → bar\n");
    expect(result.bytes).toBeGreaterThan(0);
  });

  test("after a rejected write, a clean retry succeeds", async () => {
    const bad = `version: 1
domains:
  - id: dup
    path: projects/dup-a
    files: [hot-memory]
  - id: dup
    path: projects/dup-b
    files: [hot-memory]
`;
    await expect(write("domains.yml", bad)).rejects.toThrow(/duplicate/);
    expect(existsSync(join(root, "domains.yml"))).toBe(false);

    const result = await write("domains.yml", validManifest);
    expect(result.bytes).toBeGreaterThan(0);
    expect(existsSync(join(root, "domains.yml"))).toBe(true);
  });
});
