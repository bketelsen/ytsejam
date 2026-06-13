import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemorySystem } from "../src/api/memory-system.ts";
import { resolveRootSession } from "../src/session/reader.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ltm-test-"));
}

const PARENT_ID = "aaaaaaaa-0000-7000-8000-000000000001";
const CHILD_ID = "bbbbbbbb-0000-7000-8000-000000000002";

function writeFixtures(dir: string): { parent: string; child: string } {
  const parent = path.join(dir, "parent.jsonl");
  const child = path.join(dir, "child.jsonl");
  fs.writeFileSync(
    parent,
    [
      JSON.stringify({ type: "session", version: 3, id: PARENT_ID, timestamp: "2026-05-01T10:00:00.000Z", cwd: "/home/user" }),
      JSON.stringify({
        type: "message",
        id: "p0000001",
        parentId: null,
        timestamp: "2026-05-01T10:00:05.000Z",
        message: { role: "user", content: "Research lactose-free recipes for me.", timestamp: 1777723205000 },
      }),
    ].join("\n") + "\n",
  );
  // Subagent session forked from the parent (relative parentSession path,
  // as pi-agent-core records it).
  fs.writeFileSync(
    child,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: CHILD_ID,
        timestamp: "2026-05-01T10:01:00.000Z",
        cwd: "/home/user",
        parentSession: "./parent.jsonl",
      }),
      JSON.stringify({
        type: "message",
        id: "c0000001",
        parentId: null,
        timestamp: "2026-05-01T10:01:05.000Z",
        message: {
          role: "user",
          content: "Context: I am lactose intolerant and I love oat milk. Find recipes.",
          timestamp: 1777723265000,
        },
      }),
    ].join("\n") + "\n",
  );
  return { parent, child };
}

describe("fork provenance (PLAN 2.7)", () => {
  it("resolves the root of a fork chain, tolerating missing links", () => {
    const dir = tmpDir();
    const { child } = writeFixtures(dir);
    expect(resolveRootSession(child, "./parent.jsonl").rootSessionId).toBe(PARENT_ID);
    expect(resolveRootSession(child, "./nope.jsonl").rootSessionId).toBeUndefined();
    expect(resolveRootSession(child, undefined).rootSessionId).toBeUndefined();
  });

  it("facts stated in a subagent session attribute to the parent session's user", async () => {
    const dir = tmpDir();
    const { parent, child } = writeFixtures(dir);
    const mem = MemorySystem.open({ storeDir: path.join(dir, "store"), now: () => "2026-05-02T00:00:00.000Z" });
    await mem.ingestSessionFile(parent);
    await mem.ingestSessionFile(child);

    const fact = mem.listFacts().find((f) => f.objectNorm.includes("oat milk"));
    expect(fact).toBeDefined();
    // Source keeps the literal location (the subagent session) for
    // redaction, plus the root the knowledge belongs to.
    expect(fact!.sources[0].sessionId).toBe(CHILD_ID);
    expect(fact!.sources[0].rootSessionId).toBe(PARENT_ID);

    // Entities associate with the parent session, not a phantom subagent.
    const entity = mem.listEntities().find((e) => e.norm === "oat milk");
    if (entity) {
      expect(entity.sessionIds).toContain(PARENT_ID);
      expect(entity.sessionIds).not.toContain(CHILD_ID);
    }

    // Redaction by the subagent session still finds the fact via its source.
    await mem.redact({ sessionId: CHILD_ID });
    expect(mem.listFacts().find((f) => f.objectNorm.includes("oat milk"))).toBeUndefined();
  });
});
