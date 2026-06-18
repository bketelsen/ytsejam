/**
 * Reader for ytsejam session JSONL files (pi v3 format, see format.ts).
 *
 * Unlike pi-agent-core's own loader, this reader is tolerant: a corrupt line
 * is skipped with a warning rather than failing the whole file, because a
 * memory pipeline must keep working over a store with one bad write in it.
 */

import fs from "node:fs";
import path from "node:path";
import type {
  AgentMessage,
  LeafEntry,
  SessionEntry,
  SessionHeader,
} from "./format.ts";
import type { ParsedSession, Turn, TurnRole } from "../types.ts";

export interface ReadSessionOptions {
  /** Include assistant thinking blocks as memory text. Default false. */
  includeThinking?: boolean;
  /** Include tool result text. Default false (noisy, rarely durable). */
  includeToolResults?: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function parseHeader(line: string): SessionHeader | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (parsed.type !== "session" || parsed.version !== 3) return undefined;
  if (typeof parsed.id !== "string" || !parsed.id) return undefined;
  if (typeof parsed.timestamp !== "string") return undefined;
  if (typeof parsed.cwd !== "string") return undefined;
  return parsed as unknown as SessionHeader;
}

function parseEntry(line: string): SessionEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (typeof parsed.type !== "string") return undefined;
  if (typeof parsed.id !== "string" || !parsed.id) return undefined;
  if (parsed.parentId !== null && typeof parsed.parentId !== "string") return undefined;
  if (typeof parsed.timestamp !== "string") return undefined;
  return parsed as unknown as SessionEntry;
}

/** Extract the visible text of an agent message, or "" when none. */
export function messageText(
  message: AgentMessage,
  opts: ReadSessionOptions = {},
): string {
  if (message.role === "user") {
    if (typeof message.content === "string") return message.content.trim();
    return message.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
  }
  if (message.role === "assistant") {
    const parts: string[] = [];
    for (const c of message.content) {
      if (c.type === "text") parts.push(c.text);
      else if (c.type === "thinking" && opts.includeThinking) parts.push(c.thinking);
    }
    return parts.join("\n").trim();
  }
  // toolResult
  if (!opts.includeToolResults) return "";
  return message.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

/**
 * Resolve the active branch: latest leaf entry wins; its target (or, absent
 * any leaf entry, the last non-leaf entry) anchors a walk up parentId to the
 * root. Returns entries in chronological (root-first) order.
 */
export function activeBranch(entries: SessionEntry[]): SessionEntry[] {
  const byId = new Map<string, SessionEntry>();
  let leaf: LeafEntry | undefined;
  let lastNonLeaf: SessionEntry | undefined;
  for (const e of entries) {
    if (e.type === "leaf") {
      leaf = e as LeafEntry;
    } else {
      byId.set(e.id, e);
      lastNonLeaf = e;
    }
  }
  const anchorId = leaf ? leaf.targetId : (lastNonLeaf?.id ?? null);
  const branch: SessionEntry[] = [];
  let cur = anchorId === null ? undefined : byId.get(anchorId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    branch.push(cur);
    cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
  }
  branch.reverse();
  return branch;
}

/** Parse one ytsejam session JSONL file into turns on its active branch. */
export function readSessionFile(
  filePath: string,
  opts: ReadSessionOptions = {},
): ParsedSession {
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split("\n");
  const warnings: string[] = [];

  const header = lines.length > 0 ? parseHeader(lines[0]) : undefined;
  if (!header) {
    throw new Error(`Not a v3 session file: ${filePath}`);
  }

  const entries: SessionEntry[] = [];
  let title: string | undefined;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const entry = parseEntry(line);
    if (!entry) {
      warnings.push(`line ${i + 1}: skipped malformed entry`);
      continue;
    }
    if (entry.type === "session_info" && typeof entry.name === "string") {
      title = entry.name;
    }
    entries.push(entry);
  }

  const turns: Turn[] = [];
  for (const entry of activeBranch(entries)) {
    if (entry.type === "message") {
      const message = entry.message as AgentMessage;
      if (!isRecord(message) || typeof message.role !== "string") {
        warnings.push(`entry ${entry.id}: malformed message payload`);
        continue;
      }
      const role: TurnRole | undefined =
        message.role === "user"
          ? "user"
          : message.role === "assistant"
            ? "assistant"
            : undefined;
      const text = messageText(message, opts);
      if (role && text) {
        turns.push({
          sessionId: header.id,
          entryId: entry.id,
          role,
          text,
          timestamp: entry.timestamp,
        });
      }
    } else if (entry.type === "compaction" && typeof entry.summary === "string") {
      // Compaction summaries are distilled history the harness already paid
      // for; keep them as summary turns.
      turns.push({
        sessionId: header.id,
        entryId: entry.id,
        role: "summary",
        text: entry.summary.trim(),
        timestamp: entry.timestamp,
      });
    }
  }

  return {
    sessionId: header.id,
    title,
    cwd: header.cwd,
    createdAt: header.timestamp,
    parentSessionPath: header.parentSession,
    turns,
    warnings,
  };
}

/**
 * Resolve the root of a fork chain by walking parentSession headers.
 * Relative parent paths resolve against the child file's directory.
 * Tolerant: any unreadable link ends the walk at the last good session.
 */
export function resolveRootSession(
  filePath: string,
  parentSessionPath: string | undefined,
): { rootSessionId: string | undefined; hops: number } {
  let hops = 0;
  let currentDir = path.dirname(filePath);
  let next = parentSessionPath;
  let rootId: string | undefined;
  const visited = new Set<string>([path.resolve(filePath)]);
  while (next && hops < 16) {
    const parentPath = path.resolve(currentDir, next);
    if (visited.has(parentPath)) break; // cycle guard
    visited.add(parentPath);
    let header: SessionHeader | undefined;
    try {
      const firstLine = fs.readFileSync(parentPath, "utf8").split("\n", 1)[0];
      header = parseHeader(firstLine);
    } catch {
      break;
    }
    if (!header) break;
    rootId = header.id;
    currentDir = path.dirname(parentPath);
    next = header.parentSession;
    hops++;
  }
  return { rootSessionId: rootId, hops };
}

/**
 * All .jsonl session files at or below a directory, sorted by path.
 *
 * Recurses into subdirectories: ytsejam stores sessions under per-kind
 * subdirs (e.g. `--chat--/`, `--subagent--/`), so a non-recursive scan of the
 * top level finds nothing. `.compactions.jsonl` sidecars are log-compaction
 * artifacts, not sessions, and are skipped (mirrors the bridge backfill walk).
 */
export function listSessionFiles(dir: string): string[] {
  const results: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const filepath = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(filepath);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".jsonl") &&
        !entry.name.endsWith(".compactions.jsonl")
      ) {
        results.push(filepath);
      }
    }
  };
  walk(dir);
  return results.sort();
}
