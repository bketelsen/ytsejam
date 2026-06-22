import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createBashTool } from "./shell.ts";
import { createEditTool, createLsTool, createReadTool, createWriteTool } from "./files.ts";
import { createGitTool } from "./git.ts";
import { createFindTool, createGrepTool } from "./search.ts";
import { createWebFetchTool, createWebSearchTool } from "./web.ts";

/**
 * Cwd-independent tools (web_search, web_fetch). Built once at boot and
 * shared across every session; safe because they don't touch the filesystem.
 */
export function createGlobalTools(): AgentTool<any>[] {
  return [createWebSearchTool(), createWebFetchTool()];
}

/**
 * Cwd-bearing tools (bash, read, write, edit, ls, grep, find). Built per
 * session against the session's resolved working directory so relative
 * paths and `bash` invocations land in the right place.
 */
export function createSessionCwdTools(cwd: string): AgentTool<any>[] {
  return [
    createBashTool(cwd),
    createReadTool(cwd),
    createWriteTool(cwd),
    createEditTool(cwd),
    createLsTool(cwd),
    createGitTool(cwd),
    createGrepTool(cwd),
    createFindTool(cwd),
  ];
}
