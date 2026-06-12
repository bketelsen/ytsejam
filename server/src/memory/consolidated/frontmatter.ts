import { parse } from "yaml";

export function parseFrontmatter(content: string): Record<string, unknown> | null {
  const text = content.replace(/^\ufeff/, "");
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  const maybeComment = lines[i]?.trim() ?? "";
  if (maybeComment.startsWith("<!--") && maybeComment.endsWith("-->")) i++;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (lines[i]?.trim() !== "---") return null;
  const start = i + 1;
  for (let j = start; j < lines.length; j++) {
    if (lines[j].trim() !== "---") continue;
    try {
      const parsed = parse(lines.slice(start, j).join("\n"));
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return null;
}

export const stringField = (fm: Record<string, unknown>, key: string): string | undefined =>
  typeof fm[key] === "string" ? fm[key] : undefined;

export const numberField = (fm: Record<string, unknown>, key: string): number | undefined =>
  typeof fm[key] === "number" && Number.isFinite(fm[key]) ? fm[key] : undefined;

export const stringArrayField = (fm: Record<string, unknown>, key: string): string[] | undefined =>
  Array.isArray(fm[key]) && fm[key].every((v) => typeof v === "string") ? [...fm[key]] : undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
