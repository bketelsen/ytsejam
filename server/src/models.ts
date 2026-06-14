import { getEnvApiKey, getModels, getProviders, type Model } from "@earendil-works/pi-ai";
import { getOAuthProvider } from "@earendil-works/pi-ai/oauth";
import type { PiAuthStore } from "./pi-auth.ts";

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  ref: string; // "provider/id"
}

export type ModelResolver = (ref: string) => Model<any>;

export interface ResolveOptions {
  /** Additional models to search BEFORE pi-ai's static catalog. */
  overlay?: Model<any>[];
  /** Static-catalog ids the user's Copilot account doesn't entitle. */
  prunedIds?: Set<string>;
}

/**
 * Apply the OAuth provider's modifyModels hook (e.g. Copilot rewrites
 * baseUrl for individual vs business endpoints) when credentials exist.
 */
function applyOAuthModelOverrides(model: Model<any>, oauth?: PiAuthStore): Model<any> {
  if (!oauth) return model;
  const creds = oauth.getCredentials(model.provider);
  const provider = getOAuthProvider(model.provider);
  if (!creds || !provider?.modifyModels) return model;
  return provider.modifyModels([model], creds)[0] ?? model;
}

export function resolveModel(
  ref: string,
  oauth?: PiAuthStore,
  opts?: ResolveOptions,
): Model<any> {
  const slash = ref.indexOf("/");
  if (slash <= 0) throw new Error(`Model ref must be "provider/modelId", got: ${ref}`);
  const provider = ref.slice(0, slash);
  const modelId = ref.slice(slash + 1);

  // Pruned check fires before static lookup so the error is clearer than
  // "Unknown model:" for the raptor-mini ghost case.
  if (provider === "github-copilot" && opts?.prunedIds?.has(modelId)) {
    throw new Error(
      `Model ${ref} is in pi-ai's catalog but not in your Copilot entitlement. ` +
        `Restart ytsejam if you were recently enrolled, or pick a different model.`,
    );
  }

  // Overlay first (live-only ids and their inherited metadata).
  const overlayMatch = opts?.overlay?.find((m) => m.provider === provider && m.id === modelId);
  if (overlayMatch) return applyOAuthModelOverrides(overlayMatch, oauth);

  const providers = getProviders() as string[];
  const model = providers.includes(provider)
    ? (getModels(provider as any) as Model<any>[]).find((m) => m.id === modelId)
    : undefined;
  if (!model) throw new Error(`Unknown model: ${ref}`);
  return applyOAuthModelOverrides(model, oauth);
}

export function listAvailableModels(opts?: {
  /** key lookup per provider; defaults to pi-ai's process.env-based getEnvApiKey */
  getKey?: (provider: string) => string | undefined;
  /** pi CLI OAuth credentials; providers with credentials are available too */
  oauth?: PiAuthStore;
}): ModelInfo[] {
  const getKey = opts?.getKey ?? getEnvApiKey;
  const available = (provider: string) =>
    getKey(provider) !== undefined || (opts?.oauth?.hasCredentials(provider) ?? false);
  return (getProviders() as string[])
    .filter(available)
    .flatMap((p) =>
      (getModels(p as any) as Model<any>[]).map((m) => ({
        provider: p,
        id: m.id,
        name: m.name,
        ref: `${p}/${m.id}`,
      })),
    );
}
