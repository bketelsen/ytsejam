import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { domainSummary, housekeepingScan, openActions, recentObservations, sessionBrief } from "../../src/memory/index.ts";
import { parseObservationLine, primaryTagFromObservationLine } from "../../src/memory/consolidated/observations-parser.ts";
import type { HousekeepingCaps, HousekeepingThresholds } from "../../src/memory/types.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ytsejam-consolidated-"));
  process.env.YTSEJAM_MEMORY_DIR = root;
  await seed("domains.yml", `version: 1
domains:
  - id: dakota
    path: projects/dakota
    label: Dakota
    triggers: [dakota]
    files: [hot-memory, action-items, observations]
  - id: personal
    path: personal
    label: Personal
    triggers: [personal]
    files: [hot-memory, action-items, observations, entities]
  - id: work
    path: work/acme
    label: Work
    files: [hot-memory, action-items, observations]
`);
});
afterEach(async () => {
  vi.useRealTimers();
  delete process.env.YTSEJAM_MEMORY_DIR;
  if (root) await rm(root, { recursive: true, force: true });
});

async function seed(rel: string, content: string) {
  const abs = join(root, ...rel.split("/"));
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
}
async function touch(rel: string, date: Date) { await utimes(join(root, ...rel.split("/")), date, date); }
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
const ymdDaysAgo = (n: number) => daysAgo(n).toISOString().slice(0, 10);

describe("parseObservationLine", () => {
  const parse = (raw: string) => parseObservationLine("personal", "personal/observations.md", 7, raw);

  test("parses single-bracket comma-separated tags", () => {
    expect(parse("- 2026-06-13 [a, b]: comma tags")?.tags).toEqual(["a", "b"]);
  });

  test("parses two adjacent brackets", () => {
    expect(parse("- 2026-06-13 [a][b]: adjacent tags")?.tags).toEqual(["a", "b"]);
  });

  test("parses three adjacent brackets", () => {
    expect(parse("- 2026-06-13 [a][b][c]: adjacent tags")?.tags).toEqual(["a", "b", "c"]);
  });

  test("parses mixed bracket forms", () => {
    expect(parse("- 2026-06-13 [a, b][c]: mixed tags")?.tags).toEqual(["a", "b", "c"]);
  });

  test("parses mixed bracket forms both multi", () => {
    expect(parse("- 2026-06-13 [a, b][c, d]: mixed tags")?.tags).toEqual(["a", "b", "c", "d"]);
  });

  test("trims whitespace within multi-bracket tags", () => {
    expect(parse("- 2026-06-13 [  a  ][ b ]: spaced tags")?.tags).toEqual(["a", "b"]);
  });

  test("rejects empty bracket", () => {
    expect(parse("- 2026-06-13 []: no tags")).toBeNull();
  });

  test("rejects whitespace-only bracket", () => {
    expect(parse("- 2026-06-13 [   ]: no tags")).toBeNull();
  });

  test("rejects line with no bracket block", () => {
    expect(parse("- 2026-06-13: missing tags")).toBeNull();
  });

  test("rejects invalid date 2026-13-99", () => {
    expect(parse("- 2026-13-99 [x]: bad month and day")).toBeNull();
  });

  test("primaryTagFromObservationLine reads multi-bracket primary tag", () => {
    expect(primaryTagFromObservationLine("- 2026-06-13 [a][b]: adjacent tags")).toBe("a");
  });
});

describe("memory consolidated PR-2a", () => {
  test("sessionBrief returns hot memory, patterns, domains, action counts, and high-priority flag", async () => {
    await seed("hot-memory.md", "# Hot\nstrategic state\n");
    await seed("cog-meta/patterns.md", "# Patterns\nrule one\n");
    await seed("projects/dakota/action-items.md", "- [ ] dakota task | pri:high\n- [ ] another | pri:medium\n");
    await seed("personal/action-items.md", "- [ ] private | pri:low\n");
    await seed("work/acme/action-items.md", "- [ ] acme task | priority:high\n");

    const r = await sessionBrief();
    expect(r.hot_memory).toContain("strategic state");
    expect(r.patterns).toContain("rule one");
    expect(r.domains.map((d) => d.id)).toEqual(["dakota", "personal", "work"]);
    expect(r.domains.find((d) => d.id === "dakota")?.path).toBe("projects/dakota");
    expect(r.action_counts).toMatchObject({ dakota: 2, personal: 1, work: 1, _pri_high_anywhere: true });
    expect(r.controller_last_error).toBeNull();
  });

  test("sessionBrief missing canonical files return empty strings and non-null count map", async () => {
    const r = await sessionBrief();
    expect(r.hot_memory).toBe("");
    expect(r.patterns).toBe("");
    expect(r.action_counts._pri_high_anywhere).toBe(false);
  });

  test("sessionBrief counts ignore completed, comments, and fenced examples", async () => {
    await seed("projects/dakota/action-items.md", [
      "- [ ] one | pri:high", "- [ ] two | pri:medium", "- [x] done", "<!--", "- [ ] commented", "-->", "```", "- [ ] code", "```", "",
    ].join("\n"));
    const r = await sessionBrief();
    expect(r.action_counts.dakota).toBe(2);
    expect(r.action_counts._pri_high_anywhere).toBe(true);
  });

  test("openActions returns unchecked items with metadata from controller targets", async () => {
    await seed("projects/dakota/action-items.md", [
      "# Dakota Actions", "", "<!-- Format: - [ ] template | due:YYYY-MM-DD | pri:high -->",
      "- [ ] Ship open-actions RPC | due:2026-06-01 | pri:high | added:2026-05-30", "- [x] Closed task | pri:low",
    ].join("\n"));
    await seed("personal/action-items.md", "- [ ] Private task | pri:medium\n");
    const r = await openActions();
    expect(r.items.map((i) => `${i.domain}:${i.text}`)).toEqual(["personal:Private task", "dakota:Ship open-actions RPC"]);
    expect(r.items[1]).toMatchObject({ domain: "dakota", path: "projects/dakota/action-items.md", line: 4, text: "Ship open-actions RPC", due: "2026-06-01", priority: "high", added: "2026-05-30" });
  });

  test("openActions returns an empty array and supports domain filter", async () => {
    expect((await openActions()).items).toEqual([]);
    await seed("projects/dakota/action-items.md", "- [ ] dakota task\n");
    await seed("personal/action-items.md", "- [ ] personal task\n");
    const scoped = await openActions({ domain: "dakota" });
    expect(scoped.items).toHaveLength(1);
    expect(scoped.items[0]).toMatchObject({ domain: "dakota", text: "dakota task" });
    await expect(openActions({ domain: "ghost" })).rejects.toThrow(/unknown id/);
  });

  test("openActions domain comes from controller path, not leaf basename", async () => {
    await seed("work/acme/action-items.md", "- [ ] work task\n");
    expect((await openActions({ domain: "work" })).items[0].domain).toBe("work");
  });

  test("recentObservations happy path sorts newest-first and aggregates", async () => {
    await seed("personal/observations.md", ["# Observations", "", "- 2026-05-28 [health, milestone]: walked 10k", "- 2026-05-29 [health]: slept 8h", "- 2026-05-20 [old]: pre-window entry", ""].join("\n"));
    await seed("work/acme/observations.md", "- 2026-05-29 [milestone]: shipped pr\n");
    const r = await recentObservations({ since: "2026-05-27" });
    expect(r.since).toBe("2026-05-27");
    expect(r.entries).toHaveLength(3);
    expect(r.entries[0].date).toBe("2026-05-29");
    expect(r.by_domain).toMatchObject({ personal: 2, work: 1 });
    expect(r.by_tag).toMatchObject({ health: 2, milestone: 2 });
    expect(r.entries.find((e) => e.text === "walked 10k")?.tags).toEqual(["health", "milestone"]);
  });

  test("recentObservations filters by tag and by canonical domain param", async () => {
    await seed("personal/observations.md", "- 2026-05-28 [health]: a\n- 2026-05-29 [milestone]: b\n");
    await seed("work/acme/observations.md", "- 2026-05-29 [health]: w\n");
    const byTag = await recentObservations({ since: "2026-05-01", by_tag: "health" });
    expect(byTag.entries.map((e) => e.text)).toEqual(["w", "a"]);
    expect(byTag.by_tag).toEqual({ health: 2 });
    const byDomain = await recentObservations({ since: "2026-05-01", domain: "personal" });
    expect(byDomain.entries.map((e) => e.domain)).toEqual(["personal", "personal"]);
    expect(byDomain.by_domain).toEqual({ personal: 2 });
  });

  test("recentObservations rejects by_domain alias, invalid since, unknown domain, and skips fences", async () => {
    await seed("personal/observations.md", "- 2026-05-29 [real]: actual\n```\n- 2026-05-29 [fake]: code\n```\n");
    expect((await recentObservations({ since: "2026-05-01" })).entries.map((e) => e.tags[0])).toEqual(["real"]);
    await expect(recentObservations({ by_domain: "personal" } as never)).rejects.toThrow(/unknown param key: by_domain/);
    await expect(recentObservations({ since: "yesterday" })).rejects.toThrow(/unrecognized/);
    await expect(recentObservations({ domain: "ghost" })).rejects.toThrow(/unknown id/);
  });

  test("recentObservations default since is seven days and empty shapes are stable", async () => {
    await seed("personal/observations.md", `- ${ymdDaysAgo(30)} [x]: old\n- ${ymdDaysAgo(0)} [x]: new\n`);
    const r = await recentObservations();
    expect(r.entries.map((e) => e.text)).toEqual(["new"]);
    expect(r.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const empty = await recentObservations({ since: "2099-01-01" });
    expect(empty).toMatchObject({ entries: [], by_domain: {}, by_tag: {} });
  });

  test("recentObservations accepts duration since forms", async () => {
    await seed("personal/observations.md", "- 2026-05-29 [health]: slept 8h\n");
    for (const since of ["365d", "8760h"]) {
      const r = await recentObservations({ since });
      expect(r.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test("resolveSince rejects composite Go durations (intentional divergence)", async () => {
    // Go's time.ParseDuration accepts these; we deliberately don't.
    await expect(recentObservations({ since: "1h30m" })).rejects.toThrow(/unrecognized.*since.*value/);
    await expect(recentObservations({ since: "2h45m30s" })).rejects.toThrow(/unrecognized.*since.*value/);
    await expect(recentObservations({ since: "100ms" })).rejects.toThrow(/unrecognized.*since.*value/);
  });

  test("domainSummary happy path", async () => {
    await seed("personal/hot-memory.md", "personal hot memory body\n");
    await seed("personal/action-items.md", "## Open\n- [ ] open task one | added:2026-05-25\n- [ ] open task two\n\n## Completed\n- [x] recent completed | added:2026-05-28\n- [x] ancient completed | added:2026-01-01\n- [x] undated completed\n");
    await seed("personal/observations.md", "- 2026-05-28 [milestone,personal]: shipped the thing\n- 2026-04-01 [chore]: stale entry\n");
    await seed("personal/entities.md", "### Sierra\n");
    const r = await domainSummary({ domain: "personal", since: "2026-05-15" });
    expect(r).toMatchObject({ domain: "personal", path: "personal", label: "Personal", hot_memory: "personal hot memory body\n", open_action_count: 2, completed_action_count_since: 1, since: "2026-05-15" });
    expect(r.recent_observations.map((o) => o.date)).toEqual(["2026-05-28"]);
    expect(r.recent_observations[0].tags).toEqual(["milestone", "personal"]);
    expect(r.files_present).toEqual(["hot-memory", "action-items", "observations", "entities"]);
    expect(r.last_activity).not.toBe("");
  });

  test("domainSummary INCLUDES fenced/commented observation lines (Go parity)", async () => {
    // Distinct from recentObservations which skips fenced lines.
    // Matches Go's RecentObservationsForFile (single-file, no fence-skip).
    await seed("personal/observations.md", [
      "- 2026-06-12 [insight]: clean obs",
      "```",
      "- 2026-06-12 [insight]: fenced obs",
      "```",
      "<!--",
      "- 2026-06-12 [insight]: commented obs",
      "-->",
      "",
    ].join("\n"));

    const r = await domainSummary({ domain: "personal", since: "2026-06-01" });

    expect(r.recent_observations.map((o) => o.text)).toEqual(["clean obs", "fenced obs", "commented obs"]);
  });

  test("domainSummary default/duration since, missing files, unknown domain, hot-reloaded manifest", async () => {
    await seed("personal/hot-memory.md", "only this\n");
    const missing = await domainSummary({ domain: "personal" });
    expect(missing.since).toBe(ymdDaysAgo(7));
    expect(missing.files_present).toEqual(["hot-memory"]);
    expect(missing.recent_observations).toEqual([]);
    for (const since of ["7d", "168h", "2026-05-15", "2026-05-15T00:00:00Z"]) await expect(domainSummary({ domain: "personal", since })).resolves.toBeTruthy();
    await expect(domainSummary({ domain: "ghost" })).rejects.toThrow(/unknown id/);
    await expect(domainSummary({ domain: "personal", since: "garbage" })).rejects.toThrow(/unrecognized/);
    await seed("domains.yml", "version: 1\ndomains:\n  - id: personal\n    path: personal\n    label: Personal Renamed\n    files: [hot-memory]\n");
    await touch("domains.yml", new Date(Date.now() + 2000));
    expect((await domainSummary({ domain: "personal" })).label).toBe("Personal Renamed");
  });

  test("housekeepingScan empty envelope", async () => {
    const r = await housekeepingScan();
    expect(r.changed_recently).toEqual(["domains.yml"]);
    expect(r.dormant_domains).toEqual([]);
    expect(r.stale_action_items).toEqual([]);
    expect(r.thresholds).toMatchObject({ observations_over_cap: [], completed_actions_over_cap: [], improvements_implemented_over_cap: [], hot_memory_over_cap: [], patterns_over_cap: [] });
  });


  test("housekeepingScan marks observation on exact 28-day boundary dormant", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T14:30:00Z"));
    await seed("personal/observations.md", "- 2026-05-15 [health]: boundary observation\n");

    const r = await housekeepingScan();

    expect(r.dormant_domains).toContainEqual({ id: "personal", last_observation: "2026-05-15" });
  });

  test("housekeepingScan observations over cap aggregates primary tag and detects dormancy", async () => {
    await seed("personal/observations.md", Array.from({ length: 30 }, () => "- 2026-05-01 [health, body]: line").concat(Array.from({ length: 25 }, () => "- 2026-05-02 [milestone]: line")).join("\n") + "\n");
    await seed("work/acme/observations.md", `- ${ymdDaysAgo(60)} [milestone]: ancient win\n`);
    const r = await housekeepingScan();
    expect(r.thresholds.observations_over_cap[0]).toMatchObject({ path: "personal/observations.md", entries: 55, cap: 50, by_primary_tag: { health: 30, milestone: 25 } });
    expect(r.dormant_domains.find((d) => d.id === "work")?.last_observation).toBe(ymdDaysAgo(60));
  });

  test("HousekeepingCaps shape includes tiered patterns caps", () => {
    // Type-only assertion via const literal — fails tsc if shape is wrong.
    const _capsShape: Pick<HousekeepingCaps,
      "global_patterns_lines" | "global_patterns_bytes" |
      "domain_patterns_lines" | "domain_patterns_bytes"> = {
      global_patterns_lines: 70,
      global_patterns_bytes: 6000,
      domain_patterns_lines: 40,
      domain_patterns_bytes: 3500,
    };
    expect(_capsShape.global_patterns_bytes).toBe(6000);
  });

  test("HousekeepingThresholds shape includes domain_patterns_over_cap", () => {
    const _t: Pick<HousekeepingThresholds, "domain_patterns_over_cap"> = {
      domain_patterns_over_cap: [],
    };
    expect(_t.domain_patterns_over_cap).toEqual([]);
  });

  test("housekeepingScan flags per-domain patterns.md over byte cap", async () => {
    await seed("cog-meta/patterns.md", "ok\n");
    await seed("projects/ytsejam/patterns.md", "y".repeat(5000) + "\n");
    const r = await housekeepingScan();
    expect(r.thresholds.domain_patterns_over_cap).toHaveLength(1);
    expect(r.thresholds.domain_patterns_over_cap[0]).toMatchObject({
      path: "projects/ytsejam/patterns.md",
      size_cap: 3500,
    });
    expect(r.thresholds.domain_patterns_over_cap[0].size).toBeGreaterThan(3500);
  });

  test("housekeepingScan flags per-domain patterns.md over line cap", async () => {
    await seed("cog-meta/patterns.md", "ok\n");
    await seed("personal/patterns.md", "line\n".repeat(50));
    const r = await housekeepingScan();
    expect(r.thresholds.domain_patterns_over_cap).toHaveLength(1);
    expect(r.thresholds.domain_patterns_over_cap[0]).toMatchObject({
      path: "personal/patterns.md",
      lines_cap: 40,
    });
    expect(r.thresholds.domain_patterns_over_cap[0].lines).toBeGreaterThan(40);
  });

  test("housekeepingScan does NOT flag cog-meta/patterns.md or glacier/**/patterns.md as domain patterns", async () => {
    await seed("cog-meta/patterns.md", "x".repeat(100));
    await seed("glacier/projects/foo/patterns.md", "y".repeat(10000));  // over any cap, but should be skipped
    const r = await housekeepingScan();
    expect(r.thresholds.domain_patterns_over_cap).toEqual([]);
  });

  test("housekeepingScan returns empty domain_patterns_over_cap when no domain patterns files exist", async () => {
    await seed("cog-meta/patterns.md", "ok\n");
    const r = await housekeepingScan();
    expect(r.thresholds.domain_patterns_over_cap).toEqual([]);
  });

  test("housekeepingScan action completed cap, stale items, hot-memory, patterns, and improvements", async () => {
    await seed("personal/action-items.md", Array.from({ length: 12 }, () => "- [x] done thing").concat([`- [ ] revive backups | added:${ymdDaysAgo(30)} | pri:high`, `- [ ] write doc | added:${ymdDaysAgo(3)}`]).join("\n") + "\n");
    await seed("hot-memory.md", "line\n".repeat(60));
    await seed("personal/hot-memory.md", "line\n".repeat(60));
    await seed("cog-meta/patterns.md", "x".repeat(7000) + "\n");
    await seed("cog-meta/improvements.md", Array.from({ length: 15 }, () => "- [x] shipped thing").join("\n") + "\n");
    const r = await housekeepingScan();
    expect(r.thresholds.completed_actions_over_cap[0]).toMatchObject({ path: "personal/action-items.md", completed: 12, cap: 10 });
    expect(r.stale_action_items[0]).toMatchObject({ path: "personal/action-items.md", text: "revive backups", added: ymdDaysAgo(30) });
    expect(r.stale_action_items[0].age_days).toBeGreaterThanOrEqual(29);
    expect(Object.fromEntries(r.thresholds.hot_memory_over_cap.map((v) => [v.path, v.lines]))).toMatchObject({ "hot-memory.md": 60, "personal/hot-memory.md": 60 });
    expect(r.thresholds.patterns_over_cap[0].size).toBeGreaterThan(r.thresholds.patterns_over_cap[0].size_cap);
    expect(r.thresholds.improvements_implemented_over_cap[0]).toMatchObject({ path: "cog-meta/improvements.md", implemented: 15, cap: 10 });
  });

  test("housekeepingScan changed_recently honors marker", async () => {
    await seed("personal/entities.md", "old\n");
    await touch("personal/entities.md", daysAgo(2));
    await seed("personal/hot-memory.md", "fresh\n");
    await seed("cog-meta/.housekeeping-marker", "");
    await touch("cog-meta/.housekeeping-marker", daysAgo(1 / 24));
    const r = await housekeepingScan();
    expect(r.since).not.toBe("");
    expect(r.changed_recently).toContain("personal/hot-memory.md");
    expect(r.changed_recently).not.toContain("personal/entities.md");
    expect(r.changed_recently).not.toContain("cog-meta/.housekeeping-marker");
  });

  test("strict params reject unknown keys for all PR-2a public functions", async () => {
    await expect(sessionBrief({ bogus: true } as never)).rejects.toThrow(/unknown param key: bogus/);
    await expect(housekeepingScan({ bogus: true } as never)).rejects.toThrow(/unknown param key: bogus/);
    await expect(openActions({ bogus: true } as never)).rejects.toThrow(/unknown param key: bogus/);
    await expect(domainSummary({ domain: "personal", bogus: true } as never)).rejects.toThrow(/unknown param key: bogus/);
    await expect(recentObservations({ days: 14 } as never)).rejects.toThrow(/unknown param key: days/);
  });
});
