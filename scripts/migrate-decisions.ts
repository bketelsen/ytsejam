import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const STOPWORDS = new Set(["a", "an", "the", "of", "for", "and", "or", "to", "in", "on", "with"]);
const ENTRY_RE = /^-\s+(\d{4}-\d{2}-\d{2}):\s+\*\*([^*]+)\*\*\s*(?:—|--|-)\s*(.+?)(?:\s+Origin:\s+(.+?))?\.?\s*$/;

function slugify(title: string, seen: Map<string, number>): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .slice(0, 5);
  const base = words.length > 0 ? `d-${words.join("-")}` : "d-decision";
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count + 1}`;
}

export interface MigrateDecisionsOptions {
  root: string;
  domainPath: string; // e.g. "projects/ytsejam"
  force?: boolean; // when true, overwrite existing destination
}

export async function migrateDecisions(opts: MigrateDecisionsOptions): Promise<void> {
  const srcPath = path.join(opts.root, "wiki", opts.domainPath, "decisions.md");
  const destPath = path.join(opts.root, opts.domainPath, "decisions.md");

  if (!existsSync(srcPath)) return;

  const src = await readFile(srcPath, "utf8");
  const seen = new Map<string, number>();
  const outLines: string[] = [
    `<!-- L0: Decisions for ${opts.domainPath} -->`,
    `# ${opts.domainPath} — Decisions`,
    "",
    "<!-- Migrated from wiki/" + opts.domainPath + "/decisions.md on " + new Date().toISOString().slice(0, 10) + " -->",
    "",
  ];

  for (const line of src.split(/\r?\n/)) {
    const m = line.trim().match(ENTRY_RE);
    if (!m) continue;
    const [, date, title, body, origin] = m;
    const slug = slugify(title, seen);
    const meta = origin ? `<!-- origin: ${origin.trim()} -->` : "";
    const bodyText = body.trim().replace(/\.\s*$/, "");
    outLines.push(`- ${date} [${slug}]: ${title.trim()} — ${bodyText}.${meta ? " " + meta : ""}`);
  }

  if (existsSync(destPath) && !opts.force) {
    throw new Error(
      `Destination already exists: ${destPath}. Use { force: true } (or --force) to overwrite.`
    );
  }

  await writeFile(destPath, outLines.join("\n") + "\n", "utf8");
}

// CLI entry
if (process.argv[1] && process.argv[1].endsWith("migrate-decisions.ts")) {
  const args = process.argv.slice(2);
  const root = args[args.indexOf("--root") + 1];
  const domainPath = args[args.indexOf("--domain") + 1];
  if (!root || !domainPath) {
    console.error("Usage: tsx scripts/migrate-decisions.ts --root <memory-root> --domain <projects/foo> [--force]");
    process.exit(1);
  }
  const force = args.includes("--force");
  migrateDecisions({ root, domainPath, force })
    .then(() => console.log(`migrated → ${path.join(root, domainPath, "decisions.md")}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
