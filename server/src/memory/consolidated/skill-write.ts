import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { SkillWriteParams, SkillWriteResult } from "../types.ts";
import { validateParams } from "./params.ts";

const ID_RULE = /^[a-z][a-z0-9-]*$/;

function resolveDataDir(): string {
  const explicit = process.env.YTSEJAM_DATA_DIR;
  if (explicit) {
    if (explicit === "~" || explicit.startsWith("~/")) {
      return path.join(homedir(), explicit.slice(2));
    }
    return path.resolve(explicit);
  }
  return path.join(homedir(), ".ytsejam", "data");
}

function renderSkillFile(p: SkillWriteParams): string {
  const triggers = p.triggers.join(", ");
  const body = p.body.replace(/\n+$/, "");
  return `---
name: ${p.id}
description: ${p.description}
triggers: [${triggers}]
---

${body}
`;
}

export async function skillWrite(params: SkillWriteParams): Promise<SkillWriteResult> {
  validateParams(params as unknown as Record<string, unknown>, ["id", "description", "triggers", "body"]);

  if (typeof params.id !== "string" || !ID_RULE.test(params.id)) {
    throw new Error(`skill_write: id "${params.id}" must match [a-z][a-z0-9-]*`);
  }
  if (typeof params.description !== "string" || !params.description) {
    throw new Error("skill_write: description is required");
  }
  if (!Array.isArray(params.triggers) || params.triggers.length === 0) {
    throw new Error("skill_write: triggers must be non-empty");
  }
  if (params.triggers.some((t) => typeof t !== "string" || !t)) {
    throw new Error("skill_write: every trigger must be a non-empty string");
  }
  if (typeof params.body !== "string") {
    throw new Error("skill_write: body must be a string");
  }

  const skillsDir = path.join(resolveDataDir(), "skills");
  const abs = path.join(skillsDir, `${params.id}.md`);
  const content = renderSkillFile(params);

  await mkdir(skillsDir, { recursive: true });
  await writeFile(abs, content, "utf8");

  return { path: abs, bytes: Buffer.byteLength(content) };
}
