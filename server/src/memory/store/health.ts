import type { HealthResult } from "../types.ts";
import { memoryRoot } from "./paths.ts";
import { list } from "./list.ts";
import { git } from "./git.ts";

export async function health(): Promise<HealthResult> {
  let last_commit = "";
  try { last_commit = (await git({ op: "log", limit: 1 })).output.split(/\s+/, 1)[0] ?? ""; } catch { /* non-git roots are still readable */ }
  return { ok: true, files: (await list()).paths.length, last_commit, memory_root: memoryRoot() };
}
