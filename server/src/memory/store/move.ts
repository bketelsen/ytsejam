import { mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { OkResult } from "../types.ts";
import { maybeAutoCommit } from "./auto-commit.ts";
import { resolveMemoryPath, validateWholeFileWritePath } from "./paths.ts";

/**
 * Rename a file within the memory root. Rejects if the destination exists
 * or escapes the root.
 *
 * **Intentional divergence from Go:** this also enforces the whole-file
 * write allow-list against the destination — `move` cannot land canonical
 * content (`observations.md`, hot-memory, etc.) at a non-allow-listed path.
 * Go's `store.Move` had no such check; the tightening closes a
 * "move-as-backdoor-around-the-write-allow-list" gap. PR-3 cutover note:
 * housekeeping/migration flows that legitimately move canonical files must
 * use `append`/`patch` or a specialized archival API, not `move`.
 */
export async function move(from: string, to: string): Promise<OkResult> {
  const src = await resolveMemoryPath(from);
  const dst = await resolveMemoryPath(to);
  await validateWholeFileWritePath(dst.rel);
  try { await stat(dst.abs); throw new Error(`store: move destination exists: ${JSON.stringify(dst.rel)}`); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  await mkdir(dirname(dst.abs), { recursive: true, mode: 0o755 });
  await rename(src.abs, dst.abs);
  await maybeAutoCommit();
  return { ok: true };
}
