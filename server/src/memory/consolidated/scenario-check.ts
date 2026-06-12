import type { ScenarioCheckResult } from "../types.ts";
import { extractFrontmatter, markdownFiles, readRel, todayUtc, validateParams } from "./common.ts";

export async function scenarioCheck(params: Record<string, unknown> = {}): Promise<ScenarioCheckResult> {
  validateParams(params, []);
  const today = todayUtc();
  const scenarios = [];
  for (const f of await markdownFiles("cog-meta/scenarios")) {
    const data = await readRel(f.rel); if (data == null) continue;
    const fm = extractFrontmatter(data); if (!fm) continue;
    const rawStatus = typeof fm.status === "string" ? fm.status.trim() : "";
    if (rawStatus && rawStatus !== "active") continue;
    const checkBy = typeof fm["check-by"] === "string" ? fm["check-by"].trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checkBy)) continue;
    const check = new Date(`${checkBy}T00:00:00Z`); if (Number.isNaN(check.getTime())) continue;
    const days = Math.floor((check.getTime() - today.getTime()) / 86400000);
    scenarios.push({ path: f.rel, check_by: checkBy, due: checkBy, status: days < 0 ? "overdue" : days === 0 ? "due_now" : "active", days_until_check: days });
  }
  scenarios.sort((a,b) => a.path.localeCompare(b.path));
  return { scenarios };
}
