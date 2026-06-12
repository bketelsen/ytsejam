import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export function memoryRoot(): string {
  const explicit = process.env.YTSEJAM_MEMORY_DIR;
  if (explicit) return path.resolve(expandHome(explicit));
  const dataDir = process.env.YTSEJAM_DATA_DIR;
  if (dataDir) return path.resolve(expandHome(dataDir), "memory");

  const modern = path.join(homedir(), ".ytsejam", "data", "memory");
  const legacy = path.join(homedir(), ".chapterhouse", "memory");
  if (!existsSync(modern) && existsSync(legacy)) {
    console.warn(`ytsejam memory: using deprecated legacy memory root ${legacy}; migrate to ${modern}`);
    return legacy;
  }
  return modern;
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p;
}

export async function ensureRoot(): Promise<string> {
  const root = memoryRoot();
  await mkdir(root, { recursive: true, mode: 0o755 });
  return root;
}

export function normalizeRelPath(relPath: string): string {
  if (!relPath) throw new Error("store: empty path");
  const slash = relPath.replaceAll("\\", "/");
  if (slash.startsWith("/") || /^[A-Za-z]:\//.test(slash)) {
    throw new Error(`store: absolute path rejected: ${relPath}`);
  }
  const cleaned = path.posix.normalize(slash);
  if (cleaned === "." || cleaned === "" || cleaned.startsWith("../") || cleaned === ".." || cleaned.includes("/../")) {
    throw new Error(`store: path traversal rejected: ${relPath}`);
  }
  return cleaned;
}

export async function resolveMemoryPath(relPath: string): Promise<{ root: string; rel: string; abs: string }> {
  const root = await ensureRoot();
  const rel = normalizeRelPath(relPath);
  const abs = path.resolve(root, rel);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) throw new Error(`store: path traversal rejected: ${relPath}`);
  return { root, rel, abs };
}

const allowedCogMetaFiles = new Set([
  "cog-meta/scenario-calibration.md",
  "cog-meta/reflect-cursor.md",
  "cog-meta/foresight-nudge.md",
  "cog-meta/evolve-log.md",
  "cog-meta/evolve-observations.md",
  "cog-meta/scorecard.md",
]);

export function isAllowedWholeFileWrite(rel: string): boolean {
  rel = normalizeRelPath(rel);
  return rel === "domains.yml" ||
    rel === "link-index.md" ||
    rel === "glacier/index.md" ||
    rel.endsWith("/INDEX.md") ||
    allowedCogMetaFiles.has(rel) ||
    (rel.startsWith("cog-meta/scenarios/") && rel.endsWith(".md") && !rel.slice("cog-meta/scenarios/".length).includes("/"));
}

interface DomainPath { id: string; path: string }

export async function rejectIDAsPath(rel: string): Promise<void> {
  rel = normalizeRelPath(rel);
  const first = rel.split("/")[0];
  if (!first) return;
  let domains: DomainPath[] = [];
  try { domains = parseDomainPaths(await readFile(path.join(await ensureRoot(), "domains.yml"), "utf8")); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  const d = domains.find((x) => x.id === first);
  if (!d) return;
  if (d.path === first || d.path.startsWith(first + "/")) return;
  throw new Error(`domain id used as path: write to ${JSON.stringify(rel)} uses domain id ${JSON.stringify(first)} as its path; domain ${JSON.stringify(d.id)} lives at ${JSON.stringify(d.path)}`);
}

export async function validateWholeFileWritePath(rel: string): Promise<void> {
  rel = normalizeRelPath(rel);
  await rejectIDAsPath(rel);
  if (!isAllowedWholeFileWrite(rel)) {
    throw new Error(`write path not allowed for whole-file write: ${rel}; use append or patch for canonical memory files`);
  }
}

function parseDomainPaths(yaml: string): DomainPath[] {
  const out: DomainPath[] = [];
  let cur: Partial<DomainPath> | null = null;
  for (const raw of yaml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "");
    const idStart = line.match(/^\s*-\s*id:\s*([^\s].*?)(?:\s+(?:#.*)?)?$/);
    if (idStart) {
      if (cur?.id && cur.path) out.push({ id: cur.id, path: cur.path });
      cur = { id: unquote(idStart[1]) };
      continue;
    }
    if (!cur) continue;
    const p = line.match(/^\s*path:\s*([^\s].*?)(?:\s+(?:#.*)?)?$/);
    if (p) cur.path = unquote(p[1]);
  }
  if (cur?.id && cur.path) out.push({ id: cur.id, path: cur.path });
  return out;
}

function unquote(s: string): string {
  s = s.trim();
  return (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) ? s.slice(1, -1) : s;
}
