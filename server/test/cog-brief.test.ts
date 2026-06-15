import { describe, expect, test, vi } from "vitest";
import { CogBriefProvider } from "../src/cog/brief.ts";
import type { SessionBrief } from "../src/memory/index.ts";
import * as memory from "../src/memory/index.ts";

const BRIEF: SessionBrief = {
  hot_memory: "# Hot\ncurrent strategic state HOTMARK",
  patterns: "# Patterns\n- always PATMARK",
  domains: [
    { id: "personal", path: "personal", label: "Family", triggers: ["family", "home"] },
    { id: "dakota", path: "projects/dakota", label: "Dakota", triggers: ["dakota"] },
  ],
  action_counts: { personal: 4, dakota: 1, _pri_high_anywhere: true },
  controller_last_error: null,
};

function mockSessionBrief(impl: () => Promise<SessionBrief>) {
  return vi.spyOn(memory, "sessionBrief").mockImplementation(impl);
}

describe("CogBriefProvider", () => {
  test("renders conventions, brief content, domain table with paths, and action counts", async () => {
    mockSessionBrief(async () => BRIEF);
    const section = await new CogBriefProvider().promptSection();
    expect(section).toContain("## Memory (cog)");
    // full CLAUDE.md-equivalent conventions, not just formats
    expect(section).toContain("SSOT");
    expect(section).toMatch(/L0/);
    expect(section).toMatch(/append-only/i);
    expect(section).toMatch(/glacier/i);
    expect(section).toMatch(/never.*\bid\b/is); // path-never-id rule
    expect(section).toMatch(/housekeeping.*reflect/is); // pipeline cadence guidance
    // dynamic brief
    expect(section).toContain("HOTMARK");
    expect(section).toContain("PATMARK");
    expect(section).toContain("projects/dakota");
    expect(section).toContain("family");
    expect(section).toMatch(/personal:\s*4/);
    expect(section).toMatch(/high-priority/i);
  });

  test("renders decisions kind in conventions (numbered rule, edit-patterns row, glacier threshold)", async () => {
    mockSessionBrief(async () => BRIEF);
    const section = await new CogBriefProvider().promptSection();

    // Numbered rule for decisions.md, appended as #9 after the existing 8 rules
    expect(section).toMatch(/9\.\s+decisions\.md/);
    expect(section).toMatch(/\[d-<slug>\]/);
    expect(section).toMatch(/supersedes/);

    // File-edit-patterns table row
    expect(section).toMatch(/\| decisions\.md \|.*[Ss]upersede/);

    // Glacier threshold mention (100 entries OR 6 months; live non-superseded never glaciered)
    expect(section).toMatch(/decisions\.md.*100 entries/);
    expect(section).toMatch(/6 months/i);
    expect(section).toMatch(/live.*non-superseded.*never/i);
  });

  test("caches within the TTL", async () => {
    const spy = mockSessionBrief(async () => BRIEF);
    const provider = new CogBriefProvider({ ttlMs: 60_000 });
    await provider.promptSection();
    await provider.promptSection();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("surfaces controller_last_error as a warning", async () => {
    mockSessionBrief(async () => ({ ...BRIEF, controller_last_error: "bad yaml" }));
    const section = await new CogBriefProvider().promptSection();
    expect(section).toContain("bad yaml");
  });

  test("memory unavailable with no prior brief renders the fallback", async () => {
    mockSessionBrief(async () => {
      throw new Error("memory unavailable");
    });
    const section = await new CogBriefProvider().promptSection();
    expect(section).toContain("## Memory (cog)");
    expect(section.toLowerCase()).toContain("temporarily unavailable");
  });

  test("memory failure after a good brief serves the stale brief with a note", async () => {
    let fail = false;
    mockSessionBrief(async () => {
      if (fail) throw new Error("down");
      return BRIEF;
    });
    const provider = new CogBriefProvider({ ttlMs: 1 });
    await provider.promptSection();
    fail = true;
    await new Promise((r) => setTimeout(r, 5));
    const section = await provider.promptSection();
    expect(section).toContain("HOTMARK");
    expect(section.toLowerCase()).toContain("stale");
  });

  test("a hung memory call is cut off by the fetch cap", async () => {
    mockSessionBrief(() => new Promise(() => {}));
    const provider = new CogBriefProvider({ timeoutMs: 50 });
    const section = await provider.promptSection();
    expect(section.toLowerCase()).toContain("temporarily unavailable");
  });
});

describe("audit regressions", () => {
  test("a transient failure does not poison the cache for the full TTL", async () => {
    let fail = true;
    mockSessionBrief(async () => {
      if (fail) throw new Error("momentarily busy");
      return BRIEF;
    });
    const provider = new CogBriefProvider({ ttlMs: 60_000, failureTtlMs: 10 });
    const first = await provider.promptSection();
    expect(first.toLowerCase()).toContain("temporarily unavailable");
    fail = false;
    await new Promise((r) => setTimeout(r, 30));
    const second = await provider.promptSection();
    expect(second).toContain("HOTMARK"); // recovered well before the 60s success TTL
  });

  test("concurrent cold-cache calls share one fetch", async () => {
    const spy = mockSessionBrief(
      () => new Promise((r) => setTimeout(() => r(BRIEF), 20)),
    );
    const provider = new CogBriefProvider();
    const [a, b, c] = await Promise.all([
      provider.promptSection(),
      provider.promptSection(),
      provider.promptSection(),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
