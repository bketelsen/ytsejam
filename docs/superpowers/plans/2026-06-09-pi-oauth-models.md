# pi OAuth (Copilot/Codex) Model Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GitHub Copilot and OpenAI Codex subscription models usable in ytsejam by reading (and refresh-updating) the pi CLI's OAuth credential store.

**Architecture:** A new `PiAuthStore` module reads `~/.pi/agent/auth.json`, resolves API keys via `@earendil-works/pi-ai/oauth`'s `getOAuthApiKey` (which auto-refreshes), and persists refreshed tokens back. It plugs into two existing seams: `getApiKeyAndHeaders` in `AgentManager` (env key first, OAuth fallback) and model availability/resolution in `models.ts` (OAuth-credentialed providers become available; Copilot's `modifyModels` baseUrl rewrite is applied at resolution). Spec: `docs/superpowers/specs/2026-06-09-pi-oauth-models-design.md`.

**Tech Stack:** Existing server stack (Node 26 native TS, vitest). No new dependencies — `@earendil-works/pi-ai/oauth` is a subpath of an installed package.

**Verified API facts (pi-ai v0.79.1; if something doesn't compile, check `node_modules/@earendil-works/pi-ai/dist/oauth.d.ts` — never guess):**

- `@earendil-works/pi-ai/oauth` exports: `getOAuthApiKey(providerId, credentials: Record<string, OAuthCredentials>) → Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null>` (refreshes when `Date.now() >= creds.expires`; throws when refresh fails or provider id is unregistered), `getOAuthProvider(id)`, `registerOAuthProvider(p)`, `unregisterOAuthProvider(id)`, and type `OAuthCredentials = { refresh: string; access: string; expires: number; [key: string]: unknown }`.
- `OAuthProviderInterface` (for the test fake): `{ id, name, login(callbacks), refreshToken(creds) → Promise<OAuthCredentials>, getApiKey(creds) → string, modifyModels?(models, creds) → Model[] }`.
- Built-in providers `anthropic`, `github-copilot`, `openai-codex` are pre-registered in the module-level registry.
- pi's auth file (`~/.pi/agent/auth.json`, mode 0600) maps provider id → entry; OAuth entries are `{ "type": "oauth", access, refresh, expires, ... }` (other types like `"api_key"` exist — ignore them per spec).
- The pi-ai model catalog already includes `github-copilot/*` and `openai-codex/*` models via `getModels(provider)`.

**Conventions:** branch `feat/pi-oauth-models` (already created, spec committed). Node runs TS directly; imports use `.ts` extensions; `erasableSyntaxOnly` forbids constructor parameter properties. Tests: `cd server && npm test` (currently 41 green). Types: `npm run check`. TDD per task. Never push; don't touch web/ (no UI changes).

---

### Task 1: PiAuthStore

**Files:**
- Create: `server/src/pi-auth.ts`
- Test: `server/test/pi-auth.test.ts`

- [ ] **Step 1: Write the failing tests**

`server/test/pi-auth.test.ts`:

```ts
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
```

(The `resolveApiKey` env-preference half relies on `getEnvApiKey` returning undefined for these providers in the test environment; do NOT set provider env vars in this test file. `mistral` is a real provider id with no `MISTRAL_API_KEY` set in CI/dev — if your environment has one set, pick another keyless provider.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/bjk/projects/ytsejam/server && npx vitest --run test/pi-auth.test.ts`
Expected: FAIL — cannot find module `../src/pi-auth.ts`.

- [ ] **Step 3: Implement**

`server/src/pi-auth.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest --run test/pi-auth.test.ts`
Expected: 6 tests PASS. Also run `npm run check` — clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/pi-auth.ts server/test/pi-auth.test.ts
git commit -m "feat: PiAuthStore reading pi CLI OAuth credentials"
```

---

### Task 2: OAuth-aware model availability and resolution

**Files:**
- Modify: `server/src/models.ts`
- Test: `server/test/models.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `server/test/models.test.ts` (and add the new imports at the top of the file):

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerOAuthProvider,
  unregisterOAuthProvider,
  type OAuthProviderInterface,
} from "@earendil-works/pi-ai/oauth";
import { PiAuthStore } from "../src/pi-auth.ts";
```

```ts
describe("OAuth-aware models", () => {
  function storeWith(entries: Record<string, unknown>): PiAuthStore {
    const dir = mkdtempSync(join(tmpdir(), "models-oauth-"));
    const path = join(dir, "auth.json");
    writeFileSync(path, JSON.stringify(entries));
    return new PiAuthStore(path);
  }

  const creds = {
    type: "oauth",
    access: "tok",
    refresh: "r",
    expires: Date.now() + 3_600_000,
  };

  test("OAuth credentials make a catalog provider available", () => {
    const store = storeWith({ "github-copilot": creds });
    const models = listAvailableModels({ getKey: () => undefined, oauth: store });
    expect(models.length).toBeGreaterThan(0);
    expect(new Set(models.map((m) => m.provider))).toEqual(new Set(["github-copilot"]));
  });

  test("resolveModel applies the OAuth provider's modifyModels hook", () => {
    const modifying: OAuthProviderInterface = {
      id: "github-copilot",
      name: "Copilot (test override)",
      login: async () => {
        throw new Error("not used");
      },
      refreshToken: async (c) => c,
      getApiKey: (c) => c.access,
      modifyModels: (models) => models.map((m) => ({ ...m, baseUrl: "https://modified.example" })),
    };
    // replace the built-in copilot provider for this test, restore after
    registerOAuthProvider(modifying);
    try {
      const store = storeWith({ "github-copilot": creds });
      const models = listAvailableModels({ getKey: () => undefined, oauth: store });
      const model = resolveModel(models[0]!.ref, store);
      expect(model.baseUrl).toBe("https://modified.example");
    } finally {
      unregisterOAuthProvider("github-copilot");
    }
  });

  test("resolveModel without a store is unchanged", () => {
    const model = resolveModel("anthropic/claude-sonnet-4-6");
    expect(model.baseUrl).toContain("anthropic");
  });
});
```

Note on the second test: `registerOAuthProvider` overwrites the registry entry for `github-copilot`, and `unregisterOAuthProvider` removes it entirely — which also removes the built-in. That's acceptable within this test process (nothing else in the suite uses the real copilot OAuth provider), but verify by running the FULL test suite, not just this file. If pi-ai's register function throws on duplicate ids instead of overwriting, check `node_modules/@earendil-works/pi-ai/dist/oauth.d.ts`/source for the actual semantics and adapt (e.g., unregister first, and in the finally block re-register the built-in `githubCopilotOAuthProvider`, which IS exported from `@earendil-works/pi-ai/oauth`).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest --run test/models.test.ts`
Expected: FAIL — `listAvailableModels` doesn't accept `oauth`, `resolveModel` doesn't accept a second argument.

- [ ] **Step 3: Implement**

Replace `server/src/models.ts` content with:

```ts
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

export function resolveModel(ref: string, oauth?: PiAuthStore): Model<any> {
  const slash = ref.indexOf("/");
  if (slash <= 0) throw new Error(`Model ref must be "provider/modelId", got: ${ref}`);
  const provider = ref.slice(0, slash);
  const modelId = ref.slice(slash + 1);
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
```

- [ ] **Step 4: Run the FULL suite**

Run: `npm test`
Expected: all tests pass (41 existing + 6 from Task 1 + 3 new = 50). Existing models tests must pass unchanged (no-store behavior identical). `npm run check` clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/models.ts server/test/models.test.ts
git commit -m "feat: OAuth-credentialed providers in model availability and resolution"
```

---

### Task 3: Wire the store through config, manager, server, and boot

**Files:**
- Modify: `server/src/config.ts` (add `piAuthPath`)
- Modify: `server/src/manager.ts` (authStore option + getApiKeyAndHeaders fallback)
- Modify: `server/src/server.ts` (pass oauth store to /api/models)
- Modify: `server/src/index.ts` (construct store, thread it through)
- Modify: `server/test/helpers.ts` (makeManager passes a store)
- Test: `server/test/config.test.ts` (extend)

- [ ] **Step 1: Failing config test**

Add to the `loadConfig` describe block in `server/test/config.test.ts`:

```ts
  test("piAuthPath defaults to the pi CLI location and accepts override", () => {
    const def = loadConfig({ YTSEJAM_AUTH_TOKEN: "x" });
    expect(def.piAuthPath.endsWith("/.pi/agent/auth.json")).toBe(true);
    const over = loadConfig({ YTSEJAM_AUTH_TOKEN: "x", YTSEJAM_PI_AUTH: "/tmp/custom-auth.json" });
    expect(over.piAuthPath).toBe("/tmp/custom-auth.json");
  });
```

Run: `npx vitest --run test/config.test.ts` → FAIL (`piAuthPath` missing).

- [ ] **Step 2: Implement config**

In `server/src/config.ts`: add to the `Config` interface:

```ts
  /** pi CLI auth.json with OAuth credentials (Copilot/Codex subscriptions) */
  piAuthPath: string;
```

Add the import and field in `loadConfig`'s returned object:

```ts
import { defaultPiAuthPath } from "./pi-auth.ts";
```

```ts
    piAuthPath: env.YTSEJAM_PI_AUTH ?? defaultPiAuthPath(),
```

Run the config test → PASS.

- [ ] **Step 3: Manager — authStore option and key fallback**

In `server/src/manager.ts`:

Add import:

```ts
import { PiAuthStore, resolveApiKey } from "./pi-auth.ts";
```

Remove `getEnvApiKey` from the `@earendil-works/pi-ai` import in this file (it moves behind `resolveApiKey`); keep `completeSimple` and `type Model`.

Add to `AgentManagerOptions`:

```ts
  authStore: PiAuthStore;
```

In `wire()`, replace the `getApiKeyAndHeaders` callback body:

```ts
      getApiKeyAndHeaders: async (m: Model<any>) => {
        const apiKey = await resolveApiKey(m.provider, this.opts.authStore);
        return apiKey ? { apiKey } : undefined;
      },
```

- [ ] **Step 4: Server — oauth-aware /api/models**

In `server/src/server.ts`, `AppDeps` gains:

```ts
  authStore: PiAuthStore;
```

(import `type { PiAuthStore } from "./pi-auth.ts"`). The models route becomes:

```ts
  app.get("/api/models", (c) =>
    c.json({ models: listAvailableModels({ oauth: deps.authStore }), defaultModel: config.defaultModel }),
  );
```

- [ ] **Step 5: Boot wiring**

In `server/src/index.ts`:

```ts
import { PiAuthStore } from "./pi-auth.ts";
```

After `loadConfig()`:

```ts
const authStore = new PiAuthStore(config.piAuthPath);
```

Pass `authStore` into the `AgentManager` options, change the manager's `resolveModel` option to apply OAuth overrides:

```ts
  resolveModel: (ref) => resolveModel(ref, authStore),
```

and add `authStore` to the `createApp({...})` deps.

- [ ] **Step 6: Test helpers + existing tests**

`server/test/helpers.ts` — `makeManager` constructs the manager with a store pointing at a nonexistent path (no credentials; env/faux behavior unchanged):

```ts
import { PiAuthStore } from "../src/pi-auth.ts";
```

and inside `makeManager`, add to the `AgentManager` options:

```ts
    authStore: new PiAuthStore(join(dataDir, "no-auth.json")),
```

`server/test/api.test.ts` and `server/test/ws.test.ts` construct `createApp` deps directly — add the same `authStore: new PiAuthStore(...)` field there (any nonexistent temp path; reuse the made `dataDir`). Also extend the existing api.test "models endpoint" test with an OAuth case if quick — optional, the models behavior is covered by Task 2 unit tests.

`server/test/manager.test.ts` — the reopen test constructs an `AgentManager` directly; add the `authStore` field there too.

- [ ] **Step 7: Full suite + boot smoke against the REAL pi auth file**

```bash
cd /home/bjk/projects/ytsejam/server && npm test && npm run check
```

Expected: ~51 tests pass (50 from Tasks 1–2 plus the config test), check clean.

Boot smoke (uses the real `~/.pi/agent/auth.json` — read-only unless a token is expired):

```bash
cd /home/bjk/projects/ytsejam/server
YTSEJAM_AUTH_TOKEN=dev YTSEJAM_DATA_DIR=/tmp/ytsejam-oauth-check YTSEJAM_PORT=3224 node src/index.ts &
sleep 2
curl -s localhost:3224/api/models -H 'Authorization: Bearer dev' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const b=JSON.parse(d);const p=new Set(b.models.map(m=>m.provider));console.log([...p].sort().join("\n"))})'
kill %1
```

Expected: the provider list includes `github-copilot` and `openai-codex` (plus any env-keyed providers). If they're missing, debug `PiAuthStore.hasCredentials` against the real file before touching anything else.

- [ ] **Step 8: README env table**

Add one row to the Configuration table in `README.md`:

```markdown
| `YTSEJAM_PI_AUTH` | `~/.pi/agent/auth.json` | pi CLI OAuth credentials (Copilot/Codex subscriptions) |
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: Copilot and Codex subscription models via pi OAuth credentials"
```

---

### Task 4: End-to-end verification with a real subscription model

- [ ] **Step 1: Manual chat check**

```bash
cd /home/bjk/projects/ytsejam
npm run build
cd server
YTSEJAM_AUTH_TOKEN=dev YTSEJAM_DATA_DIR=/tmp/ytsejam-oauth-e2e YTSEJAM_PORT=3225 node src/index.ts
```

In the browser at http://localhost:3225: open Settings → confirm Copilot and Codex models appear in the picker; create a session, switch it to a `github-copilot/*` model, send "say hi" and confirm a streamed reply; repeat with an `openai-codex/*` model. (This consumes a trivial amount of subscription quota.)

If a turn fails with an auth error, check the server log — a refresh failure logs the pi re-auth hint. Verify pi itself still works (`pi -p "hi"` with that model) to distinguish our wiring from an expired pi login.

- [ ] **Step 2: Verify pi interop after refresh**

If any token was refreshed during Step 1 (server log shows a write, or auth.json mtime changed): run a quick pi CLI command using the same provider to confirm pi still authenticates with the rewritten file.

- [ ] **Step 3: Final gates + commit anything outstanding**

```bash
cd /home/bjk/projects/ytsejam && npm test && npm run check && npm run build && git status --short
```

All green, tree clean (commit any stragglers with an appropriate message).

---

## Spec coverage map

| Spec requirement | Task |
| --- | --- |
| `PiAuthStore` (hasCredentials/getCredentials/getApiKey, refresh + 0600 write-back, failure → undefined) | 1 |
| Env-first key resolution helper (`resolveApiKey`) | 1 |
| `listAvailableModels` OAuth availability | 2 |
| `resolveModel` applies `modifyModels` (Copilot baseUrl) | 2 |
| Manager `getApiKeyAndHeaders` fallback (per-request refresh) | 3 |
| Config `piAuthPath` / `YTSEJAM_PI_AUTH` | 3 |
| Boot + /api/models wiring | 3 |
| No UI changes; models appear in existing picker | 4 (verified) |
| Error UX: log mentions pi CLI re-auth; chat shows existing error block | 1 (log), 4 (verified) |
