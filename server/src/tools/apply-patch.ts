import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

function resolve(cwd: string, p: string): string {
  return path.isAbsolute(p) ? p : path.join(cwd, p);
}

type FileOp =
  | { kind: "add"; file: string; lines: string[] }
  | { kind: "delete"; file: string }
  | { kind: "update"; file: string; hunks: Hunk[] };

/**
 * A single change block within an Update File section. `oldLines` is the
 * sequence (context + removed lines) that must currently exist in the file;
 * `newLines` (context + added lines) is what replaces it. `heading` is the
 * optional `@@` anchor that scopes the search to disambiguate repeats.
 */
interface Hunk {
  heading: string | null;
  oldLines: string[];
  newLines: string[];
}

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const UPDATE = "*** Update File: ";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";

/**
 * Parse an OpenAI-style apply_patch envelope into structured file operations.
 * Throws on a malformed envelope so the caller can surface a clear error.
 */
export function parsePatch(patch: string): FileOp[] {
  const raw = patch.replace(/\r\n/g, "\n").split("\n");
  // Tolerate leading/trailing blank lines around the envelope.
  let start = 0;
  while (start < raw.length && raw[start].trim() === "") start++;
  let end = raw.length;
  while (end > start && raw[end - 1].trim() === "") end--;
  const lines = raw.slice(start, end);

  if (lines[0] !== BEGIN) {
    throw new Error(`malformed patch: must start with "${BEGIN}"`);
  }
  if (lines[lines.length - 1] !== END) {
    throw new Error(`malformed patch: must end with "${END}"`);
  }

  const ops: FileOp[] = [];
  let i = 1;
  while (i < lines.length - 1) {
    const line = lines[i];
    if (line.startsWith(ADD)) {
      const file = line.slice(ADD.length).trim();
      i++;
      const body: string[] = [];
      while (i < lines.length - 1 && !isSectionHeader(lines[i])) {
        const l = lines[i];
        if (!l.startsWith("+")) {
          throw new Error(`malformed patch: Add File "${file}" body lines must start with "+"`);
        }
        body.push(l.slice(1));
        i++;
      }
      ops.push({ kind: "add", file, lines: body });
    } else if (line.startsWith(DELETE)) {
      const file = line.slice(DELETE.length).trim();
      i++;
      ops.push({ kind: "delete", file });
    } else if (line.startsWith(UPDATE)) {
      const file = line.slice(UPDATE.length).trim();
      i++;
      const hunks: Hunk[] = [];
      let current: Hunk | null = null;
      while (i < lines.length - 1 && !isSectionHeader(lines[i])) {
        const l = lines[i];
        if (l.startsWith("@@")) {
          current = { heading: l.slice(2).trim() || null, oldLines: [], newLines: [] };
          hunks.push(current);
        } else {
          if (!current) {
            current = { heading: null, oldLines: [], newLines: [] };
            hunks.push(current);
          }
          if (l.startsWith("+")) {
            current.newLines.push(l.slice(1));
          } else if (l.startsWith("-")) {
            current.oldLines.push(l.slice(1));
          } else if (l.startsWith(" ")) {
            current.oldLines.push(l.slice(1));
            current.newLines.push(l.slice(1));
          } else if (l === "") {
            // A blank line in the diff body is an empty context line.
            current.oldLines.push("");
            current.newLines.push("");
          } else {
            throw new Error(
              `malformed patch: Update File "${file}" line must start with " ", "+", "-" or "@@": ${JSON.stringify(l)}`,
            );
          }
        }
        i++;
      }
      if (hunks.length === 0) {
        throw new Error(`malformed patch: Update File "${file}" has no hunks`);
      }
      ops.push({ kind: "update", file, hunks });
    } else {
      throw new Error(
        `malformed patch: expected a "*** Update/Add/Delete File:" header, got ${JSON.stringify(line)}`,
      );
    }
  }

  if (ops.length === 0) throw new Error("malformed patch: no file sections found");
  return ops;
}

function isSectionHeader(line: string): boolean {
  return line.startsWith(UPDATE) || line.startsWith(ADD) || line.startsWith(DELETE);
}

/**
 * Locate `needle` as a contiguous run of lines inside `haystack`, optionally
 * only after `anchorIdx`. Returns the start index. Throws a clear error if the
 * run is absent or appears more than once (ambiguous).
 */
function locate(haystack: string[], needle: string[], anchorIdx: number, file: string, hunkNo: number): number {
  if (needle.length === 0) {
    throw new Error(`apply_patch: ${file} hunk #${hunkNo} has no context or removed lines to locate`);
  }
  const matches: number[] = [];
  for (let i = anchorIdx; i + needle.length <= haystack.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push(i);
  }
  if (matches.length === 0) {
    throw new Error(`apply_patch: ${file} hunk #${hunkNo} context not found`);
  }
  if (matches.length > 1) {
    throw new Error(
      `apply_patch: ${file} hunk #${hunkNo} context is ambiguous — occurs ${matches.length} times; add more context or an @@ heading`,
    );
  }
  return matches[0];
}

/** Split file content into lines, remembering whether it ended with a newline. */
function splitLines(content: string): { lines: string[]; trailingNewline: boolean } {
  if (content === "") return { lines: [], trailingNewline: false };
  const trailingNewline = content.endsWith("\n");
  const body = trailingNewline ? content.slice(0, -1) : content;
  return { lines: body.split("\n"), trailingNewline };
}

function joinLines(lines: string[], trailingNewline: boolean): string {
  const body = lines.join("\n");
  return trailingNewline ? `${body}\n` : body;
}

/** Apply every hunk of an Update op to `content`, returning the new content. */
function applyUpdate(content: string, op: Extract<FileOp, { kind: "update" }>): string {
  const { lines, trailingNewline } = splitLines(content);
  let work = lines.slice();
  op.hunks.forEach((hunk, idx) => {
    const hunkNo = idx + 1;
    let anchorIdx = 0;
    if (hunk.heading) {
      // Prefer an exact (trimmed) match so a heading that merely appears as a
      // substring of an unrelated earlier line cannot anchor wrongly; only fall
      // back to a substring match when no exact line exists.
      let found = work.findIndex((l) => l.trim() === hunk.heading);
      if (found === -1) found = work.findIndex((l) => l.includes(hunk.heading!));
      if (found === -1) {
        throw new Error(`apply_patch: ${op.file} hunk #${hunkNo} @@ heading "${hunk.heading}" not found`);
      }
      anchorIdx = found + 1;
    }
    const at = locate(work, hunk.oldLines, anchorIdx, op.file, hunkNo);
    work = [...work.slice(0, at), ...hunk.newLines, ...work.slice(at + hunk.oldLines.length)];
  });
  // Preserve the original trailing-newline convention; treat content gaining
  // lines from empty as newline-terminated (the common case for source files).
  return joinLines(work, trailingNewline || content === "");
}

interface PlannedWrite {
  target: string;
  action: "add" | "update" | "delete";
  content: string | null; // null => delete
}

/**
 * Read the affected files, compute every resulting write in memory, and throw
 * if ANY operation cannot be applied — guaranteeing no file is touched unless
 * the whole patch succeeds.
 *
 * A resolved path may be the target of at most one operation, with one
 * exception: a `Delete File` may be followed by exactly one `Add File` of the
 * same path. This blocks the silent-clobber case where two `Update File`
 * sections for the same path each compute against the original on-disk content
 * (the later write would erase the earlier one's effect), while still allowing
 * the idiomatic delete-then-recreate.
 */
export async function planPatch(cwd: string, patch: string): Promise<PlannedWrite[]> {
  const ops = parsePatch(patch);
  const plan: PlannedWrite[] = [];
  // Tracks the last in-plan action per resolved path so we can reject
  // conflicting multi-ops without re-reading the (unchanged) disk state.
  const state = new Map<string, "deleted" | "written">();
  const dup = (file: string): Error =>
    new Error(
      `apply_patch: ${file} is targeted by more than one operation in this patch — combine the hunks or split them into separate calls`,
    );

  for (const op of ops) {
    const target = resolve(cwd, op.file);
    const prior = state.get(target);
    if (op.kind === "add") {
      // A path deleted earlier in this same envelope is addable; otherwise it
      // must not already exist (in the plan or on disk).
      if (prior === "written") throw dup(op.file);
      if (prior !== "deleted") {
        let exists = true;
        try {
          await fs.access(target);
        } catch {
          exists = false;
        }
        if (exists) throw new Error(`apply_patch: cannot add ${op.file} — file already exists`);
      }
      state.set(target, "written");
      plan.push({ target, action: "add", content: joinLines(op.lines, op.lines.length > 0) });
    } else if (op.kind === "delete") {
      if (prior !== undefined) throw dup(op.file);
      try {
        await fs.access(target);
      } catch {
        throw new Error(`apply_patch: cannot delete ${op.file} — file not found`);
      }
      state.set(target, "deleted");
      plan.push({ target, action: "delete", content: null });
    } else {
      if (prior !== undefined) throw dup(op.file);
      let original: string;
      try {
        original = await fs.readFile(target, "utf8");
      } catch {
        throw new Error(`apply_patch: cannot update ${op.file} — file not found`);
      }
      state.set(target, "written");
      plan.push({ target, action: "update", content: applyUpdate(original, op) });
    }
  }
  return plan;
}

const params = Type.Object({
  patch: Type.String({
    description: "An apply_patch envelope (see tool description for the exact format).",
  }),
});

export function createApplyPatchTool(cwd: string): AgentTool<typeof params> {
  return {
    name: "apply_patch",
    label: "Apply patch",
    description: [
      "Apply a multi-hunk, multi-file patch atomically. If ANY hunk fails (context not",
      "found, ambiguous, a missing/existing file, or two sections targeting one file),",
      "NOTHING is written and a structured error names the failing file and hunk. Relative",
      "paths resolve against the data directory.",
      "",
      "Pass a single `patch` string in this context-based envelope (no line numbers):",
      "",
      "*** Begin Patch",
      "*** Update File: path/to/file.ts",
      "@@ optional heading to disambiguate repeated context",
      " unchanged context line (leading space)",
      "-line to remove",
      "+line to add",
      "*** Add File: path/to/new.ts",
      "+every line of the new file",
      "+prefixed with a plus",
      "*** Delete File: path/to/old.ts",
      "*** End Patch",
      "",
      "Rules: each file section starts with `*** Update File:`, `*** Add File:`, or",
      "`*** Delete File:`. In Update sections, ` ` = context, `-` = remove, `+` = add;",
      "include a few unchanged context lines around each change so the location is unique.",
      "Each Update hunk MUST include at least one context (` `) or removed (`-`) line —",
      "pure `+`-only hunks are rejected because there is nothing to anchor the insertion to.",
      "Use `@@ heading` when the same context appears more than once. Add File bodies are",
      "all `+` lines. Delete File takes no body.",
      "A given file may be targeted by only one section (combine its changes into one",
      "Update), except that a `*** Delete File:` may be followed by an `*** Add File:` of",
      "the same path to replace it wholesale.",
      "",
      "Atomicity: the patch is fully validated before anything is written, so a validation",
      "failure (bad context, ambiguous match, missing/existing file, conflicting sections)",
      "writes NOTHING. The commit phase is not transactional against IO faults, however —",
      "a mid-write error (e.g. ENOSPC or a permission failure) can leave earlier files in",
      "the patch already written.",
    ].join("\n"),
    parameters: params,
    execute: async (_id, p) => {
      const plan = await planPatch(cwd, p.patch);
      // All operations validated above; now commit them.
      const summary: string[] = [];
      for (const w of plan) {
        if (w.action === "delete") {
          await fs.rm(w.target);
          summary.push(`deleted ${w.target}`);
        } else {
          await fs.mkdir(path.dirname(w.target), { recursive: true });
          await fs.writeFile(w.target, w.content as string, "utf8");
          summary.push(`${w.action === "add" ? "added" : "updated"} ${w.target}`);
        }
      }
      return { content: [{ type: "text", text: summary.join("\n") }], details: {} };
    },
  };
}
