import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createCogTools } from "../src/tools/cog.ts";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ytsejam-cog-tools-"));
  process.env.YTSEJAM_MEMORY_DIR = root;
  await seedStore();
});

afterEach(async () => {
  delete process.env.YTSEJAM_MEMORY_DIR;
  if (root) await rm(root, { recursive: true, force: true });
});

async function seed(rel: string, content: string) {
  const abs = join(root, ...rel.split("/"));
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
}

async function seedStore() {
  await seed("domains.yml", `version: 1
domains:
  - id: personal
    path: personal
    label: Personal
    triggers: [home]
    files: [hot-memory, action-items, observations, entities]
`);
  await seed("hot-memory.md", "<!-- L0: Global hot memory -->\n# Hot\nCurrent state\n");
  await seed("cog-meta/patterns.md", "<!-- L0: Pattern memory -->\n# Patterns\n- Keep it simple\n");
  await seed("personal/hot-memory.md", "<!-- L0: Personal hot memory -->\n# Personal\n");
  await seed("personal/action-items.md", "- [ ] call Alice | due:2026-06-20 | pri:high | added:2026-06-01\n");
  await seed("personal/observations.md", "- 2026-06-01 [family]: Alice likes tea\n- 2026-06-02 [family]: Alice scheduled a visit\n- 2026-06-03 [family]: Alice prefers mornings\n");
  await seed("personal/entities.md", "### Alice (friend)\nlikes tea | status:active | last:2026-06-01\n");
  await seed("wiki/alice.md", "---\ntitle: Alice\nentity_type: person\ntags: [family]\nsummary: Friend\n---\n# Alice\n");
  await seed("glacier/personal/archive.md", "---\ntype: observations\ndomain: personal\ntags: [family]\ndate_range: 2026-05-01..2026-05-31\nentries: 2\nsummary: Older family notes\n---\n# Archive\n");
  await seed("cog-meta/scenarios/check.md", "---\nstatus: active\ncheck-by: 2026-06-12\n---\n# Check\n");
}

function tool(name: string) {
  const t = createCogTools().find((t) => t.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

function text(r: { content: { type: string }[] }): string {
  return (r.content[0] as any).text;
}

async function run(name: string, params: Record<string, unknown>) {
  return text(await tool(name).execute("test", params));
}

describe("in-process cog tool integration", () => {
  test("representative primitive tools work end-to-end against a temp memory root", async () => {
    expect(await run("cog_read", { path: "hot-memory.md" })).toContain("Current state");
    expect(await run("cog_append", { path: "notes.md", text: "hello" })).toContain('"ok": true');
    expect(await run("cog_patch", { path: "notes.md", old_text: "hello", new_text: "goodbye" })).toContain('"ok": true');
    expect(await run("cog_search", { query: "goodbye" })).toContain("notes.md");
    expect(await run("cog_outline", { path: "hot-memory.md" })).toContain("Global hot memory");
    expect(await run("cog_list", {})).toContain("notes.md");
    await seed("old/INDEX.md", "move me\n");
    expect(await run("cog_move", { from: "old/INDEX.md", to: "new/INDEX.md" })).toContain('"ok": true');
  });

  test("id-as-path writes are rejected with the corrective error", async () => {
    const err: any = await tool("cog_write")
      .execute("test", { path: "personal/hot-memory.md", content: "# stray probe\n" })
      .catch((e) => e);
    expect(err.message).toMatch(/write path not allowed|use append or patch/);
  });

  test("every cog_rpc allow-listed method dispatches to memory without unknown-method errors", async () => {
    const gitAvailable = (() => {
      try {
        execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
        execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, stdio: "ignore" });
        execFileSync("git", ["config", "user.name", "Test"], { cwd: root, stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    })();

    const cases: { method: string; params?: Record<string, unknown>; expectKeys: string[] }[] = [
      { method: "session_brief", expectKeys: ["hot_memory", "domains"] },
      { method: "domain_summary", params: { domain: "personal", since: "30d" }, expectKeys: ["domain", "files_present"] },
      { method: "housekeeping_scan", expectKeys: ["thresholds", "stale_action_items"] },
      { method: "open_actions", expectKeys: ["items"] },
      { method: "recent_observations", params: { since: "30d" }, expectKeys: ["entries", "by_tag"] },
      { method: "glacier_index_compute", expectKeys: ["entries", "count"] },
      { method: "wiki_index_compute", expectKeys: ["entries", "count"] },
      { method: "link_index_compute", expectKeys: ["links"] },
      { method: "link_audit", expectKeys: ["candidates"] },
      { method: "entity_audit", params: { domain: "personal" }, expectKeys: ["total_entries", "missing_metadata"] },
      { method: "cluster_check", params: { domain: "personal", since: "30d" }, expectKeys: ["by_tag", "thread_candidates"] },
      { method: "scenario_check", expectKeys: ["scenarios"] },
      { method: "domains.list", expectKeys: ["domains"] },
      { method: "domains.get", params: { id: "personal" }, expectKeys: ["domain"] },
      { method: "l0index", expectKeys: ["index"] },
      { method: "stats", expectKeys: ["files", "per_file"] },
      { method: "health", expectKeys: ["ok", "memory_root"] },
      ...(gitAvailable ? [{ method: "git", params: { op: "status" }, expectKeys: ["output"] }] : []),
    ];

    for (const c of cases) {
      const out = await run("cog_rpc", { method: c.method, params: c.params });
      const parsed = JSON.parse(out);
      for (const key of c.expectKeys) expect(parsed).toHaveProperty(key);
    }
  });
});
