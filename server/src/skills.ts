import fs from "node:fs/promises";
import path from "node:path";

/**
 * Markdown skill playbooks under {dataDir}/skills. Seed skills ship in the
 * repo and are copied in only when missing, so user edits and skills
 * generated at runtime (per-domain skills written by /cog setup) survive
 * restarts and upgrades.
 *
 * Two layouts are supported, both at the top level of skillsDir:
 *   1. Flat:               <name>.md           → skill named <name>
 *   2. Directory-bundled:  <name>/SKILL.md     → skill named <name>;
 *      sibling files inside the directory (reference.md, scripts, etc.)
 *      are bundled assets, not skills, and are never listed/loaded as such.
 *
 * The directory layout matches the Agent Skills convention that
 * pi-coding-agent already consumes (a skill is a directory whose entry
 * point is SKILL.md, with optional adjacent reference material).
 */

export interface SkillSummary {
  name: string;
  description: string;
  /** topics/keywords that should prompt loading this skill */
  triggers: string[];
}

export class SkillsStore {
  readonly skillsDir: string;

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
  }

  /**
   * Copy each seed skill into the skills dir unless it already exists.
   * Flat *.md files are copied with COPYFILE_EXCL (per-file). Directory-
   * bundled skills (<dir>/SKILL.md) are copied as a whole directory tree
   * only when the destination <dir> does not yet exist — the unit of
   * "exists" for a bundled skill is the directory, so a user-edited
   * bundle is never partially clobbered.
   */
  async seed(seedDir: string): Promise<void> {
    await fs.mkdir(this.skillsDir, { recursive: true });
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(seedDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const target = path.join(this.skillsDir, entry.name);
        try {
          await fs.copyFile(
            path.join(seedDir, entry.name),
            target,
            fs.constants.COPYFILE_EXCL,
          );
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        }
        continue;
      }
      if (entry.isDirectory()) {
        const srcDir = path.join(seedDir, entry.name);
        // Only seed if the source actually looks like a directory-bundled
        // skill (has a SKILL.md at its root). This avoids accidentally
        // copying unrelated subdirectories that may live alongside seed
        // skills in the source tree.
        try {
          await fs.access(path.join(srcDir, "SKILL.md"));
        } catch {
          continue;
        }
        const destDir = path.join(this.skillsDir, entry.name);
        // Copy-if-missing at directory granularity: skip when destDir exists
        // (mirrors the COPYFILE_EXCL semantics for flat skills).
        try {
          await fs.access(destDir);
          continue; // already present, do not clobber
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        await fs.cp(srcDir, destDir, { recursive: true });
      }
    }
  }

  async list(): Promise<SkillSummary[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(this.skillsDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    // Two passes: collect flat skills first, then directory skills.
    // Collision policy: a flat <name>.md beats a directory <name>/SKILL.md.
    // The flat layout has been the only supported form historically, so
    // when both shapes resolve to the same invocation name we prefer the
    // flat file and emit a console.warn so the operator can clean it up.
    const flat = new Map<string, string>(); // name → file path
    const dir = new Map<string, string>(); // name → SKILL.md path

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const stem = entry.name.replace(/\.md$/, "");
        flat.set(stem, path.join(this.skillsDir, entry.name));
        continue;
      }
      if (entry.isDirectory()) {
        const skillMd = path.join(this.skillsDir, entry.name, "SKILL.md");
        try {
          const st = await fs.stat(skillMd);
          if (st.isFile()) dir.set(entry.name, skillMd);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          // no SKILL.md in this dir → not a skill, ignore.
        }
      }
    }

    const resolved = new Map<string, string>(); // name → path to entry md
    for (const [name, p] of flat) resolved.set(name, p);
    for (const [name, p] of dir) {
      if (resolved.has(name)) {
        console.warn(
          `skills: name collision for "${name}" — flat ${resolved.get(name)} wins over bundled ${p}`,
        );
        continue;
      }
      resolved.set(name, p);
    }

    const names = [...resolved.keys()].sort();
    const summaries: SkillSummary[] = [];
    for (const name of names) {
      const content = await fs.readFile(resolved.get(name)!, "utf8");
      summaries.push(parseSummary(name, content));
    }
    return summaries;
  }

  async load(name: string): Promise<string> {
    // Invocation names are always slash-free by design (/skill:<name> and
    // /${name}). Reject anything that even looks like a path so traversal
    // attempts can't smuggle through bundled-skill resolution either.
    if (
      name.length === 0 ||
      name.includes("/") ||
      name.includes("\\") ||
      name.includes("..") ||
      name.startsWith(".") ||
      path.isAbsolute(name)
    ) {
      throw new Error(`invalid skill name: ${name}`);
    }

    const flatPath = path.join(this.skillsDir, `${name}.md`);
    const bundledPath = path.join(this.skillsDir, name, "SKILL.md");

    // Try flat first (matches list() collision precedence).
    const flat = await this.#readUnder(flatPath);
    if (flat !== null) return flat;
    const bundled = await this.#readUnder(bundledPath);
    if (bundled !== null) return bundled;

    const available = (await this.list()).map((s) => s.name);
    throw new Error(
      `unknown skill "${name}"; available: ${available.join(", ") || "(none)"}`,
    );
  }

  /**
   * Read a file iff its realpath resolves inside skillsDir. Returns the
   * content on success, null on ENOENT, and throws on any other error
   * (including a symlink that escapes skillsDir).
   */
  async #readUnder(candidate: string): Promise<string | null> {
    let realFile: string;
    let realRoot: string;
    try {
      realFile = await fs.realpath(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    try {
      realRoot = await fs.realpath(this.skillsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    if (realFile !== realRoot && !realFile.startsWith(rootWithSep)) {
      throw new Error(`skill path escapes skills dir: ${candidate}`);
    }
    return fs.readFile(realFile, "utf8");
  }

  /** "## Skills" routing-table prompt section; empty string when no skills exist. */
  async promptSection(): Promise<string> {
    const skills = await this.list();
    if (skills.length === 0) return "";
    const cell = (v: string) => v.replaceAll("|", "\\|");
    const rows = skills.map((s) => {
      const when = s.triggers.length
        ? `user types /${s.name}, or conversation touches: ${s.triggers.map(cell).join(", ")}`
        : `user types /${s.name} or asks for it`;
      return `| ${cell(s.name)} | ${cell(s.description)} | ${when} |`;
    });
    return `## Skills

Playbooks loaded with the skill tool. When a row's "invoke when" matches, call skill("name") and follow the playbook — don't improvise the workflow from memory.

| skill | purpose | invoke when |
|---|---|---|
${rows.join("\n")}`;
  }
}

function parseSummary(stem: string, content: string): SkillSummary {
  const fallbackDescription = () => {
    const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
    const line = body
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#"));
    return (line ?? "").slice(0, 120);
  };

  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return { name: stem, description: fallbackDescription(), triggers: [] };

  const lines = fm[1].split("\n");
  const fields: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (value === ">" || value === ">-" || value === "") {
      // folded block scalar: join the indented continuation lines
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        parts.push(lines[++i].trim());
      }
      value = parts.join(" ");
    }
    fields[m[1]] = value;
  }

  const triggers = (fields.triggers ?? "")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((t) => t.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);

  return {
    name: fields.name || stem,
    description: fields.description || fallbackDescription(),
    triggers,
  };
}
