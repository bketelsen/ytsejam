import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { composeSystemPrompt, PersonaStore } from "../src/persona.ts";

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

describe("composeSystemPrompt", () => {
  test("persona first, then harness section with date and data dir", () => {
    const prompt = composeSystemPrompt("You are Jeeves.", {
      dataDir: "/data",
      now: new Date("2026-06-09T12:00:00Z"),
    });
    expect(prompt.indexOf("Jeeves")).toBeLessThan(prompt.indexOf("2026-06-09"));
    expect(prompt).toContain("/data");
    expect(prompt).toContain("web_search");
  });
});
