/**
 * GitHub Copilot live model catalog — fetches the user's account-scoped
 * `/models` enumeration at boot and merges it with pi-ai's static catalog.
 *
 * See docs/plans/2026-06-14-copilot-live-catalog-design.md for the why.
 *
 * The standalone "live model" template for sibling inheritance: when Copilot
 * returns an id pi-ai doesn't know (e.g. `claude-opus-4.7-1m-internal`), we
 * find pi-ai's nearest sibling by longest-common-id-prefix (≥8 chars) and
 * copy its `api`/`headers`/`compat`/`baseUrl` so the new variant works from
 * the first call. No-sibling cases fall back to a type-by-prefix template.
 */

import type { Model } from "@earendil-works/pi-ai";

const PREFIX_FLOOR = 8;

const COPILOT_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};

const DEFAULT_COPILOT_BASE_URL = "https://api.individual.githubcopilot.com";

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function humanizeSuffix(liveId: string, siblingId: string): string {
  const suffix = liveId.slice(commonPrefixLen(liveId, siblingId)).replace(/^-/, "");
  return suffix || liveId;
}

function pickSibling(liveId: string, staticModels: Model<any>[]): Model<any> | undefined {
  let best: Model<any> | undefined;
  let bestLen = 0;
  for (const m of staticModels) {
    if (m.provider !== "github-copilot") continue;
    const len = commonPrefixLen(liveId, m.id);
    if (len > bestLen && len >= PREFIX_FLOOR) {
      best = m;
      bestLen = len;
    }
  }
  return best;
}

function makeFallbackTemplate(liveId: string): Model<any> {
  const isClaude = liveId.startsWith("claude-");
  return {
    id: liveId,
    name: liveId,
    api: isClaude ? "anthropic-messages" : "openai-completions",
    provider: "github-copilot",
    baseUrl: DEFAULT_COPILOT_BASE_URL,
    headers: COPILOT_HEADERS,
    input: ["text"],
  } as unknown as Model<any>;
}

export function inferModelTemplate(liveId: string, staticModels: Model<any>[]): Model<any> {
  const sibling = pickSibling(liveId, staticModels);
  if (!sibling) return makeFallbackTemplate(liveId);
  // Deep-ish clone via JSON round-trip — every field pi-ai uses is JSON-safe.
  const cloned = JSON.parse(JSON.stringify(sibling)) as Model<any>;
  cloned.id = liveId;
  const niceName = sibling.name || sibling.id;
  cloned.name = `${niceName} (${humanizeSuffix(liveId, sibling.id)})`;
  return cloned;
}

export interface MergeResult {
  /** Live-only ids synthesized into Model<any> records. */
  overlay: Model<any>[];
  /** Pi-ai catalog ids the user's Copilot account doesn't return. */
  prunedIds: Set<string>;
}

export function mergeCatalogs(
  staticModels: Model<any>[],
  liveIds: string[],
): MergeResult {
  const copilotStatic = staticModels.filter((m) => m.provider === "github-copilot");
  const staticIds = new Set(copilotStatic.map((m) => m.id));
  const liveSet = new Set(liveIds);

  const overlay: Model<any>[] = [];
  for (const id of liveIds) {
    if (staticIds.has(id)) continue;
    overlay.push(inferModelTemplate(id, copilotStatic));
  }

  const prunedIds = new Set<string>();
  for (const m of copilotStatic) {
    if (!liveSet.has(m.id)) prunedIds.add(m.id);
  }

  return { overlay, prunedIds };
}
