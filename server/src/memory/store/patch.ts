import { readFile } from "node:fs/promises";
import type { OkResult } from "../types.ts";
import { atomicWrite } from "./fs.ts";
import { maybeAutoCommit } from "./auto-commit.ts";
import { withFileLock } from "./file-lock.ts";
import { resolveMemoryPath } from "./paths.ts";

export async function patch(path: string, oldText: string, newText: string): Promise<OkResult> {
  const { abs, rel } = await resolveMemoryPath(path);
  // Serialize the whole read-modify-write so a concurrent append/patch/write to
  // the same file can't clobber this edit (lost update). The match-count check
  // must see the same `content` we write back.
  await withFileLock(abs, async () => {
    const content = await readFile(abs, "utf8");
    const count = oldText === "" ? 0 : content.split(oldText).length - 1;
    if (count === 0) throw new Error(`store: patch: oldText not found in ${JSON.stringify(rel)}`);
    if (count >= 2) throw new Error(`store: patch: oldText appears ${count} times in ${JSON.stringify(rel)} (must appear exactly once)`);
    await atomicWrite(abs, content.replace(oldText, newText));
  });
  await maybeAutoCommit();
  return { ok: true };
}
