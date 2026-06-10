import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { truncate } from "./shell.ts";

function resolve(cwd: string, p: string): string {
  return path.isAbsolute(p) ? p : path.join(cwd, p);
}

const readParams = Type.Object({ path: Type.String() });

export function createReadTool(cwd: string): AgentTool<typeof readParams> {
  return {
    name: "read",
    label: "Read file",
    description: "Read a text file. Relative paths resolve against the data directory.",
    parameters: readParams,
    execute: async (_id, params) => {
      const text = await fs.readFile(resolve(cwd, params.path), "utf8");
      return { content: [{ type: "text", text: truncate(text) }], details: {} };
    },
  };
}

const writeParams = Type.Object({ path: Type.String(), content: Type.String() });

export function createWriteTool(cwd: string): AgentTool<typeof writeParams> {
  return {
    name: "write",
    label: "Write file",
    description: "Write a text file, creating parent directories. Overwrites existing files.",
    parameters: writeParams,
    execute: async (_id, params) => {
      const target = resolve(cwd, params.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, params.content, "utf8");
      return { content: [{ type: "text", text: `Wrote ${target}` }], details: {} };
    },
  };
}

const editParams = Type.Object({
  path: Type.String(),
  oldText: Type.String({ description: "Exact text to replace; must occur exactly once" }),
  newText: Type.String(),
});

export function createEditTool(cwd: string): AgentTool<typeof editParams> {
  return {
    name: "edit",
    label: "Edit file",
    description: "Replace an exact unique text occurrence in a file.",
    parameters: editParams,
    execute: async (_id, params) => {
      const target = resolve(cwd, params.path);
      const text = await fs.readFile(target, "utf8");
      const count = text.split(params.oldText).length - 1;
      if (count === 0) throw new Error(`oldText not found in ${target}`);
      if (count > 1) throw new Error(`oldText occurs ${count} times in ${target}; provide more context`);
      await fs.writeFile(target, text.replace(params.oldText, params.newText), "utf8");
      return { content: [{ type: "text", text: `Edited ${target}` }], details: {} };
    },
  };
}

const lsParams = Type.Object({ path: Type.Optional(Type.String()) });

export function createLsTool(cwd: string): AgentTool<typeof lsParams> {
  return {
    name: "ls",
    label: "List directory",
    description: "List directory entries. Defaults to the data directory.",
    parameters: lsParams,
    execute: async (_id, params) => {
      const target = resolve(cwd, params.path ?? ".");
      const entries = await fs.readdir(target, { withFileTypes: true });
      const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
      return { content: [{ type: "text", text: truncate(lines.join("\n") || "(empty)") }], details: {} };
    },
  };
}
