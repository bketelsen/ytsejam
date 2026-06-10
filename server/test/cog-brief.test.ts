import { describe, expect, test } from "vitest";
import { CogBriefProvider } from "../src/cog/brief.ts";
import type { CogClient, SessionBrief } from "../src/cog/client.ts";

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

function fakeClient(impl: () => Promise<SessionBrief>): { client: CogClient; calls: () => number } {
  let n = 0;
  const client = {
    socketPath: "/tmp/fake-cog.sock",
    sessionBrief: async () => {
      n++;
      return impl();
    },
  } as unknown as CogClient;
  return { client, calls: () => n };
}

describe("CogBriefProvider", () => {
  test("renders conventions, brief content, domain table with paths, and action counts", async () => {
    const { client } = fakeClient(async () => BRIEF);
    const section = await new CogBriefProvider(client, "agent").promptSection();
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

  test("caches within the TTL", async () => {
    const { client, calls } = fakeClient(async () => BRIEF);
    const provider = new CogBriefProvider(client, "agent", { ttlMs: 60_000 });
    await provider.promptSection();
    await provider.promptSection();
    expect(calls()).toBe(1);
  });

  test("surfaces controller_last_error as a warning", async () => {
    const { client } = fakeClient(async () => ({ ...BRIEF, controller_last_error: "bad yaml" }));
    const section = await new CogBriefProvider(client, "agent").promptSection();
    expect(section).toContain("bad yaml");
  });

  test("daemon unreachable with no prior brief renders the fallback", async () => {
    const { client } = fakeClient(async () => {
      throw new Error("cog memory daemon not reachable at /tmp/fake-cog.sock");
    });
    const section = await new CogBriefProvider(client, "agent").promptSection();
    expect(section).toContain("## Memory (cog)");
    expect(section).toContain("/tmp/fake-cog.sock");
    expect(section.toLowerCase()).toContain("unreachable");
  });

  test("daemon failure after a good brief serves the stale brief with a note", async () => {
    let fail = false;
    const { client } = fakeClient(async () => {
      if (fail) throw new Error("down");
      return BRIEF;
    });
    const provider = new CogBriefProvider(client, "agent", { ttlMs: 1 });
    await provider.promptSection();
    fail = true;
    await new Promise((r) => setTimeout(r, 5));
    const section = await provider.promptSection();
    expect(section).toContain("HOTMARK");
    expect(section.toLowerCase()).toContain("stale");
  });

  test("a hung daemon is cut off by the fetch cap", async () => {
    const { client } = fakeClient(() => new Promise(() => {}));
    const provider = new CogBriefProvider(client, "agent", { timeoutMs: 50 });
    const section = await provider.promptSection();
    expect(section.toLowerCase()).toContain("unreachable");
  });
});
