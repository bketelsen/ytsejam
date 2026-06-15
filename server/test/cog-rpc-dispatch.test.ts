import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createCogTools } from "../src/tools/cog.ts";

let memoryDir = "";
let dataDir = "";
let savedMemoryDir: string | undefined;
let savedDataDir: string | undefined;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ytsejam-cog-rpc-data-"));
  memoryDir = join(dataDir, "memory");
  await mkdir(memoryDir, { recursive: true });
  await mkdir(join(dataDir, "skills"), { recursive: true });
  savedMemoryDir = process.env.YTSEJAM_MEMORY_DIR;
  savedDataDir = process.env.YTSEJAM_DATA_DIR;
  process.env.YTSEJAM_MEMORY_DIR = memoryDir;
  process.env.YTSEJAM_DATA_DIR = dataDir;
  await writeFile(join(memoryDir, "domains.yml"), `version: 1
domains:
  - id: demo
    path: projects/demo
    label: "demo project"
    files: [hot-memory, observations]
`, "utf8");
});
afterEach(async () => {
  if (savedMemoryDir === undefined) delete process.env.YTSEJAM_MEMORY_DIR;
  else process.env.YTSEJAM_MEMORY_DIR = savedMemoryDir;
  if (savedDataDir === undefined) delete process.env.YTSEJAM_DATA_DIR;
  else process.env.YTSEJAM_DATA_DIR = savedDataDir;
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

function rpcTool() {
  const rpc = createCogTools().find((t) => t.name === "cog_rpc");
  if (!rpc) throw new Error("cog_rpc tool not registered");
  return rpc;
}

function text(r: { content: { type: string }[] }): string {
  return (r.content[0] as any).text;
}

describe("cog_rpc dispatch — new methods", () => {
  test("init_canonical_file is dispatched through cog_rpc", async () => {
    const result = await rpcTool().execute("call-1", {
      method: "init_canonical_file",
      params: {
        path: "projects/demo/hot-memory.md",
        file_type: "hot-memory",
        label: "demo",
      },
    });
    const parsed = JSON.parse(text(result));
    expect(parsed.created).toBe(true);
    expect(parsed.path).toBe("projects/demo/hot-memory.md");
    const content = await readFile(join(memoryDir, "projects/demo/hot-memory.md"), "utf8");
    expect(content).toContain("# demo — Hot Memory");
  });

  test("skill_write is dispatched through cog_rpc", async () => {
    const result = await rpcTool().execute("call-2", {
      method: "skill_write",
      params: {
        id: "demo",
        description: "demo skill",
        triggers: ["demo"],
        body: "Use this skill.\n",
      },
    });
    const parsed = JSON.parse(text(result));
    expect(parsed.path).toBe(join(dataDir, "skills", "demo.md"));
    const content = await readFile(parsed.path, "utf8");
    expect(content).toContain("name: demo");
  });

  test("unknown method still rejected", async () => {
    await expect(rpcTool().execute("call-3", {
      method: "not_a_method",
      params: {},
    })).rejects.toThrow(/unknown cog_rpc method/);
  });
});
