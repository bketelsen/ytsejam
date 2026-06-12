import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export async function atomicWrite(abs: string, content: string): Promise<void> {
  await mkdir(dirname(abs), { recursive: true, mode: 0o755 });
  const tmp = `${abs}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, "utf8");
  try {
    await rename(tmp, abs);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export function splitLines(content: string): string[] {
  const lines = content.split("\n");
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}

export function countLines(content: Buffer | string): number {
  const s = content.toString();
  if (s.length === 0) return 0;
  const n = (s.match(/\n/g) ?? []).length;
  return s.endsWith("\n") ? n : n + 1;
}
