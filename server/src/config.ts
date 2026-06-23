import fs from "node:fs";
import path from "node:path";
import { isApprovalMode, type ApprovalMode } from "./approval/types.ts";
import { defaultPiAuthPath } from "./pi-auth.ts";

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  authToken: string;
  /** "provider/modelId", must exist in the pi-ai catalog */
  defaultModel: string;
  webDistDir: string;
  /** generate session titles with the LLM after the first exchange */
  generateTitles: boolean;
  /** pi CLI auth.json with OAuth credentials (Copilot/Codex subscriptions) */
  piAuthPath: string;
  /** default "provider/modelId" for delegated subagents */
  subagentModel: string;
  /** max concurrently running subagent tasks */
  taskConcurrency: number;
  /** per-task timeout in minutes */
  taskTimeoutMinutes: number;
  /**
   * Load AGENTS.md/CLAUDE.md from ~/.pi/agent and the session's working-dir
   * ancestor chain into the system prompt. Mirrors pi-coding-agent's
   * --no-context-files opt-out.
   */
  contextFiles: boolean;
  /**
   * Default approval mode for newly created sessions. Read from
   * YTSEJAM_DEFAULT_APPROVAL_MODE (yolo|ask|read_only); invalid values fall
   * back to the shipped default `yolo`. SHIPPED DEFAULT stays `yolo` so
   * existing behavior is unchanged unless explicitly configured.
   */
  defaultApprovalMode: ApprovalMode;
}

export function sandboxEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.YTSEJAM_SANDBOX;
  return v !== "0" && v?.toLowerCase() !== "false";
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const authToken = env.YTSEJAM_AUTH_TOKEN;
  if (!authToken) throw new Error("YTSEJAM_AUTH_TOKEN is required");
  const defaultModel = env.YTSEJAM_DEFAULT_MODEL ?? "anthropic/claude-sonnet-4-6";
  const dataDir = path.resolve(env.YTSEJAM_DATA_DIR ?? "./data");
  if (!env.YTSEJAM_DATA_DIR && isInsideYtsejamRepo(dataDir)) {
    throw new Error(
      `YTSEJAM_DATA_DIR is unset and the default ./data would land inside the ytsejam repo at ${dataDir}. ` +
        `Set YTSEJAM_DATA_DIR to an explicit path (typically ~/.ytsejam/data) before running. ` +
        `This guard prevents the legacy server/data/ tree from silently reappearing.`,
    );
  }
  return {
    port: Number(env.YTSEJAM_PORT ?? 3000),
    host: env.YTSEJAM_HOST ?? "127.0.0.1",
    dataDir,
    authToken,
    defaultModel,
    webDistDir: path.resolve(env.YTSEJAM_WEB_DIST ?? "../web/dist"),
    generateTitles: env.YTSEJAM_GENERATE_TITLES !== "false",
    piAuthPath: env.YTSEJAM_PI_AUTH ?? defaultPiAuthPath(),
    subagentModel: env.YTSEJAM_SUBAGENT_MODEL ?? defaultModel,
    // clamp: NaN/0/negative would silently stall the task pump
    taskConcurrency: Math.max(1, Number(env.YTSEJAM_TASK_CONCURRENCY ?? 4) || 4),
    taskTimeoutMinutes: Math.max(1, Number(env.YTSEJAM_TASK_TIMEOUT_MIN ?? 15) || 15),
    contextFiles: env.YTSEJAM_CONTEXT_FILES !== "false",
    defaultApprovalMode: parseDefaultApprovalMode(env.YTSEJAM_DEFAULT_APPROVAL_MODE),
  };
}

/**
 * Validate YTSEJAM_DEFAULT_APPROVAL_MODE. Unset → shipped default `yolo`
 * (preserves current behavior). An invalid value falls back safely to `yolo`
 * with a warning rather than crashing boot.
 */
function parseDefaultApprovalMode(raw: string | undefined): ApprovalMode {
  if (raw === undefined || raw === "") return "yolo";
  if (isApprovalMode(raw)) return raw;
  console.warn(
    `[config] YTSEJAM_DEFAULT_APPROVAL_MODE="${raw}" is invalid ` +
      `(expected yolo|ask|read_only); falling back to "yolo".`,
  );
  return "yolo";
}

/**
 * Detect whether `dataDir` resolves to a path inside a checkout of the ytsejam
 * repo itself. Walks up from `dataDir`'s parent looking for a `package.json`
 * whose `name === "ytsejam"`. Used to refuse the implicit `./data` default
 * when someone runs the server from the repo (which is what produced the
 * legacy 13M `server/data/` tree that we deleted 2026-06-14).
 *
 * Returns false on any I/O or parse error — this is a guard, not security;
 * a false-negative just degrades to the prior silent behavior.
 */
function isInsideYtsejamRepo(dataDir: string): boolean {
  let dir = path.dirname(dataDir);
  const root = path.parse(dir).root;
  while (dir !== root) {
    const pkgPath = path.join(dir, "package.json");
    try {
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { name?: string };
        if (pkg.name === "ytsejam") return true;
      }
    } catch {
      // unreadable / unparseable — keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}
