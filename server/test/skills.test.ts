import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { SkillsStore } from "../src/skills.ts";
import { createSkillTool } from "../src/tools/skills.ts";

function dirs() {
  const base = mkdtempSync(join(tmpdir(), "skills-"));
  const skillsDir = join(base, "data", "skills");
  const seedDir = join(base, "seed");
  mkdirSync(seedDir, { recursive: true });
  return { skillsDir, seedDir };
}

const FRONTMATTER_SKILL = `---
name: reflect
description: >
  Mine recent activity for patterns,
  consolidate memory
triggers: [reflect, consolidate, patterns]
---

# Reflect

Do the reflect pipeline.
`;

const BARE_SKILL = `# History

Deep memory search and narrative reconstruction across observations and glacier.
`;

describe("SkillsStore", () => {
  test("seed copies files only when missing, preserving user edits", async () => {
    const { skillsDir, seedDir } = dirs();
    writeFileSync(join(seedDir, "reflect.md"), FRONTMATTER_SKILL);
    const store = new SkillsStore(skillsDir);
    await store.seed(seedDir);
    expect(readFileSync(join(skillsDir, "reflect.md"), "utf8")).toBe(FRONTMATTER_SKILL);

    writeFileSync(join(skillsDir, "reflect.md"), "user edited");
    writeFileSync(join(seedDir, "new.md"), BARE_SKILL);
    await store.seed(seedDir);
    expect(readFileSync(join(skillsDir, "reflect.md"), "utf8")).toBe("user edited");
    expect(readFileSync(join(skillsDir, "new.md"), "utf8")).toBe(BARE_SKILL);
  });

  test("list parses frontmatter name/description/triggers with folded values", async () => {
    const { skillsDir } = dirs();
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "reflect.md"), FRONTMATTER_SKILL);
    const [s] = await new SkillsStore(skillsDir).list();
    expect(s.name).toBe("reflect");
    expect(s.description).toBe("Mine recent activity for patterns, consolidate memory");
    expect(s.triggers).toEqual(["reflect", "consolidate", "patterns"]);
  });

  test("list falls back to filename and first body line without frontmatter", async () => {
    const { skillsDir } = dirs();
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "history.md"), BARE_SKILL);
    const [s] = await new SkillsStore(skillsDir).list();
    expect(s.name).toBe("history");
    expect(s.description).toContain("Deep memory search");
    expect(s.triggers).toEqual([]);
  });

  test("load returns full markdown; unknown names list what exists", async () => {
    const { skillsDir } = dirs();
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "reflect.md"), FRONTMATTER_SKILL);
    const store = new SkillsStore(skillsDir);
    expect(await store.load("reflect")).toBe(FRONTMATTER_SKILL);
    const err = await store.load("nope").catch((e) => e);
    expect(err.message).toContain("nope");
    expect(err.message).toContain("reflect");
  });

  test("promptSection renders a routing table with invoke-when guidance", async () => {
    const { skillsDir } = dirs();
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "reflect.md"), FRONTMATTER_SKILL);
    writeFileSync(join(skillsDir, "history.md"), BARE_SKILL);
    const section = await new SkillsStore(skillsDir).promptSection();
    expect(section).toContain("## Skills");
    expect(section).toContain("reflect");
    expect(section).toContain("consolidate"); // trigger surfaced as when-to-invoke
    expect(section).toContain("history");
    expect(section).toMatch(/skill/i); // mentions the skill tool
  });

  test("promptSection is empty when there are no skills", async () => {
    const { skillsDir } = dirs();
    expect(await new SkillsStore(skillsDir).promptSection()).toBe("");
  });
});

describe("skill tool", () => {
  test("returns the playbook content", async () => {
    const { skillsDir } = dirs();
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "reflect.md"), FRONTMATTER_SKILL);
    const r = await createSkillTool(new SkillsStore(skillsDir)).execute("t1", { name: "reflect" });
    expect((r.content[0] as any).text).toContain("Do the reflect pipeline");
  });
});
