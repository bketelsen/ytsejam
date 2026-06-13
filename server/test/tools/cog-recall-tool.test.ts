import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemorySystem } from "ltm";
import { attachLtm, recordObservation } from "../../src/memory/index.ts";
import { createCogTools } from "../../src/tools/cog.ts";

let memRoot = "";
let ltmDir = "";
let ltm: MemorySystem | null = null;

async function setupMemRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ytsejam-recall-tool-"));
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

beforeEach(async () => {
  attachLtm(null);
  memRoot = await setupMemRoot();
  ltmDir = await mkdtemp(join(tmpdir(), "ltm-recall-tool-"));
  ltm = MemorySystem.open({ storeDir: ltmDir });
  attachLtm(ltm);
});

afterEach(async () => {
  attachLtm(null);
  if (ltm) {
    ltm.close();
    ltm = null;
  }
  delete process.env.YTSEJAM_MEMORY_DIR;
  if (memRoot) await rm(memRoot, { recursive: true, force: true });
  if (ltmDir) await rm(ltmDir, { recursive: true, force: true });
});

describe("recall agent tool", () => {
  it("is registered with name 'recall' (no prefix)", () => {
    const tools = createCogTools();
    const t = tools.find((x) => x.name === "recall");
    expect(t).toBeDefined();
    expect(t?.label).toBeTruthy();
    expect(t?.description).toMatch(/cog/i);
    expect(t?.description).toMatch(/ltm|long-term memory/i);
  });

  it("execute returns the recall envelope as JSON text", async () => {
    await recordObservation({
      domainPath: "cog-meta",
      text: "recall-tool-test marker findme",
      tags: ["recall-tool-test"],
    });
    const tools = createCogTools();
    const recallTool = findTool(tools, "recall");
    const result = await recallTool.execute("call-1", { query: "recall-tool-test marker" });
    expect(result).toBeDefined();
    expect(result.content).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
    const first = result.content[0];
    expect(first?.type).toBe("text");
    // Narrow the TextContent | ImageContent union after the runtime assertion above.
    if (!first || first.type !== "text") throw new Error("expected text content");
    const text = first.text;
    expect(typeof text).toBe("string");
    const parsed = JSON.parse(text);
    expect(parsed.hits).toBeDefined();
    expect(Array.isArray(parsed.hits)).toBe(true);
    expect(parsed.cogCount).toBeGreaterThanOrEqual(1);
    expect(parsed.hits[0].from).toBe("cog");
    expect(parsed.hits[0].where).toMatch(/cog-meta\/observations\.md:\d+/);
  });

  it("parameters declares a single required 'query' string", () => {
    const tools = createCogTools();
    const recallTool = findTool(tools, "recall");
    const params = recallTool.parameters as any;
    expect(params).toBeDefined();
    // TypeBox Type.Object → JSON-Schema-ish shape with `type: "object"`, `properties`, `required`.
    expect(params.type).toBe("object");
    expect(params.properties?.query).toBeDefined();
    expect(params.properties.query.type).toBe("string");
    expect(params.required).toContain("query");
    // No other required fields — filter param deferred to a future PR.
    expect(Object.keys(params.properties)).toEqual(["query"]);
  });
});
