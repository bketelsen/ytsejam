import { describe, it, expect } from "vitest";
import { validateManifestContent } from "../src/memory/domain/manifest.ts";

describe("domain workingDir", () => {
  it("parses an optional absolute workingDir", () => {
    const [d] = validateManifestContent(`domains:\n  - id: ytsejam\n    path: projects/ytsejam\n    workingDir: /home/bjk/projects/ytsejam\n`);
    expect(d.workingDir).toBe("/home/bjk/projects/ytsejam");
  });
  it("omits workingDir when absent", () => {
    const [d] = validateManifestContent(`domains:\n  - id: work\n    path: work\n`);
    expect(d.workingDir).toBeUndefined();
  });
  it("rejects a non-absolute workingDir", () => {
    expect(() => validateManifestContent(`domains:\n  - id: x\n    path: x\n    workingDir: relative/dir\n`)).toThrow(/workingDir/);
  });
});
