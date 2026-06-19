// server/src/memory/active-project.ts
import path from "node:path";
import type { Domain } from "./types.ts";

/** Flatten a domain tree into a list (domains may nest via subdomains). */
function flatten(domains: Domain[]): Domain[] {
  const out: Domain[] = [];
  const walk = (ds: Domain[]) => { for (const d of ds) { out.push(d); if (d.subdomains) walk(d.subdomains); } };
  walk(domains);
  return out;
}

/** True when `child` is `parent` or a descendant path of it. */
function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Map a session workdir to a project tag via domain `workingDir`, nearest
 * ancestor wins. `projects/ytsejam` → `projects:ytsejam`. Null when unmapped.
 */
export function projectTagForWorkdir(domains: Domain[], workdir: string): string | null {
  const candidates = flatten(domains)
    .filter((d): d is Domain & { workingDir: string } => typeof d.workingDir === "string")
    .filter((d) => isWithin(d.workingDir, workdir))
    .sort((a, b) => b.workingDir.length - a.workingDir.length); // longest (nearest) first
  const best = candidates[0];
  return best ? best.path.replace(/\//g, ":") : null;
}
