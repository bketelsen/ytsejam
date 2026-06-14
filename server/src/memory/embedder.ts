import {
  HashEmbedder,
  CachedEmbedder,
  OllamaEmbedder,
  CopilotEmbedder,
  type Embedder,
} from "ltm";

export type LtmEmbedderMode = "auto" | "copilot" | "ollama" | "hash";

export interface LtmEmbedderOptions {
  mode: LtmEmbedderMode;
  cacheDir: string;
  copilot?: { model?: string; baseUrl?: string };
  ollama?: { model?: string; baseUrl?: string };
}

export interface AuthStoreLike {
  hasCredentials(provider: string): boolean;
  getApiKey(provider: string): Promise<string | undefined>;
}

export interface LtmEmbedderResult {
  embedder: Embedder;
  label: string;
  dimension: number;
}

export async function createLtmEmbedder(
  auth: AuthStoreLike,
  opts: LtmEmbedderOptions,
): Promise<LtmEmbedderResult> {
  const mode = opts.mode;

  if (mode === "hash") {
    return wrapHash(opts.cacheDir);
  }
  if (mode === "copilot") {
    if (!auth.hasCredentials("github-copilot")) {
      throw new Error(
        `YTSEJAM_LTM_EMBEDDER=copilot but no github-copilot OAuth credentials in PiAuthStore. ` +
          `Run \`pi\` and \`/login\` to obtain credentials, or set YTSEJAM_LTM_EMBEDDER=ollama|hash to opt down.`,
      );
    }
    return wrapCopilot(auth, opts);
  }
  if (mode === "ollama") {
    try {
      return await wrapOllama(opts);
    } catch (err) {
      throw new Error(
        `YTSEJAM_LTM_EMBEDDER=ollama but ${opts.ollama?.baseUrl ?? "http://localhost:11434"} is not reachable: ${(err as Error).message}. ` +
          `Start the Ollama service, or set YTSEJAM_LTM_EMBEDDER=hash|auto|copilot to opt down.`,
      );
    }
  }

  // auto mode: probe in order copilot -> ollama -> hash
  if (auth.hasCredentials("github-copilot")) {
    try {
      return await wrapCopilot(auth, opts);
    } catch (err) {
      console.warn(
        `[ltm embedder auto] Copilot creds present but probe failed: ${(err as Error).message}. Falling through.`,
      );
    }
  }
  try {
    return await wrapOllama(opts);
  } catch (err) {
    console.warn(`[ltm embedder auto] Ollama probe failed: ${(err as Error).message}. Falling through.`);
  }
  console.warn(
    `[ltm embedder auto] Falling back to HashEmbedder (no Copilot creds, no Ollama service). ` +
      `Semantic recall will be degraded. Set YTSEJAM_LTM_EMBEDDER=copilot or =ollama to require a real embedder.`,
  );
  return wrapHash(opts.cacheDir);
}

function wrapHash(cacheDir: string): LtmEmbedderResult {
  const inner = new HashEmbedder();
  const namespace = `hash:${inner.dimension}`;
  return {
    embedder: new CachedEmbedder(inner, cacheDir, namespace),
    label: namespace,
    dimension: inner.dimension,
  };
}

async function wrapCopilot(auth: AuthStoreLike, opts: LtmEmbedderOptions): Promise<LtmEmbedderResult> {
  const inner = await CopilotEmbedder.create({
    getApiKey: () => auth.getApiKey("github-copilot"),
    model: opts.copilot?.model ?? "text-embedding-3-small",
    baseUrl: opts.copilot?.baseUrl,
  });
  const namespace = `copilot:${inner.modelName}`;
  return {
    embedder: new CachedEmbedder(inner, opts.cacheDir, namespace),
    label: namespace,
    dimension: inner.dimension,
  };
}

async function wrapOllama(opts: LtmEmbedderOptions): Promise<LtmEmbedderResult> {
  const inner = await OllamaEmbedder.create({
    model: opts.ollama?.model ?? "nomic-embed-text:latest",
    baseUrl: opts.ollama?.baseUrl,
  });
  const namespace = `ollama:${inner.modelName}`;
  return {
    embedder: new CachedEmbedder(inner, opts.cacheDir, namespace),
    label: namespace,
    dimension: inner.dimension,
  };
}

export function parseLtmEmbedderMode(raw: string | undefined): LtmEmbedderMode {
  const v = (raw ?? "auto").trim().toLowerCase();
  if (v === "auto" || v === "copilot" || v === "ollama" || v === "hash") return v;
  throw new Error(`Invalid YTSEJAM_LTM_EMBEDDER=${raw}. Valid: auto, copilot, ollama, hash.`);
}
