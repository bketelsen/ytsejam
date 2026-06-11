import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Default cap on injected context-file text in bytes. */
export const DEFAULT_CONTEXT_FILES_CAP = 32_768;

const FILENAMES = ["AGENTS.md", "CLAUDE.md"];

export interface LoadContextFilesOptions {
  /** Override the user's home directory (used by tests). Defaults to os.homedir(). */
  home?: string;
  /** Max total injected size in bytes. Truncates with a note past this. */
  max?: number;
  /** Disable loading entirely; returns "". Mirrors pi-coding-agent --no-context-files. */
  disabled?: boolean;
}

/**
 * Faithful port of pi-coding-agent's documented "Context Files" behavior.
 *
 * Order (concatenated in this sequence; document = global first → farthest
 * ancestor → nearest ancestor → cwd):
 *   1. ~/.pi/agent/AGENTS.md (or CLAUDE.md) — global
 *   2. for each directory walking UP from cwd to filesystem root, the
 *      directory's AGENTS.md or CLAUDE.md when present
 *   3. cwd's AGENTS.md or CLAUDE.md
 *
 * At each level we accept either AGENTS.md OR CLAUDE.md (or both if both
 * exist). Missing files are skipped silently. The combined text is capped
 * at `max` bytes; truncation appends a clear marker so the model knows.
 *
 * Returns "" when disabled or when no files matched.
 */
export async function loadContextFiles(
  cwd: string,
  opts: LoadContextFilesOptions = {},
): Promise<string> {
  if (opts.disabled) return "";
  const max = opts.max ?? DEFAULT_CONTEXT_FILES_CAP;
  const home = opts.home ?? os.homedir();

  // Build the candidate directory list in load order (global first, then
  // farthest-ancestor → nearest → cwd).
  const dirs: string[] = [];
  dirs.push(path.join(home, ".pi", "agent"));
  for (const ancestor of ancestorsThenCwd(cwd)) dirs.push(ancestor);

  type Loaded = { path: string; text: string };
  const loaded: Loaded[] = [];
  for (const dir of dirs) {
    for (const name of FILENAMES) {
      const filePath = path.join(dir, name);
      try {
        const text = await fs.readFile(filePath, "utf8");
        loaded.push({ path: filePath, text });
      } catch {
        // missing/unreadable: skip silently
      }
    }
  }

  if (loaded.length === 0) return "";

  // Concatenate with clear separators so the model can attribute sections.
  const parts: string[] = [];
  let size = 0;
  let truncated = false;
  for (const { path: filePath, text } of loaded) {
    const block = `<!-- ${filePath} -->\n${text.trim()}\n`;
    if (size + block.length > max) {
      const remaining = Math.max(0, max - size);
      if (remaining > 64) {
        // include a clipped portion of this block so partial context still helps
        parts.push(block.slice(0, remaining));
        size += remaining;
      }
      truncated = true;
      break;
    }
    parts.push(block);
    size += block.length;
  }

  let out = parts.join("\n");
  if (truncated) {
    out += `\n\n[context files truncated at ${max} bytes]`;
  }
  return out;
}

/**
 * Yields directories from `/` (or the volume root) down to `cwd` inclusive.
 * `[/a/b/c]` becomes `["/", "/a", "/a/b", "/a/b/c"]` (with the platform
 * root). This puts the farthest ancestor first, matching the loadContextFiles
 * order described in the docstring above.
 */
function ancestorsThenCwd(cwd: string): string[] {
  const absolute = path.resolve(cwd);
  const segments: string[] = [];
  let current = absolute;
  while (true) {
    segments.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return segments;
}
