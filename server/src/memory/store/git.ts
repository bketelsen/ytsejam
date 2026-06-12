import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitParams, GitResult } from "../types.ts";
import { ensureRoot } from "./paths.ts";

const execFileAsync = promisify(execFile);

export async function git(params: GitParams): Promise<GitResult> {
  const root = await ensureRoot();
  const op = params.op;
  switch (op) {
    case "status": return { output: await run(root, ["status", "--short"]) };
    case "diff": return { output: await run(root, ["diff", ...(params.ref ? [params.ref] : []), ...((params.paths?.length ?? 0) ? ["--", ...params.paths!] : [])]) };
    case "log": return { output: await run(root, ["log", "--oneline", `-n${params.limit && params.limit > 0 ? params.limit : 20}`, ...(params.ref ? [params.ref] : [])]) };
    case "commit":
      if (!params.message) throw new Error("store: git commit requires message");
      await run(root, ["add", "-A"]);
      return { output: await run(root, ["commit", "-m", params.message]) };
    case "revert":
      const target = params.commit ?? params.ref;
      if (!target) throw new Error("store: git revert requires commit");
      return { output: await run(root, ["revert", "--no-edit", target]) };
    default: throw new Error(`store: git: unknown op ${(op as string)}`);
  }
}

async function run(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
    return `${stdout}${stderr}`.trim();
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string };
    throw new Error(`store: git ${args[0]}: ${e.message}: ${`${e.stdout ?? ""}${e.stderr ?? ""}`.trim()}`);
  }
}
