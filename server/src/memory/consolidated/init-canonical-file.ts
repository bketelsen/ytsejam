import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InitCanonicalFileParams, InitCanonicalFileResult } from "../types.ts";
import { resolveMemoryPath } from "../store/paths.ts";
import { controller } from "./common.ts";
import { validateParams } from "./params.ts";

const BASENAME_RULE = /^[a-z][a-z0-9-]*$/;

type FileType = "hot-memory" | "observations" | "action-items" | "dev-log" | "generic";

const TEMPLATES: Record<Exclude<FileType, "generic">, (label: string) => string> = {
  "hot-memory": (label) =>
    `<!-- L0: Current state and top-of-mind for ${label} -->
# ${label} — Hot Memory

<!-- Rewrite freely. Keep under 50 lines. -->
`,
  "observations": (label) =>
    `<!-- L0: Timestamped observations and events for ${label} -->
# ${label} — Observations

<!-- Append-only. Format: - YYYY-MM-DD [tags]: observation -->
`,
  "action-items": (label) =>
    `<!-- L0: Open and completed tasks for ${label} -->
# ${label} — Action Items

## Open

## Completed
`,
  "dev-log": (label) =>
    `<!-- L0: Development log and architectural decisions for ${label} -->
# ${label} — Dev Log

<!-- Append entries with date headers. Use for ADR-style decisions, design notes, and post-mortems. -->
`,
};

function titleCase(slug: string): string {
  return slug.split("-").map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1)).join(" ");
}

function genericTemplate(label: string, basename: string): string {
  const title = titleCase(basename);
  return `<!-- L0: ${title} for ${label} -->
# ${label} — ${title}
`;
}

function pickTemplate(fileType: string, label: string, basename: string): string {
  if (fileType === "generic") return genericTemplate(label, basename);
  const builder = TEMPLATES[fileType as Exclude<FileType, "generic">];
  if (builder) return builder(label);
  return genericTemplate(label, basename);
}

function isPathUnderRegisteredDomain(rel: string): boolean {
  const c = controller();
  return c.list().some((d) => rel === d.path || rel.startsWith(`${d.path}/`));
}

export async function initCanonicalFile(
  params: InitCanonicalFileParams,
): Promise<InitCanonicalFileResult> {
  validateParams(params as unknown as Record<string, unknown>, ["path", "file_type", "label"]);
  if (typeof params.path !== "string" || !params.path) {
    throw new Error("init_canonical_file: path is required");
  }
  if (typeof params.label !== "string" || !params.label) {
    throw new Error("init_canonical_file: label is required");
  }

  const { abs, rel } = await resolveMemoryPath(params.path);

  if (!isPathUnderRegisteredDomain(rel)) {
    throw new Error(`init_canonical_file: path "${rel}" not under any registered domain`);
  }

  const basename = path.basename(rel, ".md");
  if (!BASENAME_RULE.test(basename)) {
    throw new Error(`init_canonical_file: basename "${basename}" must match [a-z][a-z0-9-]*`);
  }

  if (existsSync(abs)) {
    return { created: false, path: rel, bytes: 0 };
  }

  const content = pickTemplate(params.file_type, params.label, basename);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");

  return { created: true, path: rel, bytes: Buffer.byteLength(content) };
}
