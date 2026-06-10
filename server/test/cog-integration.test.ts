import { existsSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CogClient, CogRpcError } from "../src/cog/client.ts";

/**
 * Integration tests against a real cogmemory daemon. Skipped unless the
 * test-instance socket exists (COG_TEST_SOCKET overrides the default).
 */
const socketPath =
  process.env.COG_TEST_SOCKET ??
  join(os.homedir(), ".local/share/cogmemory-test/cog-memory-test.sock");
const role = process.env.COG_TEST_ROLE ?? "agent";

describe.skipIf(!existsSync(socketPath))("cogmemory integration", () => {
  const client = new CogClient({ socketPath });

  test("health responds", async () => {
    expect(await client.health()).toBe(true);
  });

  test("session_brief returns the envelope with domain paths", async () => {
    const brief = await client.sessionBrief(role);
    expect(typeof brief.hot_memory).toBe("string");
    expect(typeof brief.patterns).toBe("string");
    expect(Array.isArray(brief.domains)).toBe(true);
    for (const d of brief.domains) {
      expect(d.id).toBeTruthy();
      expect(d.path).toBeTruthy();
    }
    expect(brief.action_counts).toHaveProperty("_pri_high_anywhere");
  });

  test("read hot-memory.md", async () => {
    const r = await client.call<{ content: string }>("read", { role, path: "hot-memory.md" });
    expect(typeof r.content).toBe("string");
  });

  test("id-as-path writes are rejected with the corrective error", async () => {
    const brief = await client.sessionBrief(role);
    const victim = brief.domains.find(
      (d) => d.id !== d.path && !d.path.startsWith(`${d.id}/`),
    );
    if (!victim) return; // store has no nested domains to probe with
    const err: any = await client
      .call("write", { role, path: `${victim.id}/INDEX.md`, content: "# stray probe\n" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(CogRpcError);
    expect(err.code).toBe(-32602);
    expect(err.message).toContain(`lives at "${victim.path}"`);
  });

  test("oversized writes are rejected client-side before the daemon sees them", async () => {
    const err: any = await client
      .call("write", { role, path: "oversize-probe.md", content: "x".repeat(70_000) })
      .catch((e) => e);
    expect(err.message).toContain("too large");
  });
});
