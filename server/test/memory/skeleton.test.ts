import { describe, expect, test } from "vitest";
import * as memory from "../../src/memory/index.ts";
import { read } from "../../src/memory/index.ts";

const EXPORTS = [
  "read",
  "write",
  "append",
  "patch",
  "outline",
  "move",
  "list",
  "search",
  "stats",
  "health",
  "git",
  "loadManifest",
  "Controller",
  "sessionBrief",
  "housekeepingScan",
  "openActions",
  "domainSummary",
  "recentObservations",
  "clusterCheck",
  "entityAudit",
  "linkAudit",
  "linkIndexCompute",
  "scenarioCheck",
  "glacierIndexCompute",
  "wikiIndexCompute",
  "l0index",
] as const;

describe("memory module skeleton", () => {
  test("primitive stubs throw not implemented", async () => {
    await expect(read("anything")).rejects.toThrow(/not implemented/);
  });

  test("public surface exports every planned symbol", () => {
    for (const name of EXPORTS) {
      expect(memory[name]).toBeDefined();
    }
  });
});
