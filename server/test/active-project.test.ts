// server/test/active-project.test.ts
import { describe, it, expect } from "vitest";
import { projectTagForWorkdir } from "../src/memory/active-project.ts";
import type { Domain } from "../src/memory/types.ts";

const domains: Domain[] = [
  { id: "ytsejam", path: "projects/ytsejam", workingDir: "/home/bjk/projects/ytsejam" },
  { id: "mcp", path: "projects/truenas-mcp", workingDir: "/home/bjk/projects/truenas-mcp" },
  { id: "work", path: "work" }, // no workingDir
];

describe("projectTagForWorkdir", () => {
  it("maps an exact workdir to its domain tag", () => {
    expect(projectTagForWorkdir(domains, "/home/bjk/projects/ytsejam")).toBe("projects:ytsejam");
  });
  it("maps a nested subdir to the nearest-ancestor domain", () => {
    expect(projectTagForWorkdir(domains, "/home/bjk/projects/ytsejam/server/src")).toBe("projects:ytsejam");
  });
  it("returns null for an unmapped dir", () => {
    expect(projectTagForWorkdir(domains, "/home/bjk/.ytsejam/data")).toBeNull();
  });
  it("ignores domains without workingDir", () => {
    expect(projectTagForWorkdir(domains, "/home/bjk/work")).toBeNull();
  });
});
