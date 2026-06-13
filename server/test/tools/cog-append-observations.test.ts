import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemorySystem } from "ltm";
import { attachLtm } from "../../src/memory/index.ts";
import { createCogTools } from "../../src/tools/cog.ts";

let memRoot = "";
let ltmDir = "";
let ltm: MemorySystem | null = null;

async function setupMemRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ytsejam-cog-append-"));
  process.env.YTSEJAM_MEMORY_DIR = root;
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "root"], { cwd: root });
  return root;
}

function findTool(tools: ReturnType<typeof createCogTools>, name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

function recalledTexts(recalled: Awaited<ReturnType<MemorySystem["retrieve"]>>): string[] {
  return recalled.items.map((e) => e.record.text);
}

beforeEach(async () => {
  attachLtm(null);
  memRoot = await setupMemRoot();
  ltmDir = await mkdtemp(join(tmpdir(), "ltm-cog-append-"));
  ltm = MemorySystem.open({ storeDir: ltmDir });
  attachLtm(ltm);
});

afterEach(async () => {
  if (ltm) { ltm.close(); ltm = null; }
  attachLtm(null);
  delete process.env.YTSEJAM_MEMORY_DIR;
  if (memRoot) await rm(memRoot, { recursive: true, force: true });
  if (ltmDir) await rm(ltmDir, { recursive: true, force: true });
});

describe("cog_append → recordObservation routing for observations.md", () => {
  it("routes a single-line observation through recordObservation and mirrors to LTM", async () => {
    const cog_append = findTool(createCogTools(), "cog_append");
    await cog_append.execute("call-1", {
      path: "personal/observations.md",
      text: "- 2026-06-13 [mood]: feeling great\n",
    });
    const file = await readFile(join(memRoot, "personal", "observations.md"), "utf8");
    expect(file).toContain("- 2026-06-13 [mood]: feeling great");
    // LTM mirror happened
    const recalled = await ltm!.retrieve("mood", { k: 5 });
    const texts = recalledTexts(recalled);
    expect(texts).toContain("feeling great");
  });

  it("routes a multi-line text by splitting + per-line recordObservation", async () => {
    const cog_append = findTool(createCogTools(), "cog_append");
    await cog_append.execute("call-2", {
      path: "personal/observations.md",
      text: "- 2026-06-13 [a]: first\n- 2026-06-13 [b]: second\n",
    });
    const file = await readFile(join(memRoot, "personal", "observations.md"), "utf8");
    expect(file).toContain("- 2026-06-13 [a]: first");
    expect(file).toContain("- 2026-06-13 [b]: second");
    const recalledA = await ltm!.retrieve("first", { k: 5 });
    expect(recalledTexts(recalledA)).toContain("first");
    const recalledB = await ltm!.retrieve("second", { k: 5 });
    expect(recalledTexts(recalledB)).toContain("second");
  });

  it("throws on a malformed observation line", async () => {
    const cog_append = findTool(createCogTools(), "cog_append");
    await expect(
      cog_append.execute("call-3", {
        path: "personal/observations.md",
        text: "- 2026-06-13 [tag]: ok\nmalformed-line-with-no-dash\n",
      }),
    ).rejects.toThrow(/malformed observation line/);
  });

  it("nested-domain path: derives domainPath correctly for projects/ytsejam/observations.md", async () => {
    const cog_append = findTool(createCogTools(), "cog_append");
    await cog_append.execute("call-4", {
      path: "projects/ytsejam/observations.md",
      text: "- 2026-06-13 [shipped]: bridge 1\n",
    });
    const file = await readFile(join(memRoot, "projects", "ytsejam", "observations.md"), "utf8");
    expect(file).toContain("- 2026-06-13 [shipped]: bridge 1");
    const recalled = await ltm!.retrieve("bridge 1", { k: 5 });
    expect(recalledTexts(recalled)).toContain("bridge 1");
  });

  it("falls back to memory.append for non-observations paths", async () => {
    const cog_append = findTool(createCogTools(), "cog_append");
    await cog_append.execute("call-5", {
      path: "personal/hot-memory.md",
      text: "free-form note\n",
    });
    const file = await readFile(join(memRoot, "personal", "hot-memory.md"), "utf8");
    expect(file).toContain("free-form note");
    // LTM should NOT have this since hot-memory writes don't route through the bridge
    const recalled = await ltm!.retrieve("free-form note", { k: 5 });
    expect(recalledTexts(recalled)).not.toContain("free-form note");
  });

  it("falls back to memory.append when section is specified (even for observations.md)", async () => {
    // First write a file with a section heading
    const cog_append = findTool(createCogTools(), "cog_append");
    // observations.md doesn't normally have sections; this is a safety-fallback test
    // pre-create the file with a section heading so appendUnderSection succeeds
    const { writeFile } = await import("node:fs/promises");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(memRoot, "personal"), { recursive: true });
    await writeFile(
      join(memRoot, "personal", "observations.md"),
      "<!-- L0: test -->\n# Test\n\n## Some Section\n",
    );
    await cog_append.execute("call-6", {
      path: "personal/observations.md",
      text: "- 2026-06-13 [section]: raw text under section\n",
      section: "Some Section",
    });
    const file = await readFile(join(memRoot, "personal", "observations.md"), "utf8");
    expect(file).toContain("raw text under section");
    const recalled = await ltm!.retrieve("raw text under section", { k: 5 });
    expect(recalledTexts(recalled)).not.toContain("raw text under section");
  });
});
