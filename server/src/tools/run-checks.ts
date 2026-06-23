import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { resolveToolPath } from "./files.ts";
import { MAX_TOOL_OUTPUT, truncate } from "./shell.ts";

const DEFAULT_TIMEOUT_SECONDS = 600;
const SUMMARY_TAIL_CHARS = 1200;
const MAX_FAILURES_IN_TEXT = 5;

const checkParams = Type.Object({
  kind: Type.Union([
    Type.Literal("test"),
    Type.Literal("build"),
    Type.Literal("lint"),
    Type.Literal("typecheck"),
    Type.Literal("script"),
  ], { description: "Project check to run. test->test, build->build, typecheck->check, lint->lint, script->script." }),
  workspace: Type.Optional(Type.String({ description: "Optional npm workspace selector, such as server or web." })),
  script: Type.Optional(Type.String({ description: "Explicit package.json script name. Required when kind is script." })),
  timeoutSeconds: Type.Optional(Type.Number({ description: `Max runtime in seconds (default ${DEFAULT_TIMEOUT_SECONDS}).` })),
});

type CheckKind = "test" | "build" | "lint" | "typecheck" | "script";

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

interface WorkspacePackage {
  dir: string;
  relativeDir: string;
  packageJson: PackageJson;
}

interface CheckRunResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

interface RunChecksDetails {
  command: string;
  kind: CheckKind;
  workspace: string | undefined;
  exitCode: number | null;
  passed: boolean;
  timedOut: boolean;
  truncated: boolean;
  summary: string;
  failures: string[];
  availableScripts?: string[];
}

export interface ParsedCheckOutput {
  summary?: string;
  failures: string[];
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

function parseCountLine(line: string): Map<string, number> {
  const counts = new Map<string, number>();
  const cleaned = stripAnsi(line);
  const matches = cleaned.matchAll(/(\d+)\s+(failed|passed|skipped|todo|cancelled|only)/g);
  for (const match of matches) {
    counts.set(match[2], Number(match[1]));
  }
  return counts;
}

function formatVitestSummary(counts: Map<string, number>): string | undefined {
  const ordered = ["passed", "failed", "skipped", "todo", "cancelled", "only"];
  const pieces = ordered
    .filter((key) => counts.has(key))
    .map((key) => `${counts.get(key)} ${key}`);
  return pieces.length > 0 ? pieces.join(", ") : undefined;
}

export function parseVitestOutput(output: string): ParsedCheckOutput {
  const lines = stripAnsi(output).split(/\r?\n/);
  const failures = lines
    .map((line) => line.match(/^\s*FAIL\s+((?=\S*(?:[/\\]|\.test\.|\.spec\.))\S.+?)(?:\s+\(\d+(?:\.\d+)?m?s\))?\s*$/)?.[1]?.trim())
    .filter((line): line is string => Boolean(line));

  const testsLine = [...lines].reverse().find((line) => /^\s*Tests\s+/.test(line));
  const testFilesLine = [...lines].reverse().find((line) => /^\s*Test Files\s+/.test(line));
  const summary = testsLine
    ? formatVitestSummary(parseCountLine(testsLine))
    : testFilesLine
      ? formatVitestSummary(parseCountLine(testFilesLine))
      : undefined;

  return { summary, failures };
}

function tailSummary(output: string): string {
  const text = stripAnsi(output).trim();
  if (!text) return "(no output)";
  return text.slice(Math.max(0, text.length - SUMMARY_TAIL_CHARS));
}

function scriptForKind(kind: CheckKind, script: string | undefined): string {
  if (kind === "script") {
    if (!script) throw new Error("run_checks kind=script requires script");
    if (script.startsWith("-")) {
      throw new Error(`run_checks rejects leading-dash script: ${script}`);
    }
    return script;
  }
  if (kind === "typecheck") return "check";
  return kind;
}

function availableScripts(packageJson: PackageJson): string[] {
  return Object.keys(packageJson.scripts ?? {}).sort();
}

function commandText(script: string, workspace: string | undefined): string {
  return workspace ? `npm run ${script} --workspace ${workspace}` : `npm run ${script}`;
}

async function readPackageJson(dir: string): Promise<PackageJson> {
  const file = resolveToolPath(dir, "package.json");
  return JSON.parse(await fs.readFile(file, "utf8")) as PackageJson;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function workspacePatterns(packageJson: PackageJson): string[] {
  const workspaces = packageJson.workspaces;
  if (Array.isArray(workspaces)) return workspaces;
  return workspaces?.packages ?? [];
}

async function expandWorkspacePattern(root: string, pattern: string): Promise<string[]> {
  if (pattern.endsWith("/*")) {
    const base = resolveToolPath(root, pattern.slice(0, -2));
    if (!(await pathExists(base))) return [];
    const entries = await fs.readdir(base, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(base, entry.name));
  }
  return [resolveToolPath(root, pattern)];
}

async function workspacePackages(root: string, rootPackageJson: PackageJson): Promise<WorkspacePackage[]> {
  const packages: WorkspacePackage[] = [];
  for (const pattern of workspacePatterns(rootPackageJson)) {
    for (const dir of await expandWorkspacePattern(root, pattern)) {
      if (!(await pathExists(resolveToolPath(dir, "package.json")))) continue;
      packages.push({
        dir,
        relativeDir: path.relative(root, dir),
        packageJson: await readPackageJson(dir),
      });
    }
  }
  return packages;
}

function matchesWorkspace(workspace: WorkspacePackage, selector: string): boolean {
  return selector === workspace.relativeDir
    || selector === path.basename(workspace.relativeDir)
    || selector === workspace.packageJson.name;
}

async function packageForRequest(root: string, workspace: string | undefined): Promise<PackageJson> {
  const rootPackageJson = await readPackageJson(root);
  if (!workspace) return rootPackageJson;

  const match = (await workspacePackages(root, rootPackageJson))
    .find((candidate) => matchesWorkspace(candidate, workspace));
  if (!match) {
    throw new Error(`Workspace '${workspace}' was not found from ${root}`);
  }
  return match.packageJson;
}

function capOutput(text: string): { text: string; truncated: boolean } {
  const capped = truncate(text);
  return { text: capped, truncated: capped !== text };
}

function runNpm(root: string, args: string[], timeoutMs: number): Promise<CheckRunResult> {
  return new Promise((resolve) => {
    const child = spawn("npm", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let outputCapped = false;
    let timedOut = false;

    const append = (chunk: Buffer) => {
      if (outputCapped) return;
      output += chunk.toString("utf8");
      outputCapped = output.length > MAX_TOOL_OUTPUT;
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      const capped = capOutput(output);
      resolve({
        output: timedOut ? `${capped.text}\n[timed out after ${timeoutMs}ms]` : capped.text,
        exitCode: code,
        timedOut,
        truncated: outputCapped || capped.truncated,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ output: String(err), exitCode: null, timedOut: false, truncated: false });
    });
  });
}

function timeoutMs(timeoutSeconds: number | undefined): number {
  if (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds)) {
    return DEFAULT_TIMEOUT_SECONDS * 1000;
  }
  return Math.max(1, Math.trunc(timeoutSeconds)) * 1000;
}

async function repoRoot(cwd: string): Promise<string> {
  const result = await new Promise<CheckRunResult>((resolve) => {
    const child = spawn("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.on("close", (code) => {
      resolve({ output: truncate(output), exitCode: code, timedOut: false, truncated: output.length > MAX_TOOL_OUTPUT });
    });
    child.on("error", (err) => {
      resolve({ output: String(err), exitCode: null, timedOut: false, truncated: false });
    });
  });
  if (result.exitCode !== 0) {
    throw new Error(`Working directory is not a git repository: ${cwd}`);
  }
  return result.output.trim();
}

function detailsForMissingScript(
  kind: CheckKind,
  workspace: string | undefined,
  script: string,
  scripts: string[],
): RunChecksDetails {
  const summary = scripts.length > 0
    ? `Script '${script}' was not found. Available scripts: ${scripts.join(", ")}.`
    : `Script '${script}' was not found. No scripts are available.`;
  return {
    command: commandText(script, workspace),
    kind,
    workspace,
    exitCode: null,
    passed: false,
    timedOut: false,
    truncated: false,
    summary,
    failures: [],
    availableScripts: scripts,
  };
}

function renderSummary(details: RunChecksDetails): string {
  const status = details.passed ? "passed" : "failed";
  const lines = [`run_checks ${status}: ${details.command}`, details.summary];
  if (details.failures.length > 0) {
    lines.push("failures:");
    lines.push(...details.failures.slice(0, MAX_FAILURES_IN_TEXT).map((failure) => `- ${failure}`));
  }
  return truncate(lines.join("\n"));
}

export function createRunChecksTool(cwd: string): AgentTool<typeof checkParams> {
  return {
    name: "run_checks",
    label: "Run checks",
    description:
      "Run a project test/build/lint/typecheck/package script in the session working directory repo. Returns a structured pass/fail verdict with concise output summary.",
    parameters: checkParams,
    execute: async (_id, params) => {
      const root = await repoRoot(cwd);
      const kind = params.kind as CheckKind;
      const script = scriptForKind(kind, params.script);
      const packageJson = await packageForRequest(root, params.workspace);
      const scripts = availableScripts(packageJson);

      if (!scripts.includes(script)) {
        const details = detailsForMissingScript(kind, params.workspace, script, scripts);
        return { content: [{ type: "text", text: renderSummary(details) }], details };
      }

      const args = ["run", script];
      if (params.workspace) args.push("--workspace", params.workspace);
      const result = await runNpm(root, args, timeoutMs(params.timeoutSeconds));
      const parsed = parseVitestOutput(result.output);
      const summary = parsed.summary ?? tailSummary(result.output);
      const details: RunChecksDetails = {
        command: commandText(script, params.workspace),
        kind,
        workspace: params.workspace,
        exitCode: result.exitCode,
        passed: result.exitCode === 0,
        timedOut: result.timedOut,
        truncated: result.truncated,
        summary,
        failures: parsed.failures,
      };

      return { content: [{ type: "text", text: renderSummary(details) }], details };
    },
  };
}
