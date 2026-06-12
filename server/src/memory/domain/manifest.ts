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

export function loadManifest(rootDir: string): Domain[] {
  const manifestPath = join(rootDir, "domains.yml");
  if (!existsSync(manifestPath)) return [];

  let raw: unknown;
  try {
    // TOCTOU between stat and read: a mid-edit partial read parses to an
    // error → caught → stale-but-served via the error path. Matches Go.
    raw = parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new Error(`domain: parse ${JSON.stringify(manifestPath)}: ${(err as Error).message}`);
  }
  if (raw == null) return [];
  if (!isRecord(raw)) {
    throw new Error(`domain: validate ${JSON.stringify(manifestPath)}: manifest must be an object`);
  }
  // Treat null/undefined identically — matches Go's nil-slice handling
  // for `domains:` (key absent), `domains: null`, and `domains: ~`.
  if (raw.domains == null) return [];
  if (!Array.isArray(raw.domains)) {
    throw new Error(`domain: validate ${JSON.stringify(manifestPath)}: domains must be an array`);
  }

  try {
    const seen = new Set<string>();
    return raw.domains.map((d) => normalizeDomain(d, seen));
  } catch (err) {
    throw new Error(`domain: validate ${JSON.stringify(manifestPath)}: ${(err as Error).message}`);
  }
}
