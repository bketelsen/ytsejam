import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createCogTools } from "../src/tools/cog.ts";
import * as memory from "../src/memory/index.ts";

function tool(tools: ReturnType<typeof createCogTools>, name: string) {
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

function text(r: { content: { type: string }[] }): string {
  return (r.content[0] as any).text;
}

function json(r: { content: { type: string }[] }) {
  return JSON.parse(text(r));
}

async function withMemoryRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ytsejam-cog-tool-bytes-"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  process.env.YTSEJAM_MEMORY_DIR = root;
  try {
    return await fn(root);
  } finally {
    delete process.env.YTSEJAM_MEMORY_DIR;
    warn.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}

describe("createCogTools", () => {
  afterEach(() => vi.restoreAllMocks());

  test("registers the full faithful tool vocabulary", () => {
    const names = createCogTools().map((t) => t.name);
    expect(names).toEqual([
      "cog_read",
      "cog_write",
      "cog_append",
      "cog_patch",
      "cog_outline",
      "cog_search",
      "recall",
      "cog_list",
      "cog_move",
      "cog_rpc",
    ]);
  });

  test("maps tool params directly onto memory primitives", async () => {
    const read = vi
      .spyOn(memory, "read")
      .mockResolvedValue({ content: "", found: true });
    const patch = vi.spyOn(memory, "patch").mockResolvedValue({ ok: true });
    const move = vi.spyOn(memory, "move").mockResolvedValue({ ok: true });
    const tools = createCogTools();
    await tool(tools, "cog_read").execute("t1", {
      path: "a.md",
      section: "## S",
      start: 1,
      end: 5,
    });
    await tool(tools, "cog_patch").execute("t2", {
      path: "a.md",
      old_text: "x",
      new_text: "y",
    });
    await tool(tools, "cog_move").execute("t3", { from: "a.md", to: "b.md" });
    expect(read).toHaveBeenCalledWith("a.md", {
      section: "## S",
      start: 1,
      end: 5,
    });
    expect(patch).toHaveBeenCalledWith("a.md", "x", "y");
    expect(move).toHaveBeenCalledWith("a.md", "b.md");
  });

  test("cog_read returns the content as plain text", async () => {
    vi.spyOn(memory, "read").mockResolvedValue({
      content: "# Hot\nstate",
      found: true,
    });
    const r = await tool(createCogTools(), "cog_read").execute("t1", {
      path: "hot-memory.md",
    });
    expect(text(r)).toBe("# Hot\nstate");
  });

  test("cog_append returns byte counts for a brand-new file", async () => {
    await withMemoryRoot(async () => {
      const r = await tool(createCogTools(), "cog_append").execute("t1", {
        path: "scratch.md",
        text: "héllo",
      });
      const parsed = json(r);
      const expected = Buffer.byteLength("héllo\n");
      expect(parsed).toEqual({
        ok: true,
        bytes_written: expected,
        total_bytes: expected,
      });
    });
  });

  test("cog_append returns growth and final size for existing-file duplicate appends", async () => {
    await withMemoryRoot(async (root) => {
      await writeFile(join(root, "scratch.md"), "alpha\n", "utf8");
      const appendTool = tool(createCogTools(), "cog_append");
      const first = json(await appendTool.execute("t1", {
        path: "scratch.md",
        text: "beta",
      }));
      const second = json(await appendTool.execute("t2", {
        path: "scratch.md",
        text: "beta",
      }));
      const growth = Buffer.byteLength("beta\n");
      expect(first).toEqual({
        ok: true,
        bytes_written: growth,
        total_bytes: Buffer.byteLength("alpha\nbeta\n"),
      });
      expect(second).toEqual({
        ok: true,
        bytes_written: growth,
        total_bytes: Buffer.byteLength("alpha\nbeta\nbeta\n"),
      });
    });
  });

  test("envelope results render as pretty JSON", async () => {
    vi.spyOn(memory, "health").mockResolvedValue({
      ok: true,
      memory_root: "/tmp/mem",
      files: 0,
    });
    vi.spyOn(memory, "Controller").mockImplementation(
      () =>
        ({
          list: () => [{ id: "dakota", path: "projects/dakota" }],
        }) as any,
    );
    const r = await tool(createCogTools(), "cog_rpc").execute("t1", {
      method: "domains.list",
    });
    expect(text(r)).toContain('"path": "projects/dakota"');
  });

  test("cog_rpc forwards method params to the memory allow-list dispatch", async () => {
    const domainSummary = vi.spyOn(memory, "domainSummary").mockResolvedValue({
      domain: "dakota",
      path: "projects/dakota",
      label: "Dakota",
      hot_memory: "",
      open_action_count: 0,
      completed_action_count_since: 0,
      recent_observations: [],
      files_present: [],
      last_activity: "",
      since: "2026-06-01",
    });
    await tool(createCogTools(), "cog_rpc").execute("t1", {
      method: "domain_summary",
      params: { domain: "dakota", since: "7d" },
    });
    expect(domainSummary).toHaveBeenCalledWith({
      domain: "dakota",
      since: "7d",
    });
  });

  test("cog_rpc schema restricts method to the allowed envelope set", () => {
    const t = tool(createCogTools(), "cog_rpc");
    const schema = JSON.stringify(t.parameters);
    for (const m of [
      "session_brief",
      "housekeeping_scan",
      "l0index",
      "stats",
      "domains.list",
      "link_index_compute",
    ]) {
      expect(schema).toContain(m);
    }
    expect(schema).not.toContain('"write"'); // file ops are not reachable through the passthrough
  });

  test("unknown cog_rpc methods are rejected clearly by the dispatch", async () => {
    const err = await tool(createCogTools(), "cog_rpc")
      .execute("t1", { method: "not.real", params: {} })
      .catch((e) => e);
    expect(err.message).toContain("unknown cog_rpc method: not.real");
  });

  test("cog_rpc reconcile_now dispatches with no opts and returns the stats", async () => {
    const stats = {
      scannedFiles: 3,
      scannedLines: 42,
      replayed: 7,
      rebuilt: 0,
      pruned: 0,
      skipped: 1,
      errors: 0,
    };
    const reconcileNow = vi
      .spyOn(memory, "reconcileNow")
      .mockResolvedValue(stats);
    const r = await tool(createCogTools(), "cog_rpc").execute("t1", {
      method: "reconcile_now",
    });
    expect(reconcileNow).toHaveBeenCalledWith({});
    expect(text(r)).toContain('"replayed": 7');
  });

  test("cog_rpc reconcile_now threads force=true through to memory.reconcileNow", async () => {
    const reconcileNow = vi.spyOn(memory, "reconcileNow").mockResolvedValue({
      scannedFiles: 0,
      scannedLines: 0,
      replayed: 0,
      rebuilt: 0,
      pruned: 0,
      skipped: 0,
      errors: 0,
    });
    await tool(createCogTools(), "cog_rpc").execute("t1", {
      method: "reconcile_now",
      params: { force: true },
    });
    expect(reconcileNow).toHaveBeenCalledWith({ force: true });
  });

  test("cog_rpc reconcile_now rejects non-boolean force", async () => {
    const reconcileNow = vi.spyOn(memory, "reconcileNow");
    const err = await tool(createCogTools(), "cog_rpc")
      .execute("t1", { method: "reconcile_now", params: { force: "yes" } })
      .catch((e) => e);
    expect(err.message).toContain("reconcile_now: force must be a boolean");
    expect(reconcileNow).not.toHaveBeenCalled();
  });

  test("cog_rpc reconcile_now rejects unknown param keys", async () => {
    const reconcileNow = vi.spyOn(memory, "reconcileNow");
    const err = await tool(createCogTools(), "cog_rpc")
      .execute("t1", { method: "reconcile_now", params: { bogus: 1 } })
      .catch((e) => e);
    expect(err.message).toContain(
      "reconcile_now: invalid params: unknown param key: bogus",
    );
    expect(reconcileNow).not.toHaveBeenCalled();
  });

  test("memory errors (id-as-path correction) propagate into the thrown error", async () => {
    vi.spyOn(memory, "write").mockRejectedValue(
      new Error(
        'write: domain id used as path: write to "dakota/INDEX.md" uses domain id "dakota" as its path; domain "dakota" lives at "projects/dakota"',
      ),
    );
    const err = await tool(createCogTools(), "cog_write")
      .execute("t1", { path: "dakota/INDEX.md", content: "x" })
      .catch((e) => e);
    expect(err.message).toContain('lives at "projects/dakota"');
  });

  test("write tool descriptions carry the path-never-id rule", () => {
    const tools = createCogTools();
    for (const name of ["cog_write", "cog_append", "cog_patch"]) {
      expect(tool(tools, name).description).toMatch(/path.*never.*id/is);
    }
  });
});

describe("audit regressions", () => {
  afterEach(() => vi.restoreAllMocks());

  test("model-supplied role is ignored after RBAC removal", async () => {
    const read = vi
      .spyOn(memory, "read")
      .mockResolvedValue({ content: "", found: true });
    const tools = createCogTools();
    await tool(tools, "cog_read").execute("t1", {
      path: "a.md",
      role: "owner",
    } as any);
    expect(read).toHaveBeenCalledWith("a.md", {
      section: undefined,
      start: undefined,
      end: undefined,
    });
  });

  test("cog_read tolerates a null result", async () => {
    vi.spyOn(memory, "read").mockResolvedValue(null as any);
    const r = await tool(createCogTools(), "cog_read").execute("t1", {
      path: "a.md",
    });
    expect(text(r)).toBe("");
  });
});
