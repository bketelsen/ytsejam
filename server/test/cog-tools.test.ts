import { describe, expect, test } from "vitest";
import { createCogTools } from "../src/tools/cog.ts";
import type { CogClient } from "../src/cog/client.ts";
import { CogRpcError } from "../src/cog/client.ts";

/** Recording fake standing in for CogClient. */
function fakeClient(result: unknown = { ok: true }) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const client = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as CogClient;
  return { client, calls };
}

function tool(tools: ReturnType<typeof createCogTools>, name: string) {
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

function text(r: { content: { type: string }[] }): string {
  return (r.content[0] as any).text;
}

describe("createCogTools", () => {
  test("registers the full faithful tool vocabulary", () => {
    const { client } = fakeClient();
    const names = createCogTools(client, "agent").map((t) => t.name);
    expect(names).toEqual([
      "cog_read",
      "cog_write",
      "cog_append",
      "cog_patch",
      "cog_outline",
      "cog_search",
      "cog_list",
      "cog_move",
      "cog_rpc",
    ]);
  });

  test("injects the role and maps params snake_cased onto the wire", async () => {
    const { client, calls } = fakeClient({ content: "" });
    const tools = createCogTools(client, "ytsejam");
    await tool(tools, "cog_read").execute("t1", { path: "a.md", section: "## S", start: 1, end: 5 });
    await tool(tools, "cog_patch").execute("t2", { path: "a.md", old_text: "x", new_text: "y" });
    await tool(tools, "cog_move").execute("t3", { from: "a.md", to: "b.md" });
    expect(calls[0]).toEqual({
      method: "read",
      params: { role: "ytsejam", path: "a.md", section: "## S", start: 1, end: 5 },
    });
    expect(calls[1]).toEqual({
      method: "patch",
      params: { role: "ytsejam", path: "a.md", old_text: "x", new_text: "y" },
    });
    expect(calls[2]).toEqual({ method: "move", params: { role: "ytsejam", from: "a.md", to: "b.md" } });
  });

  test("cog_read returns the content as plain text", async () => {
    const { client } = fakeClient({ content: "# Hot\nstate", found: true });
    const r = await tool(createCogTools(client, "agent"), "cog_read").execute("t1", { path: "hot-memory.md" });
    expect(text(r)).toBe("# Hot\nstate");
  });

  test("envelope results render as pretty JSON", async () => {
    const { client } = fakeClient({ domains: [{ id: "dakota", path: "projects/dakota" }] });
    const r = await tool(createCogTools(client, "agent"), "cog_rpc").execute("t1", {
      method: "domains.list",
    });
    expect(text(r)).toContain('"path": "projects/dakota"');
  });

  test("cog_rpc forwards method and params with role injected", async () => {
    const { client, calls } = fakeClient({});
    await tool(createCogTools(client, "agent"), "cog_rpc").execute("t1", {
      method: "domain_summary",
      params: { domain: "dakota", since: "7d" },
    });
    expect(calls[0]).toEqual({
      method: "domain_summary",
      params: { role: "agent", domain: "dakota", since: "7d" },
    });
  });

  test("cog_rpc schema restricts method to the allowed envelope set", () => {
    const { client } = fakeClient();
    const t = tool(createCogTools(client, "agent"), "cog_rpc");
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

  test("daemon errors (id-as-path correction) propagate into the thrown error", async () => {
    const { client } = fakeClient(
      new CogRpcError(
        -32602,
        'write: domain id used as path: write to "dakota/INDEX.md" uses domain id "dakota" as its path; domain "dakota" lives at "projects/dakota"',
      ),
    );
    const err = await tool(createCogTools(client, "agent"), "cog_write")
      .execute("t1", { path: "dakota/INDEX.md", content: "x" })
      .catch((e) => e);
    expect(err.message).toContain('lives at "projects/dakota"');
  });

  test("write tool descriptions carry the path-never-id rule", () => {
    const { client } = fakeClient();
    const tools = createCogTools(client, "agent");
    for (const name of ["cog_write", "cog_append", "cog_patch"]) {
      expect(tool(tools, name).description).toMatch(/path.*never.*id/is);
    }
  });
});

describe("audit regressions", () => {
  test("model-supplied role cannot override the injected role", async () => {
    const { client, calls } = fakeClient({ content: "" });
    const tools = createCogTools(client, "agent");
    await tool(tools, "cog_read").execute("t1", { path: "a.md", role: "owner" } as any);
    await tool(tools, "cog_rpc").execute("t2", { method: "domains.list", params: { role: "owner" } });
    expect(calls[0].params.role).toBe("agent");
    expect(calls[1].params.role).toBe("agent");
  });

  test("cog_read tolerates a null result", async () => {
    const { client } = fakeClient(null);
    const r = await tool(createCogTools(client, "agent"), "cog_read").execute("t1", { path: "a.md" });
    expect(text(r)).toBe("");
  });
});
