import type { WriteResult } from "../types.ts";
import { validateManifestContent } from "../domain/manifest.ts";
import { atomicWrite } from "./fs.ts";
import { maybeAutoCommit } from "./auto-commit.ts";
import { withFileLock } from "./file-lock.ts";
import { resolveMemoryPath, validateWholeFileWritePath } from "./paths.ts";

export async function write(path: string, content: string): Promise<WriteResult> {
  const { abs, rel } = await resolveMemoryPath(path);
  await validateWholeFileWritePath(rel);
  // Manifest writes get content-validated before they ever reach disk:
  // a bad manifest landing silently would surface as an "unknown id" error
  // on the next routing RPC — too far from cause.
  if (rel === "domains.yml") {
    validateManifestContent(content);
  }
  // Serialize against concurrent mutations of the same file (lost-update guard).
  await withFileLock(abs, () => atomicWrite(abs, content));
  await maybeAutoCommit();
  return { bytes: Buffer.byteLength(content) };
}
