import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Domain } from "../types.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringArray = (value: unknown, field: string, id: string): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`domain ${JSON.stringify(id)}: ${field} must be a string array`);
  }
  return value;
};

function normalizeDomain(value: unknown, seen: Set<string>): Domain {
  if (!isRecord(value)) throw new Error("domain entry must be an object");
  const id = typeof value.id === "string" ? value.id : "";
  const path = typeof value.path === "string" ? value.path : "";
  if (!id) throw new Error("domain has empty id");
  if (seen.has(id)) throw new Error(`duplicate domain id ${JSON.stringify(id)}`);
  seen.add(id);
  if (!path) throw new Error(`domain ${JSON.stringify(id)}: empty path`);
  if (path.startsWith("/")) throw new Error(`domain ${JSON.stringify(id)}: path must be relative, got ${JSON.stringify(path)}`);
  if (path.includes("..")) throw new Error(`domain ${JSON.stringify(id)}: path may not contain '..'`);

  const files = stringArray(value.files, "files", id);
  for (const file of files ?? []) {
    if (!file || file.includes("/") || file.includes("\\")) {
      throw new Error(`domain ${JSON.stringify(id)}: invalid file basename ${JSON.stringify(file)}`);
    }
    if (file.endsWith(".md")) {
      throw new Error(`domain ${JSON.stringify(id)}: file ${JSON.stringify(file)} should be declared without .md suffix`);
    }
  }

  const triggers = stringArray(value.triggers, "triggers", id);
  let subdomains: Domain[] | undefined;
  if (value.subdomains !== undefined) {
    if (!Array.isArray(value.subdomains)) throw new Error(`domain ${JSON.stringify(id)}: subdomains must be an array`);
    subdomains = value.subdomains.map((d) => normalizeDomain(d, seen));
  }

  return {
    id,
    path,
    ...(typeof value.label === "string" ? { label: value.label } : {}),
    ...(typeof value.type === "string" ? { type: value.type } : {}),
    ...(triggers ? { triggers } : {}),
    ...(files ? { files } : {}),
    ...(subdomains ? { subdomains } : {}),
  };
}

/**
 * Validate an in-memory manifest body and return the normalized Domain list.
 * Used at write-time (by `store/write.ts`) to catch invalid manifests before
 * they reach disk, and as the post-parse half of `loadManifest`.
 *
 * `sourceLabel` is woven into the error message; pass the on-disk path when
 * validating a file read, or omit for raw write-time validation.
 */
export function validateManifestContent(content: string, sourceLabel?: string): Domain[] {
  let raw: unknown;
  try {
    raw = parse(content);
  } catch (err) {
    const where = sourceLabel ? ` ${JSON.stringify(sourceLabel)}` : "";
    throw new Error(`domain: parse${where}: ${(err as Error).message}`);
  }
  if (raw == null) return [];
  if (!isRecord(raw)) {
    const where = sourceLabel ? ` ${JSON.stringify(sourceLabel)}` : "";
    throw new Error(`domain: validate${where}: manifest must be an object`);
  }
  if (raw.domains == null) return [];
  if (!Array.isArray(raw.domains)) {
    const where = sourceLabel ? ` ${JSON.stringify(sourceLabel)}` : "";
    throw new Error(`domain: validate${where}: domains must be an array`);
  }

  try {
    const seen = new Set<string>();
    return raw.domains.map((d) => normalizeDomain(d, seen));
  } catch (err) {
    const where = sourceLabel ? ` ${JSON.stringify(sourceLabel)}` : "";
    throw new Error(`domain: validate${where}: ${(err as Error).message}`);
  }
}

export function loadManifest(rootDir: string): Domain[] {
  const manifestPath = join(rootDir, "domains.yml");
  if (!existsSync(manifestPath)) return [];
  // TOCTOU between stat and read: a mid-edit partial read parses to an
  // error → caught → stale-but-served via the error path. Matches Go.
  return validateManifestContent(readFileSync(manifestPath, "utf8"), manifestPath);
}
