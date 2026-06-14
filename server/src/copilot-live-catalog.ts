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

import { getModels, type Model } from "@earendil-works/pi-ai";
import { getOAuthProvider } from "@earendil-works/pi-ai/oauth";
import type { PiAuthStore } from "./pi-auth.ts";

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


export interface LoadOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

interface CopilotModelsListEntry {
  id?: unknown;
  policy?: { state?: unknown } | unknown;
  model_picker_enabled?: unknown;
}

interface CopilotModelsListResponse {
  data?: CopilotModelsListEntry[];
}

export function sanitize(cause: unknown): string {
  // Defensive — never leak the OAuth token even on error. fetch error messages
  // typically don't include the body, but be paranoid.
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
}

function resolveBaseUrl(auth: PiAuthStore): string {
  // Reuse the pi-ai OAuth provider's modifyModels hook to compute the
  // correct enterprise-vs-individual baseUrl for this token. We probe with
  // a placeholder model record so we don't depend on getModels() ordering.
  const provider = getOAuthProvider("github-copilot");
  const creds = auth.getCredentials("github-copilot");
  if (!provider?.modifyModels || !creds) return DEFAULT_COPILOT_BASE_URL;
  const probe = [{ id: "_probe", provider: "github-copilot", baseUrl: DEFAULT_COPILOT_BASE_URL } as any];
  return provider.modifyModels(probe, creds)[0]?.baseUrl ?? DEFAULT_COPILOT_BASE_URL;
}

export async function loadLiveCopilotModels(
  auth: PiAuthStore,
  opts: LoadOptions = {},
): Promise<MergeResult> {
  const empty: MergeResult = { overlay: [], prunedIds: new Set() };

  if (process.env.YTSEJAM_DISABLE_COPILOT_LIVE_CATALOG === "1") {
    console.info("github-copilot live catalog disabled by env; using static catalog only");
    return empty;
  }

  let hasCopilotCredentials: boolean;
  try {
    hasCopilotCredentials = auth.hasCredentials("github-copilot");
  } catch (err) {
    console.warn(`github-copilot credential check failed: ${sanitize(err)}; live model catalog skipped`);
    return empty;
  }

  if (!hasCopilotCredentials) {
    console.info("github-copilot OAuth not configured; live model catalog skipped");
    return empty;
  }

  let apiKey: string | undefined;
  try {
    apiKey = await auth.getApiKey("github-copilot");
  } catch (err) {
    console.warn(`github-copilot OAuth token refresh failed: ${sanitize(err)}; live model catalog skipped`);
    return empty;
  }
  if (!apiKey) {
    console.warn("github-copilot OAuth token refresh returned no key; live model catalog skipped");
    return empty;
  }

  let baseUrl: string;
  try {
    baseUrl = resolveBaseUrl(auth);
  } catch (err) {
    console.warn(`github-copilot baseUrl resolution failed: ${sanitize(err)}; live model catalog skipped`);
    return empty;
  }

  const fetchImpl = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...COPILOT_HEADERS,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    console.warn(`github-copilot /models fetch failed: ${sanitize(err)}; using static catalog`);
    return empty;
  }

  if (!res.ok) {
    console.warn(`github-copilot /models returned HTTP ${res.status}; using static catalog`);
    return empty;
  }

  let body: CopilotModelsListResponse;
  try {
    body = (await res.json()) as CopilotModelsListResponse;
  } catch (err) {
    console.warn(`github-copilot /models response malformed (parse error): ${sanitize(err)}; using static catalog`);
    return empty;
  }

  if (!body || !Array.isArray(body.data)) {
    console.warn("github-copilot /models response malformed (no data[]); using static catalog");
    return empty;
  }

  const liveIds: string[] = [];
  for (const entry of body.data) {
    if (!entry || typeof entry !== "object") continue;
    const id = entry.id;
    if (typeof id !== "string") continue;
    const policy = (entry.policy as { state?: unknown } | undefined)?.state;
    const picker = entry.model_picker_enabled;
    if (policy !== "enabled") continue;
    if (picker !== true) continue;
    liveIds.push(id);
  }

  try {
    const staticCopilot = getModels("github-copilot" as any) as Model<any>[];
    const merged = mergeCatalogs(staticCopilot, liveIds);
    console.info(
      `github-copilot live catalog: ${liveIds.length} live models, ${merged.overlay.length} added (sibling-inherited), ${merged.prunedIds.size} pruned`,
    );
    return merged;
  } catch (err) {
    console.warn(`github-copilot live catalog merge failed: ${sanitize(err)}; using static catalog`);
    return empty;
  }
}
