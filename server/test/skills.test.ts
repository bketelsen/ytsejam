import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
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

describe("audit regressions", () => {
  test("pipe characters in description/triggers don't break the routing table", async () => {
    const { skillsDir } = dirs();
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, "piped.md"),
      `---\nname: piped\ndescription: does a | b routing\ntriggers: [x|y]\n---\n\nbody\n`,
    );
    const section = await new SkillsStore(skillsDir).promptSection();
    const row = section.split("\n").find((l) => l.includes("piped"))!;
    // unescaped pipes delimit exactly 3 cells: ["", name, purpose, when, ""]
    expect(row.split(/(?<!\\)\|/).length).toBe(5);
    expect(row).toContain("\\|");
  });

  test("quoted flow-list triggers lose their quotes", async () => {
    const { skillsDir } = dirs();
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, "quoted.md"),
      `---\nname: quoted\ndescription: q\ntriggers: ["remember when", 'timeline']\n---\n\nbody\n`,
    );
    const [s] = await new SkillsStore(skillsDir).list();
    expect(s.triggers).toEqual(["remember when", "timeline"]);
  });
});

const BUNDLED_SKILL = `---
name: foo
description: bundled foo skill
triggers: [foo, bundled]
---

# Foo

Body of the bundled foo skill.
`;

describe("SkillsStore — directory-bundled skills", () => {
  test("foo/SKILL.md is listed as 'foo' and loadable", async () => {
    const { skillsDir } = dirs();
    mkdirSync(join(skillsDir, "foo"), { recursive: true });
    writeFileSync(join(skillsDir, "foo", "SKILL.md"), BUNDLED_SKILL);
    const store = new SkillsStore(skillsDir);
    const summaries = await store.list();
    expect(summaries.map((s) => s.name)).toEqual(["foo"]);
    expect(summaries[0].description).toBe("bundled foo skill");
    expect(summaries[0].triggers).toEqual(["foo", "bundled"]);
    expect(await store.load("foo")).toBe(BUNDLED_SKILL);
  });

  test("bundled non-SKILL.md assets are NOT skills and not loadable", async () => {
    const { skillsDir } = dirs();
    mkdirSync(join(skillsDir, "foo"), { recursive: true });
    writeFileSync(join(skillsDir, "foo", "SKILL.md"), BUNDLED_SKILL);
    writeFileSync(join(skillsDir, "foo", "reference.md"), "# reference\nassets only\n");
    writeFileSync(join(skillsDir, "foo", "run.sh"), "#!/bin/sh\necho hi\n");
    const store = new SkillsStore(skillsDir);

    // listing surfaces only the bundle's invocation name, never the sibling md
    const names = (await store.list()).map((s) => s.name);
    expect(names).toEqual(["foo"]);
    expect(names).not.toContain("reference");

    // load("reference") — there is no top-level reference.md and no
    // reference/ dir, so this must be an unknown skill (the sibling md
    // is an asset, not a skill).
    const noSibling = await store.load("reference").catch((e) => e);
    expect(noSibling).toBeInstanceOf(Error);
    expect(noSibling.message).toMatch(/unknown skill "reference"/);

    // load("foo/reference") — the invocation name has a slash, which
    // must always be rejected as an invalid name (no path traversal,
    // and no slash-bearing skill names by design).
    const slashed = await store.load("foo/reference").catch((e) => e);
    expect(slashed).toBeInstanceOf(Error);
    expect(slashed.message).toMatch(/invalid skill name/);
  });

  test("flat <name>.md still works unchanged", async () => {
    const { skillsDir } = dirs();
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "bar.md"), BARE_SKILL);
    const store = new SkillsStore(skillsDir);
    const summaries = await store.list();
    expect(summaries.map((s) => s.name)).toEqual(["bar"]);
    expect(await store.load("bar")).toBe(BARE_SKILL);
  });

  test("collision: flat baz.md wins over baz/SKILL.md, single entry, warn", async () => {
    const { skillsDir } = dirs();
    mkdirSync(join(skillsDir, "baz"), { recursive: true });
    const FLAT = "# flat baz\nfrom flat file\n";
    const BUNDLED = "# bundled baz\nfrom SKILL.md\n";
    writeFileSync(join(skillsDir, "baz.md"), FLAT);
    writeFileSync(join(skillsDir, "baz", "SKILL.md"), BUNDLED);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = new SkillsStore(skillsDir);
      const summaries = await store.list();
      expect(summaries.map((s) => s.name)).toEqual(["baz"]); // exactly one
      // flat-file content is what load() returns
      expect(await store.load("baz")).toBe(FLAT);
      // collision warning surfaced
      const warned = warn.mock.calls.some((c) =>
        String(c[0]).includes('name collision for "baz"'),
      );
      expect(warned).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("promptSection renders directory-bundled skills with the right name", async () => {
    const { skillsDir } = dirs();
    mkdirSync(join(skillsDir, "foo"), { recursive: true });
    writeFileSync(join(skillsDir, "foo", "SKILL.md"), BUNDLED_SKILL);
    const section = await new SkillsStore(skillsDir).promptSection();
    expect(section).toContain("## Skills");
    expect(section).toContain("| foo |");
    expect(section).toContain("bundled foo skill");
    expect(section).toContain("bundled"); // trigger surfaced
  });

  test("listing ignores top-level entries that are neither *.md nor <dir>/SKILL.md", async () => {
    const { skillsDir } = dirs();
    mkdirSync(join(skillsDir, "no-skill-here"), { recursive: true });
    writeFileSync(join(skillsDir, "no-skill-here", "notes.md"), "# notes\n");
    writeFileSync(join(skillsDir, "loose.txt"), "not a skill\n");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "real.md"), BARE_SKILL);
    const summaries = await new SkillsStore(skillsDir).list();
    expect(summaries.map((s) => s.name)).toEqual(["real"]);
  });
});

describe("SkillsStore.seed — directory-bundled skills", () => {
  test("seeds flat x.md and bundled y/ (with sibling asset) into fresh dest", async () => {
    const { skillsDir, seedDir } = dirs();
    writeFileSync(join(seedDir, "x.md"), BARE_SKILL);
    mkdirSync(join(seedDir, "y"));
    // Bundled SKILL.md without frontmatter so the displayed name falls
    // back to the directory basename ("y"). parseSummary lets the
    // frontmatter `name:` override the derived stem; if a bundle's
    // frontmatter declared a different name the displayed name would
    // diverge from the load() key, matching today's flat-skill
    // behavior.
    writeFileSync(join(seedDir, "y", "SKILL.md"), "# Y\nbundled y body\n");
    writeFileSync(join(seedDir, "y", "asset.txt"), "hello asset\n");
    mkdirSync(join(seedDir, "y", "lib"));
    writeFileSync(join(seedDir, "y", "lib", "helper.sh"), "#!/bin/sh\n");

    const store = new SkillsStore(skillsDir);
    await store.seed(seedDir);

    expect(readFileSync(join(skillsDir, "x.md"), "utf8")).toBe(BARE_SKILL);
    expect(readFileSync(join(skillsDir, "y", "SKILL.md"), "utf8")).toBe(
      "# Y\nbundled y body\n",
    );
    expect(readFileSync(join(skillsDir, "y", "asset.txt"), "utf8")).toBe("hello asset\n");
    expect(existsSync(join(skillsDir, "y", "lib", "helper.sh"))).toBe(true);

    // both skills are discoverable under their filesystem-derived names
    const names = (await store.list()).map((s) => s.name).sort();
    expect(names).toEqual(["x", "y"]);

    // and loadable by those names
    expect(await store.load("x")).toBe(BARE_SKILL);
    expect(await store.load("y")).toBe("# Y\nbundled y body\n");
  });

  test("re-running seed does not clobber a modified destination bundle", async () => {
    const { skillsDir, seedDir } = dirs();
    mkdirSync(join(seedDir, "y"));
    writeFileSync(join(seedDir, "y", "SKILL.md"), BUNDLED_SKILL);
    writeFileSync(join(seedDir, "y", "asset.txt"), "seed asset\n");

    const store = new SkillsStore(skillsDir);
    await store.seed(seedDir);

    // user mutates the bundled skill
    writeFileSync(join(skillsDir, "y", "SKILL.md"), "user-edited SKILL\n");
    writeFileSync(join(skillsDir, "y", "asset.txt"), "user asset\n");
    // and tweaks the seed source so the would-be clobber is visible
    writeFileSync(join(seedDir, "y", "SKILL.md"), "NEW SEED\n");
    writeFileSync(join(seedDir, "y", "asset.txt"), "NEW SEED ASSET\n");

    await store.seed(seedDir);

    expect(readFileSync(join(skillsDir, "y", "SKILL.md"), "utf8")).toBe("user-edited SKILL\n");
    expect(readFileSync(join(skillsDir, "y", "asset.txt"), "utf8")).toBe("user asset\n");
  });

  test("seed skips source subdirectories that do not contain SKILL.md", async () => {
    const { skillsDir, seedDir } = dirs();
    mkdirSync(join(seedDir, "not-a-skill"));
    writeFileSync(join(seedDir, "not-a-skill", "README.md"), "# not a skill\n");
    writeFileSync(join(seedDir, "flat.md"), BARE_SKILL);

    const store = new SkillsStore(skillsDir);
    await store.seed(seedDir);

    expect(readFileSync(join(skillsDir, "flat.md"), "utf8")).toBe(BARE_SKILL);
    expect(existsSync(join(skillsDir, "not-a-skill"))).toBe(false);
  });
});

describe("SkillsStore.load — security guard", () => {
  test("rejects path traversal and absolute paths without filesystem lookup", async () => {
    const { skillsDir } = dirs();
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "ok.md"), BARE_SKILL);
    const store = new SkillsStore(skillsDir);

    for (const bad of [
      "../foo",
      "../../etc/passwd",
      "/etc/passwd",
      "foo/SKILL",
      "foo/bar",
      ".hidden",
      "",
      "a\\b",
    ]) {
      const err = await store.load(bad).catch((e) => e);
      expect(err, `expected reject for ${JSON.stringify(bad)}`).toBeInstanceOf(Error);
      expect(err.message).toMatch(/invalid skill name/);
    }

    // sanity: a legitimate name still works
    expect(await store.load("ok")).toBe(BARE_SKILL);
  });

  test("rejects a symlink whose realpath escapes skillsDir", async () => {
    const { skillsDir } = dirs();
    mkdirSync(skillsDir, { recursive: true });
    // Drop a file OUTSIDE skillsDir and symlink it in as "escape.md".
    const outside = mkdtempSync(join(tmpdir(), "skills-outside-"));
    writeFileSync(join(outside, "secret"), "should not be readable\n");
    symlinkSync(join(outside, "secret"), join(skillsDir, "escape.md"));

    const store = new SkillsStore(skillsDir);
    const err = await store.load("escape").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/escapes skills dir/);
  });
});
