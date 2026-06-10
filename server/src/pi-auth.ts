import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getEnvApiKey } from "@earendil-works/pi-ai";
import { getOAuthApiKey, type OAuthCredentials } from "@earendil-works/pi-ai/oauth";

export function defaultPiAuthPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "auth.json");
}

type AuthEntry = { type?: string } & Record<string, unknown>;
type AuthFile = Record<string, AuthEntry>;

/**
 * Read-mostly view over the pi CLI's OAuth credential store
 * (~/.pi/agent/auth.json). ytsejam never runs login flows; it only consumes
 * credentials pi created, refreshing and writing back expired tokens so the
 * two tools share one store.
 */
export class PiAuthStore {
  private readonly authPath: string;

  constructor(authPath: string) {
    this.authPath = authPath;
  }

  private readFile(): AuthFile {
    try {
      return JSON.parse(fs.readFileSync(this.authPath, "utf8")) as AuthFile;
    } catch {
      // missing file or unparseable JSON: no credentials, never an error
      return {};
    }
  }

  hasCredentials(provider: string): boolean {
    return this.readFile()[provider]?.type === "oauth";
  }

  getCredentials(provider: string): OAuthCredentials | undefined {
    const entry = this.readFile()[provider];
    return entry?.type === "oauth" ? (entry as unknown as OAuthCredentials) : undefined;
  }

  /**
   * Resolve an API key, refreshing via pi-ai when expired. Refreshed
   * credentials are persisted back to the auth file (whole-file write, 0600).
   * Returns undefined on any failure — callers treat that as "no key".
   */
  async getApiKey(provider: string): Promise<string | undefined> {
    // the read-modify-write below is not concurrency-safe: simultaneous
    // refreshes (in-process or vs the pi CLI) are last-writer-wins; the
    // loser self-heals by refreshing again on its next request
    const file = this.readFile();
    const entry = file[provider];
    if (entry?.type !== "oauth") return undefined;
    const creds = entry as unknown as OAuthCredentials;
    try {
      const result = await getOAuthApiKey(provider, { [provider]: creds });
      if (!result) return undefined;
      if (result.newCredentials.access !== creds.access) {
        file[provider] = { ...entry, ...result.newCredentials, type: "oauth" };
        fs.writeFileSync(this.authPath, JSON.stringify(file, null, 2), { mode: 0o600 });
      }
      return result.apiKey;
    } catch (err) {
      console.warn(
        `OAuth token resolution failed for ${provider}; re-authenticate with the pi CLI (run \`pi\` and use /login). Cause: ${err instanceof Error ? err.message : err}`,
      );
      return undefined;
    }
  }
}

/** Env keys win; pi OAuth credentials are the fallback. */
export async function resolveApiKey(provider: string, store: PiAuthStore): Promise<string | undefined> {
  return getEnvApiKey(provider) ?? (await store.getApiKey(provider));
}
