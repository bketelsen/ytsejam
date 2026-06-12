import { readFile } from "node:fs/promises";
import type { OkResult } from "../types.ts";
import { atomicWrite } from "./fs.ts";
import { resolveMemoryPath } from "./paths.ts";

export async function patch(path: string, oldText: string, newText: string): Promise<OkResult> {
  const { abs, rel } = await resolveMemoryPath(path);
  const content = await readFile(abs, "utf8");
  const count = oldText === "" ? 0 : content.split(oldText).length - 1;
  if (count === 0) throw new Error(`store: patch: oldText not found in ${JSON.stringify(rel)}`);
  if (count >= 2) throw new Error(`store: patch: oldText appears ${count} times in ${JSON.stringify(rel)} (must appear exactly once)`);
  await atomicWrite(abs, content.replace(oldText, newText));
  return { ok: true };
}
