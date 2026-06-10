import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerOAuthProvider,
  unregisterOAuthProvider,
  type OAuthCredentials,
  type OAuthProviderInterface,
} from "@earendil-works/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PiAuthStore, resolveApiKey } from "../src/pi-auth.ts";

const PROVIDER_ID = "fake-oauth";
let refreshCalls = 0;
let refreshShouldFail = false;

const fakeProvider: OAuthProviderInterface = {
  id: PROVIDER_ID,
  name: "Fake OAuth",
  login: async () => {
    throw new Error("not used");
  },
  refreshToken: async (creds: OAuthCredentials) => {
    refreshCalls++;
    if (refreshShouldFail) throw new Error("refresh denied");
    return { ...creds, access: "refreshed-access", expires: Date.now() + 3_600_000 };
  },
  getApiKey: (creds) => creds.access,
};

function authFile(entries: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-auth-"));
  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify(entries, null, 2));
  return path;
}

const validEntry = {
  type: "oauth",
  access: "live-access",
  refresh: "refresh-token",
  expires: Date.now() + 3_600_000,
};

const expiredEntry = { ...validEntry, access: "stale-access", expires: Date.now() - 1000 };

beforeEach(() => {
  refreshCalls = 0;
  refreshShouldFail = false;
  registerOAuthProvider(fakeProvider);
});
afterEach(() => unregisterOAuthProvider(PROVIDER_ID));

describe("PiAuthStore", () => {
  test("returns the access token for valid credentials without refreshing", async () => {
    const store = new PiAuthStore(authFile({ [PROVIDER_ID]: validEntry }));
    expect(store.hasCredentials(PROVIDER_ID)).toBe(true);
    expect(await store.getApiKey(PROVIDER_ID)).toBe("live-access");
    expect(refreshCalls).toBe(0);
  });

  test("refreshes expired credentials and persists them to disk", async () => {
    const path = authFile({ [PROVIDER_ID]: expiredEntry, other: { type: "api_key", key: "x" } });
    const store = new PiAuthStore(path);
    expect(await store.getApiKey(PROVIDER_ID)).toBe("refreshed-access");
    expect(refreshCalls).toBe(1);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written[PROVIDER_ID].access).toBe("refreshed-access");
    expect(written[PROVIDER_ID].type).toBe("oauth");
    expect(written.other).toEqual({ type: "api_key", key: "x" }); // untouched entries preserved
  });

  test("missing file, unknown provider, and non-oauth entries yield undefined", async () => {
    const missing = new PiAuthStore("/nonexistent/dir/auth.json");
    expect(missing.hasCredentials(PROVIDER_ID)).toBe(false);
    expect(await missing.getApiKey(PROVIDER_ID)).toBeUndefined();

    const store = new PiAuthStore(authFile({ other: { type: "api_key", key: "x" } }));
    expect(await store.getApiKey(PROVIDER_ID)).toBeUndefined();
    expect(await store.getApiKey("other")).toBeUndefined(); // api_key entries ignored per spec
  });

  test("refresh failure returns undefined instead of throwing", async () => {
    refreshShouldFail = true;
    const store = new PiAuthStore(authFile({ [PROVIDER_ID]: expiredEntry }));
    await expect(store.getApiKey(PROVIDER_ID)).resolves.toBeUndefined();
  });

  test("getCredentials returns the raw oauth entry", () => {
    const store = new PiAuthStore(authFile({ [PROVIDER_ID]: validEntry }));
    expect(store.getCredentials(PROVIDER_ID)?.access).toBe("live-access");
    expect(store.getCredentials("nope")).toBeUndefined();
  });
});

describe("resolveApiKey", () => {
  test("prefers env keys, falls back to the oauth store", async () => {
    const store = new PiAuthStore(authFile({ [PROVIDER_ID]: validEntry }));
    // PROVIDER_ID has no env var mapping, so env lookup is undefined → oauth fallback
    expect(await resolveApiKey(PROVIDER_ID, store)).toBe("live-access");
    // a provider with neither env key nor credentials → undefined
    expect(await resolveApiKey("mistral", store)).toBeUndefined();
  });
});
