import path from "node:path";
import { defaultPiAuthPath } from "./pi-auth.ts";

export interface Config {
  port: number;
  dataDir: string;
  authToken: string;
  /** "provider/modelId", must exist in the pi-ai catalog */
  defaultModel: string;
  webDistDir: string;
  /** generate session titles with the LLM after the first exchange */
  generateTitles: boolean;
  /** pi CLI auth.json with OAuth credentials (Copilot/Codex subscriptions) */
  piAuthPath: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const authToken = env.YTSEJAM_AUTH_TOKEN;
  if (!authToken) throw new Error("YTSEJAM_AUTH_TOKEN is required");
  return {
    port: Number(env.YTSEJAM_PORT ?? 3000),
    dataDir: path.resolve(env.YTSEJAM_DATA_DIR ?? "./data"),
    authToken,
    defaultModel: env.YTSEJAM_DEFAULT_MODEL ?? "anthropic/claude-sonnet-4-6",
    webDistDir: path.resolve(env.YTSEJAM_WEB_DIST ?? "../web/dist"),
    generateTitles: env.YTSEJAM_GENERATE_TITLES !== "false",
    piAuthPath: env.YTSEJAM_PI_AUTH ?? defaultPiAuthPath(),
  };
}
