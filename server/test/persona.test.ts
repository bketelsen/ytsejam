import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { composeSystemPrompt, composeWorkerPrompt, PersonaStore } from "../src/persona.ts";

describe("PersonaStore", () => {
  test("creates default persona on first load, then round-trips edits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "persona-"));
    const store = new PersonaStore(dir);
    const initial = await store.load();
    expect(initial).toContain("personal assistant");
    await store.save("# Persona\nYou are Jeeves.");
    expect(await store.load()).toBe("# Persona\nYou are Jeeves.");
  });
});

describe("composeWorkerPrompt", () => {
  test("instructs workers to paraphrase sources instead of quoting at length", () => {
    const prompt = composeWorkerPrompt("You are Jeeves.", {
      dataDir: "/data",
      now: new Date("2026-06-09T12:00:00Z"),
    });
    expect(prompt).toContain("Paraphrase");
    expect(prompt.toLowerCase()).toContain("verbatim");
  });

  test("tells workers there is no approval gating inside a subagent", () => {
    const prompt = composeWorkerPrompt("You are Jeeves.", {
      dataDir: "/data",
      now: new Date("2026-06-09T12:00:00Z"),
    });
    // Approval gating is parent-only; subagents inherit nothing and always
    // run their tools. Stale vibe-only guidance must be gone.
    expect(prompt).toContain("no approval gating inside a subagent");
    expect(prompt).not.toContain("Be careful with destructive commands");
  });
});

describe("composeSystemPrompt", () => {
  test("persona first, then harness section with date and data dir", () => {
    const prompt = composeSystemPrompt("You are Jeeves.", {
      dataDir: "/data",
      now: new Date("2026-06-09T12:00:00Z"),
    });
    expect(prompt.indexOf("Jeeves")).toBeLessThan(prompt.indexOf("2026-06-09"));
    expect(prompt).toContain("/data");
    expect(prompt).toContain("web_search");
    expect(prompt).toContain("In ASK mode they pause for user approval; in YOLO mode they run immediately");
    expect(prompt).toContain("/yolo and /careful prefixes");
    expect(prompt).toContain("always run (memory writes are exempt from the approval gate by design)");
    expect(prompt).toContain("check_task");
    expect(prompt).toContain("recall");
    expect(prompt).not.toContain("never run them speculatively");
    expect(prompt).not.toContain("Be careful with destructive commands");
  });

  test("appends cog and skills sections when provided, omits them otherwise", () => {
    const bare = composeSystemPrompt("You are Jeeves.", { dataDir: "/data" });
    expect(bare).not.toContain("## Memory (cog)");
    expect(bare).not.toContain("## Skills");

    const full = composeSystemPrompt("You are Jeeves.", {
      dataDir: "/data",
      cogSection: "## Memory (cog)\nHOTMARK",
      skillsSection: "## Skills\nSKILLMARK",
    });
    expect(full.indexOf("Tool guidance")).toBeLessThan(full.indexOf("HOTMARK"));
    expect(full).toContain("HOTMARK");
    expect(full).toContain("SKILLMARK");
  });
});
