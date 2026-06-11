import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadContextFiles } from "../src/context-files.ts";
import { composeSystemPrompt, composeWorkerPrompt } from "../src/persona.ts";

function makeTree(): { home: string; root: string; level1: string; level2: string } {
  // structure:
  //   home/.pi/agent/AGENTS.md       (global)
  //   root/AGENTS.md                  (deep ancestor)
  //   root/level1/CLAUDE.md           (mid ancestor)
  //   root/level1/level2/AGENTS.md    (cwd)
  const base = mkdtempSync(join(tmpdir(), "cf-"));
  const home = join(base, "home");
  const piAgent = join(home, ".pi", "agent");
  mkdirSync(piAgent, { recursive: true });
  writeFileSync(join(piAgent, "AGENTS.md"), "GLOBAL_AGENTS");

  const root = join(base, "tree");
  const level1 = join(root, "level1");
  const level2 = join(level1, "level2");
  mkdirSync(level2, { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "ROOT_AGENTS");
  writeFileSync(join(level1, "CLAUDE.md"), "LEVEL1_CLAUDE");
  writeFileSync(join(level2, "AGENTS.md"), "LEVEL2_AGENTS");

  return { home, root, level1, level2 };
}

describe("loadContextFiles", () => {
  test("concatenates global → farthest ancestor → nearest → cwd in document order", async () => {
    const t = makeTree();
    const text = await loadContextFiles(t.level2, { home: t.home });

    const i1 = text.indexOf("GLOBAL_AGENTS");
    const i2 = text.indexOf("ROOT_AGENTS");
    const i3 = text.indexOf("LEVEL1_CLAUDE");
    const i4 = text.indexOf("LEVEL2_AGENTS");

    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
    expect(i4).toBeGreaterThan(i3);
  });

  test("matches AGENTS.md OR CLAUDE.md at any level", async () => {
    const t = makeTree();
    const text = await loadContextFiles(t.level2, { home: t.home });
    expect(text).toContain("LEVEL1_CLAUDE"); // CLAUDE.md picked up
    expect(text).toContain("LEVEL2_AGENTS"); // AGENTS.md picked up
  });

  test("returns empty string when nothing matches", async () => {
    const empty = mkdtempSync(join(tmpdir(), "cf-empty-"));
    const emptyHome = mkdtempSync(join(tmpdir(), "cf-eh-"));
    const text = await loadContextFiles(empty, { home: emptyHome });
    expect(text).toBe("");
  });

  test("returns empty string when disabled (--no-context-files)", async () => {
    const t = makeTree();
    const text = await loadContextFiles(t.level2, { home: t.home, disabled: true });
    expect(text).toBe("");
  });

  test("caps total size and appends a truncation note", async () => {
    const base = mkdtempSync(join(tmpdir(), "cf-big-"));
    const home = mkdtempSync(join(tmpdir(), "cf-bigh-"));
    const big = "X".repeat(50_000);
    writeFileSync(join(base, "AGENTS.md"), big);
    const text = await loadContextFiles(base, { home, max: 10_000 });
    expect(text.length).toBeLessThanOrEqual(10_500); // approx — small overhead for truncation note
    expect(text).toContain("[context files truncated");
  });

  test("missing files are skipped silently", async () => {
    const base = mkdtempSync(join(tmpdir(), "cf-mix-"));
    const home = mkdtempSync(join(tmpdir(), "cf-mixh-"));
    // only the deepest one exists
    writeFileSync(join(base, "AGENTS.md"), "ONLY_AGENTS");
    const text = await loadContextFiles(base, { home });
    expect(text).toContain("ONLY_AGENTS");
    expect(text).not.toContain("[context files truncated");
  });
});

describe("system / worker prompts inject context files", () => {
  test("composeSystemPrompt appends a clearly labeled section when contextFiles is non-empty", () => {
    const prompt = composeSystemPrompt("You are Jeeves.", {
      dataDir: "/data",
      now: new Date("2026-06-11T00:00:00Z"),
      contextFiles: "Project policy: use TypeScript strict mode.",
    });
    expect(prompt).toContain("## Project context files");
    expect(prompt).toContain("Project policy: use TypeScript strict mode.");
    // ordering: persona first, then env, then context files at the end
    expect(prompt.indexOf("Jeeves")).toBeLessThan(prompt.indexOf("## Project context files"));
  });

  test("composeSystemPrompt omits the section for empty / whitespace contextFiles", () => {
    const p1 = composeSystemPrompt("You are Jeeves.", { dataDir: "/data" });
    const p2 = composeSystemPrompt("You are Jeeves.", { dataDir: "/data", contextFiles: "" });
    const p3 = composeSystemPrompt("You are Jeeves.", { dataDir: "/data", contextFiles: "   \n\n" });
    for (const p of [p1, p2, p3]) {
      expect(p).not.toContain("## Project context files");
    }
  });

  test("composeWorkerPrompt mirrors the same injection", () => {
    const p = composeWorkerPrompt("You are Jeeves.", {
      dataDir: "/data",
      workdir: "/projects/x",
      contextFiles: "Subagent policy: paraphrase always.",
    });
    expect(p).toContain("## Project context files");
    expect(p).toContain("Subagent policy: paraphrase always.");

    const bare = composeWorkerPrompt("You are Jeeves.", { dataDir: "/data" });
    expect(bare).not.toContain("## Project context files");
  });
});
