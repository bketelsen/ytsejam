import type { WriteResult } from "../types.ts";
import { atomicWrite } from "./fs.ts";
import { resolveMemoryPath, validateWholeFileWritePath } from "./paths.ts";

export async function write(path: string, content: string): Promise<WriteResult> {
  const { abs, rel } = await resolveMemoryPath(path);
  await validateWholeFileWritePath(rel);
  await atomicWrite(abs, content);
  return { bytes: Buffer.byteLength(content) };
}
