import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { runCommand } from "./shell.ts";

const grepParams = Type.Object({
  pattern: Type.String({ description: "Regex pattern (grep -E)" }),
  path: Type.String({ description: "File or directory to search" }),
});

export function createGrepTool(cwd: string): AgentTool<typeof grepParams> {
  return {
    name: "grep",
    label: "Grep",
    description: "Search file contents recursively with line numbers.",
    parameters: grepParams,
    execute: async (_id, params) => {
      const { output } = await runCommand(
        `grep -rnE -- ${JSON.stringify(params.pattern)} ${JSON.stringify(params.path)} | head -200`,
        { cwd, timeoutMs: 30_000 },
      );
      return { content: [{ type: "text", text: output || "(no matches)" }], details: {} };
    },
  };
}

const findParams = Type.Object({
  namePattern: Type.String({ description: "Filename glob, e.g. *.md" }),
  path: Type.String({ description: "Directory to search" }),
});

export function createFindTool(cwd: string): AgentTool<typeof findParams> {
  return {
    name: "find",
    label: "Find files",
    description: "Find files by name pattern.",
    parameters: findParams,
    execute: async (_id, params) => {
      const { output } = await runCommand(
        `find ${JSON.stringify(params.path)} -name ${JSON.stringify(params.namePattern)} | head -200`,
        { cwd, timeoutMs: 30_000 },
      );
      return { content: [{ type: "text", text: output || "(no matches)" }], details: {} };
    },
  };
}
