import { spawn } from "node:child_process";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { MAX_TOOL_OUTPUT, truncate } from "./shell.ts";
import { resolveToolPath } from "./files.ts";

const GIT_TIMEOUT_MS = 120_000;
const MAX_LOG_COUNT = 50;

const gitParams = Type.Object({
  op: Type.Union([
    Type.Literal("status"),
    Type.Literal("diff"),
    Type.Literal("log"),
    Type.Literal("show"),
    Type.Literal("add"),
    Type.Literal("restore"),
    Type.Literal("checkout"),
    Type.Literal("branch"),
    Type.Literal("commit"),
  ], { description: "Git operation to run in the bound session working directory repository." }),
  path: Type.Optional(Type.String({ description: "Optional file path. Relative paths resolve against the session working directory." })),
  staged: Type.Optional(Type.Boolean({ description: "For diff, show staged changes. For restore, restore the staged copy." })),
  count: Type.Optional(Type.Number({ description: `For log, max commits to show. Clamped to ${MAX_LOG_COUNT}.` })),
  rev: Type.Optional(Type.String({ description: "Revision, commit, or object for show/checkout/restore." })),
  message: Type.Optional(Type.String({ description: "Commit message for commit." })),
  branchMode: Type.Optional(Type.Union([
    Type.Literal("list"),
    Type.Literal("create"),
    Type.Literal("switch"),
  ], { description: "For branch: list branches, create a branch, or switch to a branch." })),
  branch: Type.Optional(Type.String({ description: "Branch name for branch create/switch or checkout." })),
});

interface GitRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

function capStream(text: string): { text: string; truncated: boolean } {
  const capped = truncate(text);
  return { text: capped, truncated: capped !== text };
}

function runGit(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitRunResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stdoutCapped = false;
    let stderrCapped = false;
    let timedOut = false;

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutCapped) return;
      stdout += chunk.toString("utf8");
      stdoutCapped = stdout.length > MAX_TOOL_OUTPUT;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrCapped) return;
      stderr += chunk.toString("utf8");
      stderrCapped = stderr.length > MAX_TOOL_OUTPUT;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      const out = capStream(stdout);
      const err = capStream(stderr);
      resolve({
        stdout: out.text,
        stderr: timedOut ? `${err.text}\n[timed out after ${timeoutMs}ms]` : err.text,
        exitCode: code,
        timedOut,
        truncated: stdoutCapped || stderrCapped || out.truncated || err.truncated,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: String(err), exitCode: null, timedOut: false, truncated: false });
    });
  });
}

async function repoRoot(cwd: string): Promise<string> {
  const result = await runGit(cwd, ["rev-parse", "--show-toplevel"], 10_000);
  if (result.exitCode !== 0) {
    throw new Error(`Working directory is not a git repository: ${cwd}`);
  }
  return result.stdout.trim();
}

function boundedCount(count: number | undefined): number {
  if (typeof count !== "number" || !Number.isFinite(count)) return 20;
  return Math.max(1, Math.min(MAX_LOG_COUNT, Math.trunc(count)));
}

function pathspec(cwd: string, root: string, maybePath: string | undefined): string | undefined {
  if (!maybePath) return undefined;
  const absolute = resolveToolPath(cwd, maybePath);
  const relative = path.relative(root, absolute);
  return relative === "" ? "." : relative;
}

function requireArg(value: string | undefined, name: string, op: string): string {
  if (!value) throw new Error(`git ${op} requires ${name}`);
  return value;
}

function commandArgs(cwd: string, root: string, params: any): string[] {
  const spec = pathspec(cwd, root, params.path);
  switch (params.op) {
    case "status":
      return ["status", "--short", "--branch"];
    case "diff": {
      const args = ["diff"];
      if (params.staged) args.push("--staged");
      if (spec) args.push("--", spec);
      return args;
    }
    case "log":
      return ["log", `--max-count=${boundedCount(params.count)}`, "--oneline", "--decorate"];
    case "show":
      return ["show", params.rev ?? "HEAD", "--"];
    case "add":
      return ["add", "--", spec ?? "."];
    case "restore": {
      const args = ["restore"];
      if (params.staged) args.push("--staged");
      if (params.rev) args.push("--source", params.rev);
      args.push("--", requireArg(spec, "path", "restore"));
      return args;
    }
    case "checkout": {
      const target = params.branch ?? params.rev;
      if (spec) return ["checkout", target ?? "HEAD", "--", spec];
      return ["checkout", requireArg(target, "branch or rev", "checkout")];
    }
    case "branch": {
      const mode = params.branchMode ?? "list";
      if (mode === "list") return ["branch", "--list"];
      if (mode === "create") return ["branch", requireArg(params.branch, "branch", "branch create")];
      return ["switch", requireArg(params.branch, "branch", "branch switch")];
    }
    case "commit":
      return ["commit", "-m", requireArg(params.message, "message", "commit")];
    default:
      throw new Error(`Unsupported git op: ${String(params.op)}`);
  }
}

function renderResult(result: GitRunResult): string {
  const pieces = [`exit code: ${result.exitCode}`];
  if (result.stdout.trim()) pieces.push(`stdout:\n${result.stdout.trimEnd()}`);
  if (result.stderr.trim()) pieces.push(`stderr:\n${result.stderr.trimEnd()}`);
  return truncate(pieces.join("\n"));
}

function normalizeStatusOutput(stdout: string): string {
  const lines = stdout.trimEnd().split("\n").filter((line) => line.length > 0);
  const changed = lines.some((line) => !line.startsWith("## "));
  return changed ? stdout : `${stdout.trimEnd()}\n(clean)\n`;
}

export function createGitTool(cwd: string): AgentTool<typeof gitParams> {
  return {
    name: "git",
    label: "Git",
    description:
      "Run bounded local git operations in the session working directory repo. Ops: status, diff, log, show, add, restore, checkout, branch, commit. No push, pull, remote mutation, force, or config writes.",
    parameters: gitParams,
    execute: async (_id, params) => {
      const root = await repoRoot(cwd);
      const args = commandArgs(cwd, root, params);
      const result = await runGit(root, args);
      if (params.op === "status") {
        result.stdout = normalizeStatusOutput(result.stdout);
      }
      return {
        content: [{ type: "text", text: renderResult(result) }],
        details: {
          op: params.op,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.truncated,
          timedOut: result.timedOut,
          repoRoot: root,
        },
      };
    },
  };
}
