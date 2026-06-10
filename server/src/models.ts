import { getEnvApiKey, getModels, getProviders, type Model } from "@earendil-works/pi-ai";

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  ref: string; // "provider/id"
}

export type ModelResolver = (ref: string) => Model<any>;

export function resolveModel(ref: string): Model<any> {
  const slash = ref.indexOf("/");
  if (slash <= 0) throw new Error(`Model ref must be "provider/modelId", got: ${ref}`);
  const provider = ref.slice(0, slash);
  const modelId = ref.slice(slash + 1);
  const providers = getProviders() as string[];
  const model = providers.includes(provider)
    ? (getModels(provider as any) as Model<any>[]).find((m) => m.id === modelId)
    : undefined;
  if (!model) throw new Error(`Unknown model: ${ref}`);
  return model;
}

export function listAvailableModels(opts?: { env?: Record<string, string | undefined> }): ModelInfo[] {
  // getEnvApiKey reads process.env; allow injecting an empty env for tests
  const hasKey = (provider: string) =>
    opts?.env ? Object.keys(opts.env).length > 0 : getEnvApiKey(provider) !== undefined;
  return (getProviders() as string[])
    .filter(hasKey)
    .flatMap((p) =>
      (getModels(p as any) as Model<any>[]).map((m) => ({
        provider: p,
        id: m.id,
        name: m.name,
        ref: `${p}/${m.id}`,
      })),
    );
}
