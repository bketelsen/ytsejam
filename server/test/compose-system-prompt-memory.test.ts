import { describe, it, expect } from "vitest";
import { composeSystemPrompt } from "../src/persona.ts";

describe("composeSystemPrompt memorySection", () => {
  it("includes the memory section when provided", () => {
    const out = composeSystemPrompt("PERSONA", { dataDir: "/tmp", memorySection: "What you know about the user:\n- identity: name Brian" });
    expect(out).toContain("name Brian");
  });
  it("omits cleanly when memorySection is undefined", () => {
    const out = composeSystemPrompt("PERSONA", { dataDir: "/tmp" });
    expect(out).not.toContain("What you know about the user");
  });
});
