import type { ListResult } from "../types.ts";
import { scanFiles } from "./walk.ts";

export async function list(): Promise<ListResult> {
  return { paths: (await scanFiles({ markdownOnly: true })).map((f) => f.rel) };
}
