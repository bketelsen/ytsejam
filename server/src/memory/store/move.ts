import { mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { OkResult } from "../types.ts";
import { resolveMemoryPath, validateWholeFileWritePath } from "./paths.ts";

export async function move(from: string, to: string): Promise<OkResult> {
  const src = await resolveMemoryPath(from);
  const dst = await resolveMemoryPath(to);
  await validateWholeFileWritePath(dst.rel);
  try { await stat(dst.abs); throw new Error(`store: move destination exists: ${JSON.stringify(dst.rel)}`); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  await mkdir(dirname(dst.abs), { recursive: true, mode: 0o755 });
  await rename(src.abs, dst.abs);
  return { ok: true };
}
