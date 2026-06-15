import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Controller, write } from "../../src/memory/index.ts";

let root = "";
let warnSpy: ReturnType<typeof vi.spyOn> | null = null;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ytsejam-manifest-surface-"));
  process.env.YTSEJAM_MEMORY_DIR = root;
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(async () => {
  warnSpy?.mockRestore();
  warnSpy = null;
  delete process.env.YTSEJAM_MEMORY_DIR;
  if (root) await rm(root, { recursive: true, force: true });
});

const goodManifest = `version: 1
domains:
  - id: demo
    path: projects/demo
    label: demo
    files: [hot-memory]
`;

describe("manifest error surface — end-to-end", () => {
  test("bad cog_write to domains.yml never reaches disk", async () => {
    const bad = `version: 1
domains:
  - id: x
    path: ""
    files: [hot-memory]
`;
    await expect(write("domains.yml", bad)).rejects.toThrow(/empty path/);
    expect(existsSync(join(root, "domains.yml"))).toBe(false);
  });

  test("an out-of-process bad manifest is observable via Controller.get()", async () => {
    // Simulate the path where cog_write's guard was bypassed (e.g. an external
    // editor wrote the file). The controller hot-reloads on mtime change and
    // records the error; subsequent get() surfaces it.
    await write("domains.yml", goodManifest);
    const c = new Controller(root);
    expect(c.get("demo").id).toBe("demo");

    // Out-of-process bad write (mimics an external editor or older tool).
    await writeFile(join(root, "domains.yml"), `version: 1
domains:
  - id: dup
    path: a
    files: [hot-memory]
  - id: dup
    path: b
    files: [hot-memory]
`, "utf8");
    const t = new Date(Date.now() + 1000);
    utimesSync(join(root, "domains.yml"), t, t);

    // Routing-RPC-level call surfaces enriched error.
    let caught: Error | null = null;
    try { c.get("anything"); } catch (err) { caught = err as Error; }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/last manifest load failed:/);
    expect(caught!.message).toMatch(/duplicate domain id "dup"/);
  });
});
