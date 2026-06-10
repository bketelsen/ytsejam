import fs from "node:fs/promises";
import path from "node:path";

/**
 * Markdown skill playbooks under {dataDir}/skills. Seed skills ship in the
 * repo and are copied in only when missing, so user edits and skills
 * generated at runtime (per-domain skills written by /cog setup) survive
 * restarts and upgrades.
 */

export interface SkillSummary {
  name: string;
  description: string;
  /** topics/keywords that should prompt loading this skill */
  triggers: string[];
}

export class SkillsStore {
  constructor(readonly skillsDir: string) {}

  /** Copy each seed *.md into the skills dir unless a file with that name exists. */
  async seed(seedDir: string): Promise<void> {
    await fs.mkdir(this.skillsDir, { recursive: true });
    let entries: string[];
    try {
      entries = await fs.readdir(seedDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries.filter((e) => e.endsWith(".md"))) {
      const target = path.join(this.skillsDir, entry);
      try {
        await fs.copyFile(path.join(seedDir, entry), target, fs.constants.COPYFILE_EXCL);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
  }

  async list(): Promise<SkillSummary[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.skillsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const summaries: SkillSummary[] = [];
    for (const entry of entries.filter((e) => e.endsWith(".md")).sort()) {
      const content = await fs.readFile(path.join(this.skillsDir, entry), "utf8");
      summaries.push(parseSummary(entry.replace(/\.md$/, ""), content));
    }
    return summaries;
  }

  async load(name: string): Promise<string> {
    if (name.includes("/") || name.includes("..")) throw new Error(`invalid skill name: ${name}`);
    try {
      return await fs.readFile(path.join(this.skillsDir, `${name}.md`), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const available = (await this.list()).map((s) => s.name);
      throw new Error(
        `unknown skill "${name}"; available: ${available.join(", ") || "(none)"}`,
      );
    }
  }

  /** "## Skills" routing-table prompt section; empty string when no skills exist. */
  async promptSection(): Promise<string> {
    const skills = await this.list();
    if (skills.length === 0) return "";
    const rows = skills.map((s) => {
      const when = s.triggers.length
        ? `user types /${s.name}, or conversation touches: ${s.triggers.join(", ")}`
        : `user types /${s.name} or asks for it`;
      return `| ${s.name} | ${s.description} | ${when} |`;
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
    .map((t) => t.trim())
    .filter(Boolean);

  return {
    name: fields.name || stem,
    description: fields.description || fallbackDescription(),
    triggers,
  };
}
