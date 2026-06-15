import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Domain, DomainFileRef, DomainForPathResult } from "../types.ts";
import { loadManifest } from "./manifest.ts";

const cloneDomains = (domains: Domain[]): Domain[] => structuredClone(domains);
const toPosix = (path: string) => path.replaceAll("\\", "/");
function cleanRel(path: string): string {
  const parts = toPosix(path).split("/").filter((seg) => seg && seg !== ".");
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === "..") {
      if (out.length === 0) throw new Error(`invalid path: escapes root: ${path}`);
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out.join("/");
}
const joinPosix = (...parts: string[]) => parts.map(cleanRel).filter(Boolean).join("/");
const walk = (domains: Domain[], fn: (domain: Domain) => void) => {
  for (const domain of domains) {
    fn(domain);
    if (domain.subdomains?.length) walk(domain.subdomains, fn);
  }
};
const declaresFile = (domain: Domain, file: string) => domain.files?.includes(file) ?? false;

export const ERR_ID_AS_PATH = "domain id used as path";

/**
 * Synchronous domains.yml controller. It polls domains.yml mtime on every
 * public method call and hot-reloads when the file changes. Hot-reload parse
 * failures are recorded in `lastError` while the last-good manifest continues
 * to be served (stale-but-served, matching cogmemory's Go controller).
 */
export class Controller {
  readonly root: string;
  readonly manifestPath: string;
  lastError: Error | null = null;
  private domains: Domain[] = [];
  private flat = new Map<string, Domain>();
  private mtimeMs = 0;

  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error(`domain: memoryRoot must be absolute, got ${JSON.stringify(root)}`);
    this.root = root;
    this.manifestPath = join(root, "domains.yml");
    this.reload();
  }

  list(): Domain[] {
    this.maybeReload();
    const out: Domain[] = [];
    walk(this.domains, (d) => out.push(structuredClone(d)));
    return out;
  }

  get(id: string): Domain {
    this.maybeReload();
    const domain = this.flat.get(id);
    if (!domain) {
      const base = `domain: unknown id ${JSON.stringify(id)}`;
      if (this.lastError) {
        throw new Error(`${base} (last manifest load failed: ${this.lastError.message})`);
      }
      throw new Error(base);
    }
    return structuredClone(domain);
  }

  actionItems(domain?: string): DomainFileRef[] {
    return this.enumerate("action-items", domain);
  }

  observations(domain?: string): DomainFileRef[] {
    return this.enumerate("observations", domain);
  }

  entities(domain?: string): DomainFileRef[] {
    return this.enumerate("entities", domain);
  }

  decisions(domain?: string): DomainFileRef[] {
    return this.enumerate("decisions", domain);
  }

  resolveFile(id: string, file: string): string {
    const domain = this.get(id);
    if (!declaresFile(domain, file)) throw new Error(`domain ${JSON.stringify(id)} does not declare file ${JSON.stringify(file)}`);
    return resolve(this.root, joinPosix(domain.path, `${file}.md`));
  }

  domainForPath(relPath: string): DomainForPathResult {
    this.maybeReload();
    const path = cleanRel(relPath);
    let best: DomainForPathResult & { prefix: number } = { domain: "", file: "", ok: false, prefix: -1 };

    walk(this.domains, (domain) => {
      const dpath = cleanRel(domain.path);
      if (!dpath) {
        if (!path.includes("/") && best.prefix < 0) best = { domain: domain.id, file: path.replace(/\.md$/, ""), ok: true, prefix: 0 };
        return;
      }
      if (!path.startsWith(`${dpath}/`)) return;
      const rest = path.slice(dpath.length + 1);
      if (!rest || rest.includes("/") || dpath.length <= best.prefix) return;
      best = { domain: domain.id, file: rest.replace(/\.md$/, ""), ok: true, prefix: dpath.length };
    });

    const { prefix: _prefix, ...result } = best;
    return result;
  }

  validateWrite(path: string): void {
    const { domain: id, file, ok } = this.domainForPath(path);
    if (!ok) {
      this.checkIDAsPath(path);
      return;
    }
    const domain = this.flat.get(id);
    if (domain && !declaresFile(domain, file)) {
      throw new Error(`write to ${JSON.stringify(path)} is under domain ${JSON.stringify(id)} but ${JSON.stringify(file)} is not in its declared files ${JSON.stringify(domain.files ?? [])}`);
    }
  }

  private enumerate(file: string, onlyDomain?: string): DomainFileRef[] {
    this.maybeReload();
    const out: DomainFileRef[] = [];
    walk(this.domains, (domain) => {
      if (onlyDomain && domain.id !== onlyDomain) return;
      if (declaresFile(domain, file)) out.push({ domain: domain.id, path: joinPosix(domain.path, `${file}.md`), file });
    });
    // Byte comparison matches Go's `out[i].Path < out[j].Path` exactly.
    // localeCompare diverges on mixed-case/punctuation paths.
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  private checkIDAsPath(relPath: string): void {
    const seg = cleanRel(relPath).split("/")[0] ?? "";
    if (!seg) return;
    const domain = this.flat.get(seg);
    if (!domain || domain.path === seg || domain.path.startsWith(`${seg}/`)) return;
    throw new Error(`${ERR_ID_AS_PATH}: write to ${JSON.stringify(relPath)} uses domain id ${JSON.stringify(seg)} as its path; domain ${JSON.stringify(domain.id)} lives at ${JSON.stringify(domain.path)}`);
  }

  private maybeReload(): void {
    const stat = existsSync(this.manifestPath) ? statSync(this.manifestPath) : null;
    if (!stat && this.mtimeMs === 0 && this.domains.length === 0) return;
    // mtime polling can miss sub-granularity rewrites on low-res FS;
    // matches Go behavior. Callers needing certainty should `utimes` after edit.
    if (stat && stat.mtimeMs === this.mtimeMs) return;
    try {
      this.reload();
    } catch (err) {
      this.lastError = err as Error;
    }
  }

  private reload(): void {
    const domains = loadManifest(this.root);
    this.domains = cloneDomains(domains);
    this.flat = new Map();
    walk(this.domains, (domain) => this.flat.set(domain.id, domain));
    this.mtimeMs = existsSync(this.manifestPath) ? statSync(this.manifestPath).mtimeMs : 0;
    this.lastError = null;
  }
}
