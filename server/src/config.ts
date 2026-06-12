import path from "node:path";
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
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const authToken = env.YTSEJAM_AUTH_TOKEN;
  if (!authToken) throw new Error("YTSEJAM_AUTH_TOKEN is required");
  const defaultModel = env.YTSEJAM_DEFAULT_MODEL ?? "anthropic/claude-sonnet-4-6";
  return {
    port: Number(env.YTSEJAM_PORT ?? 3000),
    host: env.YTSEJAM_HOST ?? "127.0.0.1",
    dataDir: path.resolve(env.YTSEJAM_DATA_DIR ?? "./data"),
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
  };
}
