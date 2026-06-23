import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { resolveToolPath } from "./files.ts";
import { runArgv } from "./shell.ts";

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
      const target = resolveToolPath(cwd, params.path);
      const { output } = await runArgv(
        "grep",
        ["-rnE", "--", params.pattern, target],
        { cwd, timeoutMs: 30_000 },
      );
      const capped = output.split("\n").slice(0, 200).join("\n");
      return { content: [{ type: "text", text: capped.trim() ? capped : "(no matches)" }], details: {} };
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
      const target = resolveToolPath(cwd, params.path);
      const { output } = await runArgv(
        "find",
        [target, "-name", params.namePattern],
        { cwd, timeoutMs: 30_000 },
      );
      const capped = output.split("\n").slice(0, 200).join("\n");
      return { content: [{ type: "text", text: capped.trim() ? capped : "(no matches)" }], details: {} };
    },
  };
}
