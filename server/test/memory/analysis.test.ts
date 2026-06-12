import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { clusterCheck, entityAudit, linkAudit, linkIndexCompute, scenarioCheck } from "../../src/memory/index.ts";

let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "ytsejam-analysis-")); process.env.YTSEJAM_MEMORY_DIR = root; await seedManifest(); });
afterEach(async () => { vi.useRealTimers(); delete process.env.YTSEJAM_MEMORY_DIR; if (root) await rm(root, { recursive: true, force: true }); });
async function seed(rel: string, body: string) { const abs = join(root, ...rel.split("/")); await mkdir(join(abs, ".."), { recursive: true }); await writeFile(abs, body, "utf8"); }
async function seedManifest() { await seed("domains.yml", `version: 1
domains:
  - id: dakota
    path: projects/dakota
    files: [hot-memory, action-items, observations, entities]
  - id: personal
    path: personal
    files: [hot-memory, action-items, observations, entities]
  - id: work
    path: work/microsoft
    files: [hot-memory, action-items, observations, entities]
`); }

describe("cluster_check", () => {
  test("TestClusterCheckMethodReturnsTagClusters / TestClusterByTag", async () => {
    await seed("personal/observations.md", [
      "- 2126-05-12 [health, sleep]: 4 hours, headache next day",
      "- 2126-05-15 [health]: low energy after lunch",
      "- 2126-05-20 [health, food]: skipped breakfast again",
      "- 2126-05-29 [health]: better sleep last 3 nights",
      "- 2126-05-29 [work]: shipped open_actions RPC",
      "- 2126-05-29 [work]: domain controller landed",
      "- 2126-05-29 [work]: cluster_check started",
    ].join("\n") + "\n");
    const res = await clusterCheck({ since: "2126-01-01", min_cluster_size: 3 });
    expect(res.by_tag[0]).toMatchObject({ tag: "health", count: 4 });
    expect(res.by_tag[0].spans_days).toBeGreaterThanOrEqual(17);
    expect(res.by_tag[0].samples[0].date).toBe("2126-05-29");
  });
  test("TestClusterSinceFilters", async () => {
    await seed("personal/observations.md", "- 2026-04-01 [old]: way back\n- 2026-04-02 [old]: also old\n- 2026-04-03 [old]: ancient\n- 2026-05-28 [fresh]: recent one\n- 2026-05-29 [fresh]: another\n- 2026-05-29 [fresh]: third\n");
    const res = await clusterCheck({ since: "2026-05-23" });
    expect(res.by_tag.some((c) => c.tag === "old")).toBe(false);
  });
  test("relative since truncates to UTC midnight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T14:30:00Z"));
    await seed("personal/observations.md", "- 2026-06-05 [edge]: boundary observation kept\n");
    const res = await clusterCheck({ since: "7d", min_cluster_size: 1 });
    expect(res.by_tag).toContainEqual(expect.objectContaining({ tag: "edge", count: 1 }));
    expect(res.by_tag.find((c) => c.tag === "edge")?.samples).toContainEqual(expect.objectContaining({ date: "2026-06-05", text: "boundary observation kept" }));
  });
  test("TestClusterByKeyword", async () => {
    await seed("personal/observations.md", "- 2026-05-20 [infra]: kanban dispatcher crashed again\n- 2026-05-21 [infra]: kanban DB still flaky\n- 2026-05-22 [infra]: kanban locking improved\n- 2026-05-23 [infra]: unrelated note about disk\n");
    const res = await clusterCheck({ since: "2026-05-01", min_cluster_size: 3 });
    expect(res.by_keyword).toContainEqual(expect.objectContaining({ keyword: "kanban", count: 3 }));
  });
  test("TestClusterThreadCandidates", async () => {
    await seed("personal/observations.md", "- 2026-04-15 [health]: started glp1\n- 2026-04-22 [health]: down 4 lbs\n- 2026-05-29 [health]: down 12 lbs total\n");
    const res = await clusterCheck({ since: "2026-04-01", span_days: 14 });
    expect(res.thread_candidates).toContainEqual(expect.objectContaining({ topic: "tag:health", fragment_count: 3 }));
  });
  test("TestClusterMinSizeRespected / MissingFileSkipped / invalid since / unknown domain / strict params", async () => {
    await seed("personal/observations.md", "- 2026-05-29 [x]: one\n");
    expect((await clusterCheck({ since: "2026-01-01" })).by_tag).toHaveLength(0);
    await rm(join(root, "personal/observations.md"));
    await expect(clusterCheck()).resolves.toMatchObject({ by_tag: [] });
    await expect(clusterCheck({ since: "yesterday" })).rejects.toThrow(/invalid since/);
    await expect(clusterCheck({ domain: "nope" })).rejects.toThrow(/unknown id/);
    await expect(clusterCheck({ role: "siona" } as never)).rejects.toThrow(/unknown param/);
  });
});

describe("entity_audit", () => {
  test("TestEntityAuditEmpty / MissingFileSkipped", async () => {
    expect(await entityAudit()).toMatchObject({ format_violations: [], glacier_candidates: [], missing_metadata: [], temporal_violations: [], total_entries: 0, total_lines: 0 });
  });
  test("TestEntityAuditCompactBlockClean", async () => {
    await seed("work/microsoft/entities.md", "# Work — Entities\n\n### Microsoft (employer)\nRole: Principal Engineering Manager\nstatus: active | last: 2026-05-27\n");
    const res = await entityAudit({ domain: "work" });
    expect(res.format_violations).toHaveLength(0); expect(res.missing_metadata).toHaveLength(0); expect(res.glacier_candidates).toHaveLength(0);
  });
  test("TestEntityAuditFormatViolation / RPC all domains", async () => {
    await seed("work/microsoft/entities.md", "### Microsoft\nRole: employer\nstatus: active | last: 2026-05-27\n");
    await seed("personal/entities.md", "### Friend\nLine one\nLine two\nLine three\nLine four → [[wiki:pages/people/friend]]\nstatus: active | last: 2026-05-27\n");
    const res = await entityAudit();
    expect(res.format_violations).toHaveLength(1);
    expect(res.format_violations[0]).toMatchObject({ name: "Friend", issue: "exceeds_3_line_compact", has_detail_file: true });
  });
  test("TestEntityAuditScopedToDomain / MissingMetadata", async () => {
    await seed("work/microsoft/entities.md", "### X\nplain prose\n");
    await seed("personal/entities.md", "### X\nplain prose\n");
    const res = await entityAudit({ domain: "work" });
    expect(res.missing_metadata).toHaveLength(1);
    expect(res.missing_metadata[0]).toMatchObject({ path: "work/microsoft/entities.md", missing: ["status", "last"] });
  });
  test("TestEntityAuditGlacierByInactive / ByAge", async () => {
    vi.setSystemTime(new Date("2026-05-30T00:00:00Z"));
    await seed("work/microsoft/entities.md", "### Old Project\nstatus: inactive | last: 2026-05-01\n\n### Forgotten Colleague\nUsed to work on the data team.\nstatus: active | last: 2025-10-01\n");
    const res = await entityAudit({ domain: "work" });
    expect(res.glacier_candidates.map((g) => g.name)).toEqual(["Old Project", "Forgotten Colleague"]);
    expect(res.glacier_candidates[1].age_days).toBeGreaterThan(180);
  });
  test("TestEntityAuditTemporalViolation", async () => {
    vi.setSystemTime(new Date("2026-05-30T00:00:00Z"));
    await seed("work/microsoft/entities.md", "### Dana Lead\nRole: (until 2026-04) VP\nstatus: active | last: 2026-05-01\n\n### Eli Recent\nRole: (until 2026-06) PM\nstatus: active | last: 2026-05-15\n\n### Frank Struck\nRole: ~~(until 2026-04)~~ retired\nstatus: active | last: 2026-05-20\n");
    const res = await entityAudit({ domain: "work" });
    expect(res.temporal_violations).toEqual([expect.objectContaining({ name: "Dana Lead", needs: "strikethrough" })]);
  });
  test("TestEntityAuditTotals / UnknownDomain / strict params", async () => {
    await seed("work/microsoft/entities.md", "# Work\n\n<!-- comment -->\n\n### Microsoft (employer)\nRole: Principal\nstatus: active | last: 2026-05-27\n\n### Verbose Vendor\nFact one\nFact two\nFact three\nstatus: active | last: 2026-05-01\n");
    const res = await entityAudit({ domain: "work" });
    expect(res.total_entries).toBe(2); expect(res.total_lines).toBe(8);
    await expect(entityAudit({ domain: "nope" })).rejects.toThrow(/unknown id/);
    await expect(entityAudit({ role: "siona" } as never)).rejects.toThrow(/unknown param/);
  });
});

describe("link audit/index", () => {
  test("TestLinkIndexCompute", async () => {
    await seed("personal/observations.md", "see [[personal/entities#Jane]] and [[work/microsoft/hot-memory]]\nalso [[personal/entities#Jane]] again — should dedupe\n");
    await seed("work/microsoft/observations.md", "meeting with [[personal/entities#Jane]] today\n");
    const res = await linkIndexCompute(); const got = Object.fromEntries(res.links.map((l) => [l.target, l.sources]));
    expect(got["personal/entities"]).toEqual(["personal/observations", "work/microsoft/observations"]);
    expect(got["work/microsoft/hot-memory"]).toEqual(["personal/observations"]);
  });
  test("TestLinkIndexComputeRelatedFrontmatter and glacier skipped", async () => {
    await seed("wiki/research/honcho/index.md", "---\ntitle: Honcho\nrelated: [wiki/tools/swarmvault, wiki/research/wiki-redesign/synthesis.md]\n---\n# Honcho\n");
    await seed("wiki/tools/omegawiki/index.md", "---\ntitle: OmegaWiki\nrelated: [wiki/tools/swarmvault]\n---\n# OmegaWiki\n");
    await seed("glacier/old.md", "[[hidden/target]]\n");
    const got = Object.fromEntries((await linkIndexCompute()).links.map((l) => [l.target, l.sources]));
    expect(got["wiki/tools/swarmvault"]).toEqual(["wiki/research/honcho/index", "wiki/tools/omegawiki/index"]);
    expect(got["wiki/research/wiki-redesign/synthesis"]).toBeDefined();
    expect(got["hidden/target"]).toBeUndefined();
    await expect(linkIndexCompute({ role: "siona" } as never)).rejects.toThrow(/unknown param/);
  });
  test("TestLinkAudit / WholeWordBoundary", async () => {
    await seed("personal/entities.md", "# Entities\n\n### Jane Smith (CTO)\nRole: CTO\n\n### Bob\nstatus: active\n");
    await seed("personal/observations.md", "- 2026-05-30 [meeting]: spoke with Jane Smith about onboarding\n- 2026-05-30 [meeting]: also met [[personal/entities#Bob]] (already linked)\n- 2026-05-30 [note]: Jane Smith follow-up tomorrow\nBobcat is not Bob\nBob's lunch\n");
    await seed("work/microsoft/observations.md", "Bob is rolling out the new dashboard\n");
    const cs = (await linkAudit()).candidates;
    expect(cs).toContainEqual(expect.objectContaining({ source_path: "personal/observations.md", line: 1, entity_name: "Jane Smith", target_link: "personal/entities#Jane Smith" }));
    expect(cs).toContainEqual(expect.objectContaining({ source_path: "personal/observations.md", line: 3, entity_name: "Jane Smith" }));
    expect(cs).toContainEqual(expect.objectContaining({ source_path: "work/microsoft/observations.md", line: 1, entity_name: "Bob" }));
    expect(cs.some((c) => c.source_path === "personal/entities.md")).toBe(false);
    expect(cs.some((c) => c.line === 2 && c.entity_name === "Bob")).toBe(false);
    expect(cs.filter((c) => c.source_path === "personal/observations.md" && c.entity_name === "Bob")).toHaveLength(2);
    await expect(linkAudit({ role: "siona" } as never)).rejects.toThrow(/unknown param/);
  });
  test("linkAudit strips entity headings at the first paren group", async () => {
    await seed("personal/entities.md", "# Entities\n\n### Acme (US) (vendor)\nstatus: active\n");
    await seed("personal/observations.md", "Acme delivered the integration notes\n");
    const cs = (await linkAudit()).candidates;
    expect(cs).toContainEqual(expect.objectContaining({ source_path: "personal/observations.md", line: 1, entity_name: "Acme", target_link: "personal/entities#Acme" }));
    expect(cs.some((c) => c.entity_name === "Acme (US)")).toBe(false);
  });
});

describe("scenario_check", () => {
  function scenario(check: string, status = "active") { return `---\ntype: scenario\n${status ? `status: ${status}\n` : ""}${check ? `check-by: ${check}\n` : ""}---\n# Scenario body\n`; }
  test("TestScenarioCheckClassifiesByDate / ReturnsScheduledEntries / EmptyArray", async () => {
    vi.setSystemTime(new Date("2026-06-01T12:00:00Z"));
    await seed("cog-meta/scenarios/overdue.md", scenario("2026-05-20"));
    await seed("cog-meta/scenarios/due-now.md", scenario("2026-06-01"));
    await seed("cog-meta/scenarios/upcoming.md", scenario("2026-06-15"));
    await seed("cog-meta/scenarios/no-status.md", scenario("2026-06-10", ""));
    await seed("cog-meta/scenarios/resolved.md", scenario("2026-05-01", "resolved"));
    await seed("cog-meta/scenarios/no-check-by.md", scenario(""));
    await seed("cog-meta/scenarios/bad-date.md", scenario("not-a-date"));
    await seed("cog-meta/scenarios/no-frontmatter.md", "# bare scenario\n");
    await seed("cog-meta/scenarios/notes.txt", "irrelevant\n");
    expect((await scenarioCheck()).scenarios).toEqual([
      { path: "cog-meta/scenarios/due-now.md", check_by: "2026-06-01", due: "2026-06-01", status: "due_now", days_until_check: 0 },
      { path: "cog-meta/scenarios/no-status.md", check_by: "2026-06-10", due: "2026-06-10", status: "active", days_until_check: 9 },
      { path: "cog-meta/scenarios/overdue.md", check_by: "2026-05-20", due: "2026-05-20", status: "overdue", days_until_check: -12 },
      { path: "cog-meta/scenarios/upcoming.md", check_by: "2026-06-15", due: "2026-06-15", status: "active", days_until_check: 14 },
    ]);
  });
  test("TestScenarioCheckMissingDirReturnsEmpty / strict params", async () => {
    await rm(join(root, "cog-meta"), { recursive: true, force: true });
    expect((await scenarioCheck()).scenarios).toEqual([]);
    await expect(scenarioCheck({ role: "siona" } as never)).rejects.toThrow(/unknown param/);
  });
});
