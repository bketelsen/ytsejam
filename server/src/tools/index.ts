import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createBashTool } from "./shell.ts";
import { createEditTool, createLsTool, createReadTool, createWriteTool } from "./files.ts";
import { createFindTool, createGrepTool } from "./search.ts";
import { createWebFetchTool, createWebSearchTool } from "./web.ts";

export function createTools(dataDir: string): AgentTool<any>[] {
  return [
    createWebSearchTool(),
    createWebFetchTool(),
    createBashTool(dataDir),
    createReadTool(dataDir),
    createWriteTool(dataDir),
    createEditTool(dataDir),
    createLsTool(dataDir),
    createGrepTool(dataDir),
    createFindTool(dataDir),
  ];
}
