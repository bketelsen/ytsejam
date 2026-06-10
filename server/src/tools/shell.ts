import { spawn } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

export const MAX_TOOL_OUTPUT = 50_000;

export function truncate(text: string, max = MAX_TOOL_OUTPUT): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated ${text.length - max} chars]`;
}

export function runCommand(
  command: string,
  opts: { cwd: string; timeoutMs: number },
): Promise<{ output: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) output += `\n[timed out after ${opts.timeoutMs}ms]`;
      resolve({ output: truncate(output), exitCode: code });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ output: String(err), exitCode: null });
    });
  });
}

const bashParams = Type.Object({
  command: Type.String({ description: "Shell command, run with bash -c" }),
  timeoutSeconds: Type.Optional(Type.Number({ description: "Max runtime in seconds (default 120)" })),
});

export function createBashTool(cwd: string): AgentTool<typeof bashParams> {
  return {
    name: "bash",
    label: "Bash",
    description:
      "Run a shell command on the server. Returns combined stdout/stderr and the exit code. Output is truncated at 50k chars.",
    parameters: bashParams,
    execute: async (_id, params) => {
      const { output, exitCode } = await runCommand(params.command, {
        cwd,
        timeoutMs: (params.timeoutSeconds ?? 120) * 1000,
      });
      return {
        content: [{ type: "text", text: `exit code: ${exitCode}\n${output}` }],
        details: { exitCode },
      };
    },
  };
}
