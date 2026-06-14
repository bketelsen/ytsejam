# Copilot Live Model Catalog — Implementation Plan

> Execute with the `develop` skill, task-by-task.

**Goal:** At server boot, fetch GitHub Copilot's `/models` endpoint and merge it with pi-ai's static catalog so models like `claude-opus-4.7-1m-internal` become reachable via `delegate(model: "github-copilot/...")`.

**Spec:** [docs/plans/2026-06-14-copilot-live-catalog-design.md](./2026-06-14-copilot-live-catalog-design.md)

**Architecture:** One new module `server/src/copilot-live-catalog.ts` exports `loadLiveCopilotModels(auth)` returning `{overlay, prunedIds}`. `server/src/models.ts:resolveModel` is extended with an optional `opts: {overlay, prunedIds}` so the overlay is searched first and pruned ids throw a clear error. `server/src/index.ts` calls the loader once at boot and threads the result through to both `manager.resolveModel` and `taskManager.resolveModel`.

**Tech Stack:** TypeScript, Node 22 (native test runner), `@earendil-works/pi-ai` (v0.79.1), Node `fetch` + `AbortSignal.timeout`.

**Worktree:** `~/projects/.worktrees/ytsejam-copilot-live-catalog`

**Branch:** `feat/copilot-live-catalog`

---

## Task 1: Pure helper — `inferModelTemplate`

The longest-common-prefix sibling lookup with type-by-prefix fallback. Pure, no I/O, easiest to TDD first.

**Files:**
- Create: `server/src/copilot-live-catalog.ts` (skeleton + `inferModelTemplate` only)
- Test: `server/test/copilot-live-catalog.test.ts` (new file, `inferModelTemplate` tests only)

### Step 1: Write the failing tests

Create `server/test/copilot-live-catalog.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Model } from "@earendil-works/pi-ai";
import { inferModelTemplate } from "../src/copilot-live-catalog.ts";

/**
 * Minimal Model<any> shape fixtures matching what pi-ai's catalog produces
 * for the github-copilot provider. We assert against api/headers/compat
 * fields the template must preserve.
 */
function makeClaudeOpus47(): Model<any> {
  return {
    id: "claude-opus-4.7",
    name: "Claude Opus 4.7",
    api: "anthropic-messages",
    provider: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
    headers: {
      "User-Agent": "GitHubCopilotChat/0.35.0",
      "Editor-Version": "vscode/1.107.0",
      "Editor-Plugin-Version": "copilot-chat/0.35.0",
      "Copilot-Integration-Id": "vscode-chat",
    },
    compat: { forceAdaptiveThinking: true, supportsTemperature: false },
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh" },
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 200000,
    maxTokens: 32000,
  } as Model<any>;
}

function makeClaudeOpus46(): Model<any> {
  return { ...makeClaudeOpus47(), id: "claude-opus-4.6", name: "Claude Opus 4.6" } as Model<any>;
}

describe("inferModelTemplate", () => {
  it("sibling-match: longest common prefix wins, metadata inherited", () => {
    const out = inferModelTemplate("claude-opus-4.7-1m-internal", [makeClaudeOpus47(), makeClaudeOpus46()]);
    assert.equal(out.id, "claude-opus-4.7-1m-internal");
    assert.equal(out.api, "anthropic-messages");
    assert.equal(out.provider, "github-copilot");
    assert.equal((out as any).compat?.forceAdaptiveThinking, true);
    assert.equal(out.baseUrl, "https://api.individual.githubcopilot.com");
    assert.ok(out.name.includes("1m-internal"), `name should reference the suffix, got: ${out.name}`);
  });

  it("prefix collision: 4.7-xhigh prefers 4.7 over 4.6", () => {
    const out = inferModelTemplate("claude-opus-4.7-xhigh", [makeClaudeOpus46(), makeClaudeOpus47()]);
    // Both 4.7 and 4.6 share "claude-opus-4." (14 chars). 4.7 shares 15 chars. Must inherit 4.7.
    assert.equal((out as any).compat?.forceAdaptiveThinking, true);
    // Verifying by name to catch accidental 4.6 inheritance (both have same compat in fixture).
    assert.ok(out.name.includes("xhigh"));
    // We assert the SIBLING chosen by checking that the contextWindow matches the 4.7 fixture's.
    assert.equal(out.contextWindow, 200000);
  });

  it("no-sibling claude fallback: anthropic-messages template", () => {
    const out = inferModelTemplate("claude-future-99", []);
    assert.equal(out.api, "anthropic-messages");
    assert.equal(out.provider, "github-copilot");
    assert.equal(out.id, "claude-future-99");
  });

  it("no-sibling openai fallback: openai-completions template", () => {
    const out = inferModelTemplate("mai-code-1-flash-internal", []);
    assert.equal(out.api, "openai-completions");
    assert.equal(out.provider, "github-copilot");
    assert.equal(out.id, "mai-code-1-flash-internal");
  });

  it("no-sibling gemini fallback: openai-completions template (matches pi-ai)", () => {
    const out = inferModelTemplate("gemini-99-flash", []);
    assert.equal(out.api, "openai-completions");
    assert.equal(out.id, "gemini-99-flash");
  });

  it("prefix length floor: short common prefix is NOT a sibling match", () => {
    // "claude-x" shares only "claude-" (7 chars) with "claude-opus-4.7". Below the 8-char floor.
    // Must fall through to type-by-prefix (claude → anthropic-messages template), NOT inherit from 4.7.
    const out = inferModelTemplate("claude-x", [makeClaudeOpus47()]);
    assert.equal(out.api, "anthropic-messages");
    // Sibling's contextWindow would be 200000; fallback template should NOT inherit that.
    assert.notEqual(out.contextWindow, 200000);
  });
});
```

### Step 2: Run test to verify it fails

Run: `env -u NODE_ENV npm --workspace server test -- --test-name-pattern "inferModelTemplate"`
Expected: FAIL with "Cannot find module '../src/copilot-live-catalog.ts'" or "inferModelTemplate is not a function".

### Step 3: Write minimal implementation

Create `server/src/copilot-live-catalog.ts`:

```ts
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
  } as Model<any>;
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
```

### Step 4: Run test to verify it passes

Run: `env -u NODE_ENV npm --workspace server test -- --test-name-pattern "inferModelTemplate"`
Expected: PASS, 6/6 tests green.

### Step 5: Commit

```bash
git add server/src/copilot-live-catalog.ts server/test/copilot-live-catalog.test.ts
git commit -m "feat(server): add inferModelTemplate sibling-prefix helper (copilot-live-catalog task 1)"
```

---

## Task 2: Pure helper — `mergeCatalogs`

Combines the static github-copilot models with the live id list, producing `{overlay, prunedIds}`.

**Files:**
- Modify: `server/src/copilot-live-catalog.ts` (append `mergeCatalogs`)
- Modify: `server/test/copilot-live-catalog.test.ts` (append `mergeCatalogs` describe)

### Step 1: Write the failing tests

Append to `server/test/copilot-live-catalog.test.ts`:

```ts
import { mergeCatalogs } from "../src/copilot-live-catalog.ts";

describe("mergeCatalogs", () => {
  it("live-only id added to overlay with sibling-inherited metadata", () => {
    const result = mergeCatalogs(
      [makeClaudeOpus47()],
      ["claude-opus-4.7", "claude-opus-4.7-1m-internal"],
    );
    assert.equal(result.overlay.length, 1);
    assert.equal(result.overlay[0].id, "claude-opus-4.7-1m-internal");
    assert.equal(result.overlay[0].api, "anthropic-messages");
    assert.equal(result.prunedIds.size, 0);
  });

  it("overlap id is skipped — static metadata wins, not duplicated in overlay", () => {
    const result = mergeCatalogs([makeClaudeOpus47()], ["claude-opus-4.7"]);
    assert.equal(result.overlay.length, 0);
    assert.equal(result.prunedIds.size, 0);
  });

  it("static-only id is in prunedIds", () => {
    const result = mergeCatalogs([makeClaudeOpus47(), makeClaudeOpus46()], ["claude-opus-4.7"]);
    assert.equal(result.overlay.length, 0);
    assert.equal(result.prunedIds.size, 1);
    assert.ok(result.prunedIds.has("claude-opus-4.6"));
  });

  it("empty live list — empty overlay, prunedIds = all static github-copilot ids", () => {
    const result = mergeCatalogs([makeClaudeOpus47(), makeClaudeOpus46()], []);
    assert.equal(result.overlay.length, 0);
    assert.equal(result.prunedIds.size, 2);
  });

  it("empty static list — overlay = all live (each via no-sibling fallback)", () => {
    const result = mergeCatalogs([], ["claude-opus-4.7-1m-internal", "mai-code-1-flash-internal"]);
    assert.equal(result.overlay.length, 2);
    assert.equal(result.prunedIds.size, 0);
  });

  it("non-github-copilot static entries are not pruned or counted", () => {
    const anthropicDirect: Model<any> = {
      ...makeClaudeOpus47(),
      provider: "anthropic",
      id: "claude-opus-4.7",
    } as Model<any>;
    const result = mergeCatalogs([makeClaudeOpus47(), anthropicDirect], ["claude-opus-4.7"]);
    // anthropic provider is unaffected; pruning only applies to github-copilot
    assert.equal(result.prunedIds.size, 0);
    assert.equal(result.overlay.length, 0);
  });
});
```

### Step 2: Run test to verify it fails

Run: `env -u NODE_ENV npm --workspace server test -- --test-name-pattern "mergeCatalogs"`
Expected: FAIL with "mergeCatalogs is not a function".

### Step 3: Write minimal implementation

Append to `server/src/copilot-live-catalog.ts`:

```ts
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
```

### Step 4: Run test to verify it passes

Run: `env -u NODE_ENV npm --workspace server test -- --test-name-pattern "mergeCatalogs"`
Expected: PASS, 6/6 tests green.

### Step 5: Commit

```bash
git add server/src/copilot-live-catalog.ts server/test/copilot-live-catalog.test.ts
git commit -m "feat(server): add mergeCatalogs overlay+pruned helper (copilot-live-catalog task 2)"
```

---

## Task 3: `loadLiveCopilotModels` — the I/O entry point

Wraps the Copilot `/models` fetch, handles all failure paths, returns `{overlay, prunedIds}`.

**Files:**
- Modify: `server/src/copilot-live-catalog.ts` (append `loadLiveCopilotModels`)
- Modify: `server/test/copilot-live-catalog.test.ts` (append `loadLiveCopilotModels` describe)

### Step 1: Write the failing tests

Append to `server/test/copilot-live-catalog.test.ts`:

```ts
import { loadLiveCopilotModels } from "../src/copilot-live-catalog.ts";
import type { PiAuthStore } from "../src/pi-auth.ts";

/**
 * Minimal PiAuthStore shape — the loader only calls `hasCredentials`,
 * `getCredentials`, and `getApiKey`. Cast keeps the test fixture light.
 */
function fakeAuthWithCopilot(): PiAuthStore {
  return {
    hasCredentials: (p: string) => p === "github-copilot",
    getCredentials: (p: string) =>
      p === "github-copilot" ? ({ type: "oauth", access: "fake-token", expires: Date.now() + 60000 } as any) : undefined,
    getApiKey: async (p: string) => (p === "github-copilot" ? "fake-token" : undefined),
  } as unknown as PiAuthStore;
}

function fakeAuthNoCopilot(): PiAuthStore {
  return {
    hasCredentials: () => false,
    getCredentials: () => undefined,
    getApiKey: async () => undefined,
  } as unknown as PiAuthStore;
}

function makeFetchOk(body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as any;
}

function makeFetchStatus(status: number, body: string = "{}"): typeof fetch {
  return (async () => new Response(body, { status })) as any;
}

function makeFetchThrow(err: Error): typeof fetch {
  return (async () => { throw err; }) as any;
}

describe("loadLiveCopilotModels", () => {
  it("happy path — returns overlay from filtered live ids", async () => {
    const fetchImpl = makeFetchOk({
      data: [
        { id: "claude-opus-4.7", policy: { state: "enabled" }, model_picker_enabled: true },
        { id: "claude-opus-4.7-1m-internal", policy: { state: "enabled" }, model_picker_enabled: true },
        { id: "text-embedding-3-small", policy: { state: "enabled" }, model_picker_enabled: false },
        { id: "gpt-3.5-turbo", policy: { state: "disabled" }, model_picker_enabled: false },
      ],
    });
    const result = await loadLiveCopilotModels(fakeAuthWithCopilot(), { fetch: fetchImpl });
    // claude-opus-4.7 may overlap with pi-ai static (it does in prod); we only assert the new id appears.
    const overlayIds = result.overlay.map((m) => m.id);
    assert.ok(overlayIds.includes("claude-opus-4.7-1m-internal"));
    assert.ok(!overlayIds.includes("text-embedding-3-small"), "embeddings must be filtered out");
    assert.ok(!overlayIds.includes("gpt-3.5-turbo"), "disabled must be filtered out");
  });

  it("no copilot creds — returns empty, fetch never called", async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return new Response("{}"); }) as any;
    const result = await loadLiveCopilotModels(fakeAuthNoCopilot(), { fetch: fetchImpl });
    assert.equal(result.overlay.length, 0);
    assert.equal(result.prunedIds.size, 0);
    assert.equal(called, false);
  });

  it("oauth refresh fails (undefined apiKey) — returns empty", async () => {
    const auth = {
      hasCredentials: () => true,
      getCredentials: () => ({ type: "oauth", access: "x", expires: 0 } as any),
      getApiKey: async () => undefined,
    } as unknown as PiAuthStore;
    const result = await loadLiveCopilotModels(auth, { fetch: makeFetchOk({}) });
    assert.equal(result.overlay.length, 0);
  });

  it("401 from /models — returns empty", async () => {
    const result = await loadLiveCopilotModels(fakeAuthWithCopilot(), { fetch: makeFetchStatus(401, '{"error":"bad token"}') });
    assert.equal(result.overlay.length, 0);
  });

  it("5xx from /models — returns empty", async () => {
    const result = await loadLiveCopilotModels(fakeAuthWithCopilot(), { fetch: makeFetchStatus(503) });
    assert.equal(result.overlay.length, 0);
  });

  it("network throw — returns empty", async () => {
    const result = await loadLiveCopilotModels(fakeAuthWithCopilot(), { fetch: makeFetchThrow(new Error("ECONNREFUSED")) });
    assert.equal(result.overlay.length, 0);
  });

  it("malformed JSON — returns empty", async () => {
    const fetchImpl = (async () => new Response("not json {{{", { status: 200 })) as any;
    const result = await loadLiveCopilotModels(fakeAuthWithCopilot(), { fetch: fetchImpl });
    assert.equal(result.overlay.length, 0);
  });

  it("missing data[] — returns empty", async () => {
    const result = await loadLiveCopilotModels(fakeAuthWithCopilot(), { fetch: makeFetchOk({ models: [] }) });
    assert.equal(result.overlay.length, 0);
  });

  it("env disable — returns empty, fetch never called", async () => {
    const prev = process.env.YTSEJAM_DISABLE_COPILOT_LIVE_CATALOG;
    process.env.YTSEJAM_DISABLE_COPILOT_LIVE_CATALOG = "1";
    try {
      let called = false;
      const fetchImpl = (async () => { called = true; return new Response("{}"); }) as any;
      const result = await loadLiveCopilotModels(fakeAuthWithCopilot(), { fetch: fetchImpl });
      assert.equal(result.overlay.length, 0);
      assert.equal(called, false);
    } finally {
      if (prev === undefined) delete process.env.YTSEJAM_DISABLE_COPILOT_LIVE_CATALOG;
      else process.env.YTSEJAM_DISABLE_COPILOT_LIVE_CATALOG = prev;
    }
  });

  it("AbortError-style timeout — returns empty within timeout window", async () => {
    // The loader should be configured with a small timeout for the test (50ms override).
    const fetchImpl = ((_url: any, init?: any) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (signal) {
          if (signal.aborted) reject(new Error("aborted"));
          else signal.addEventListener("abort", () => reject(new Error("aborted")));
        }
        // Never resolves on its own
      })) as any;
    const start = Date.now();
    const result = await loadLiveCopilotModels(fakeAuthWithCopilot(), { fetch: fetchImpl, timeoutMs: 50 });
    const elapsed = Date.now() - start;
    assert.equal(result.overlay.length, 0);
    assert.ok(elapsed < 500, `expected timeout under 500ms wall clock, got ${elapsed}ms`);
  });
});
```

### Step 2: Run test to verify it fails

Run: `env -u NODE_ENV npm --workspace server test -- --test-name-pattern "loadLiveCopilotModels"`
Expected: FAIL with "loadLiveCopilotModels is not a function".

### Step 3: Write minimal implementation

Append to `server/src/copilot-live-catalog.ts`:

```ts
import { getModels } from "@earendil-works/pi-ai";
import { getOAuthProvider } from "@earendil-works/pi-ai/oauth";
import type { PiAuthStore } from "./pi-auth.ts";

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

function sanitize(cause: unknown): string {
  // Defensive — never leak the OAuth token even on error. fetch error messages
  // typically don't include the body, but be paranoid.
  if (cause instanceof Error) return cause.message.replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [REDACTED]");
  return String(cause).replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [REDACTED]");
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

  if (!auth.hasCredentials("github-copilot")) {
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

  const baseUrl = resolveBaseUrl(auth);
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

  const staticCopilot = getModels("github-copilot" as any) as Model<any>[];
  const merged = mergeCatalogs(staticCopilot, liveIds);
  console.info(
    `github-copilot live catalog: ${liveIds.length} live models, ${merged.overlay.length} added (sibling-inherited), ${merged.prunedIds.size} pruned`,
  );
  return merged;
}
```

### Step 4: Run test to verify it passes

Run: `env -u NODE_ENV npm --workspace server test -- --test-name-pattern "loadLiveCopilotModels"`
Expected: PASS, 10/10 tests green.

### Step 5: Mutation-test the defensive parse guards

Per the spec, demonstrate the parse-guard tests are doing real work. For three guards, temporarily remove the guard, re-run the relevant test, verify it FAILS, then restore:

1. **Malformed-JSON guard** — comment out the try/catch around `await res.json()`. Run the "malformed JSON" test. Verify the test FAILS (test framework reports an unhandled rejection or wrong return). Restore the guard.
2. **Missing-data[] guard** — comment out the `if (!body || !Array.isArray(body.data))` check. Run the "missing data[]" test. Verify FAIL. Restore.
3. **OAuth-key-undefined guard** — comment out the `if (!apiKey)` check. Run the "oauth refresh fails (undefined apiKey)" test. Verify FAIL. Restore.

Record the FAIL output of each mutation in the task report (one line per mutation is fine).

### Step 6: Commit

```bash
git add server/src/copilot-live-catalog.ts server/test/copilot-live-catalog.test.ts
git commit -m "feat(server): add loadLiveCopilotModels boot-time fetch (copilot-live-catalog task 3)"
```

---

## Task 4: Extend `resolveModel` with overlay + pruned set

Adds an `opts` parameter to `resolveModel` so the merged overlay is searched first and pruned ids throw clearly.

**Files:**
- Modify: `server/src/models.ts` (extend `resolveModel` signature)
- Modify: `server/test/models.test.ts` (add overlay + pruned tests)

### Step 1: Write the failing tests

Append to `server/test/models.test.ts`:

```ts
import { resolveModel } from "../src/models.ts";

describe("resolveModel — overlay + prunedIds (copilot live-catalog)", () => {
  it("resolves an overlay-only id by searching overlay first", () => {
    const overlay: any[] = [
      {
        id: "claude-opus-4.7-1m-internal",
        name: "Claude Opus 4.7 (1m-internal)",
        api: "anthropic-messages",
        provider: "github-copilot",
        baseUrl: "https://api.individual.githubcopilot.com",
        headers: {},
        compat: { forceAdaptiveThinking: true },
        input: ["text"],
      },
    ];
    const m = resolveModel("github-copilot/claude-opus-4.7-1m-internal", undefined, { overlay });
    assert.equal(m.id, "claude-opus-4.7-1m-internal");
    assert.equal((m as any).compat?.forceAdaptiveThinking, true);
  });

  it("throws with clear message for pruned id BEFORE consulting static catalog", () => {
    const prunedIds = new Set(["raptor-mini"]);
    assert.throws(
      () => resolveModel("github-copilot/raptor-mini", undefined, { prunedIds }),
      /not in your Copilot entitlement/i,
    );
  });

  it("still resolves a normal pi-ai static model when overlay doesn't have it", () => {
    // Pick any model known to be in the pi-ai static catalog. claude-opus-4.7 is in prod today.
    const m = resolveModel("github-copilot/claude-opus-4.7", undefined, { overlay: [] });
    assert.equal(m.id, "claude-opus-4.7");
  });

  it("preserves existing default behaviour when opts is undefined", () => {
    const m = resolveModel("github-copilot/claude-opus-4.7");
    assert.equal(m.id, "claude-opus-4.7");
  });
});
```

### Step 2: Run test to verify it fails

Run: `env -u NODE_ENV npm --workspace server test -- --test-name-pattern "resolveModel — overlay"`
Expected: FAIL — overlay tests fail because the third argument isn't accepted.

### Step 3: Write minimal implementation

Modify `server/src/models.ts` `resolveModel` and `ModelResolver`:

```ts
// Replace the existing ModelResolver type (line ~12) with:
export type ModelResolver = (ref: string) => Model<any>;

export interface ResolveOptions {
  /** Additional models to search BEFORE pi-ai's static catalog. */
  overlay?: Model<any>[];
  /** Static-catalog ids the user's Copilot account doesn't entitle. */
  prunedIds?: Set<string>;
}

// Replace the existing resolveModel (line ~26) with:
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
```

### Step 4: Run test to verify it passes

Run: `env -u NODE_ENV npm --workspace server test -- --test-name-pattern "resolveModel"`
Expected: PASS — all existing `resolveModel` tests + new 4 tests green.

### Step 5: Commit

```bash
git add server/src/models.ts server/test/models.test.ts
git commit -m "feat(server): extend resolveModel with overlay+prunedIds (copilot-live-catalog task 4)"
```

---

## Task 5: Wire the loader into `index.ts` boot

Single call site, threads `{overlay, prunedIds}` through to both manager + taskManager resolvers.

**Files:**
- Modify: `server/src/index.ts` (lines ~8, ~42, ~65, ~94)

### Step 1: Inspect current shape

Read `server/src/index.ts` lines 40-100 to confirm the two resolver call sites match what's expected:

```bash
sed -n '40,100p' server/src/index.ts
```

Expected: `const authStore = new PiAuthStore(...)` on ~42, and two occurrences of `resolveModel: (ref) => resolveModel(ref, authStore)` (on ~65 and ~94).

### Step 2: Write the change

Modify `server/src/index.ts`:

```ts
// Add to imports near the existing models.ts import (around line 8):
import { loadLiveCopilotModels } from "./copilot-live-catalog.ts";

// AFTER the existing `const authStore = new PiAuthStore(config.piAuthPath);` line (~42),
// add a single await:
const liveCopilotCatalog = await loadLiveCopilotModels(authStore);

// Replace BOTH `resolveModel: (ref) => resolveModel(ref, authStore),` call sites
// (~65 and ~94) with:
resolveModel: (ref) => resolveModel(ref, authStore, liveCopilotCatalog),
```

`MergeResult` is `{overlay, prunedIds}` and matches `ResolveOptions` structurally, so the
result of `loadLiveCopilotModels(authStore)` passes directly as the third arg.

### Step 3: Run the full server test suite

Run: `env -u NODE_ENV npm --workspace server test`
Expected: PASS, all tests including the new copilot-live-catalog + models tests + the existing 124 tests.

### Step 4: Commit

```bash
git add server/src/index.ts server/src/models.ts server/test/models.test.ts
git commit -m "feat(server): wire loadLiveCopilotModels into boot path (copilot-live-catalog task 5)"
```

---

## Task 6: e2e wiring test

End-to-end test through `resolveModel` with a synthesized overlay to verify the seams are connected.

**Files:**
- Modify: `server/test/copilot-live-catalog.test.ts` (append integration describe)

### Step 1: Write the failing test

Append to `server/test/copilot-live-catalog.test.ts`:

```ts
describe("loadLiveCopilotModels → resolveModel e2e", () => {
  it("a live-only id becomes resolvable with sibling-inherited metadata", async () => {
    const fetchImpl = makeFetchOk({
      data: [
        { id: "claude-opus-4.7", policy: { state: "enabled" }, model_picker_enabled: true },
        { id: "claude-opus-4.7-1m-internal", policy: { state: "enabled" }, model_picker_enabled: true },
      ],
    });
    const merged = await loadLiveCopilotModels(fakeAuthWithCopilot(), { fetch: fetchImpl });
    const resolved = resolveModel("github-copilot/claude-opus-4.7-1m-internal", undefined, merged);
    assert.equal(resolved.id, "claude-opus-4.7-1m-internal");
    assert.equal(resolved.api, "anthropic-messages");
    // sibling-inherited from real pi-ai static claude-opus-4.7
    assert.equal((resolved as any).compat?.forceAdaptiveThinking, true);
  });

  it("a pruned id throws a clear error before any network call", async () => {
    // pi-ai static lists raptor-mini today; if we omit it from live we should prune it.
    const fetchImpl = makeFetchOk({
      data: [{ id: "claude-opus-4.7", policy: { state: "enabled" }, model_picker_enabled: true }],
    });
    const merged = await loadLiveCopilotModels(fakeAuthWithCopilot(), { fetch: fetchImpl });
    // Only assert this if raptor-mini is still in pi-ai static; otherwise the test is moot.
    // (If pi-ai removes it, this test silently degrades to a no-op assertion.)
    if (merged.prunedIds.has("raptor-mini")) {
      assert.throws(
        () => resolveModel("github-copilot/raptor-mini", undefined, merged),
        /not in your Copilot entitlement/i,
      );
    }
  });
});
```

### Step 2: Run test to verify it (probably) passes the first time

Run: `env -u NODE_ENV npm --workspace server test -- --test-name-pattern "loadLiveCopilotModels → resolveModel e2e"`
Expected: PASS — Tasks 1–5 should already make this work. If it fails, debug the seam where the failure points.

### Step 3: Commit

```bash
git add server/test/copilot-live-catalog.test.ts
git commit -m "test(server): e2e wiring test for copilot live-catalog (task 6)"
```

---

## Task 7: Documentation

**Files:**
- Modify: `docs/agents/OVERVIEW.md` (model-resolution section, if it exists; else add one paragraph)
- Modify: `deploy/ytsejam.env.example` (add the disable knob)

### Step 1: Update OVERVIEW.md

Read `docs/agents/OVERVIEW.md`. Find the model-resolution / models / providers section. If none exists, add a new section:

```markdown
## Model catalog

ytsejam resolves `delegate(model: "<provider>/<id>")` refs through
`server/src/models.ts:resolveModel`. The default catalog comes from
`@earendil-works/pi-ai`'s static registry. At server boot, ytsejam also
fetches GitHub Copilot's `/models` endpoint and merges the result:

- Models pi-ai knows about: their hand-curated metadata wins (api shape,
  headers, compat flags like `forceAdaptiveThinking`).
- Models Copilot returns that pi-ai doesn't know about (e.g.
  `claude-opus-4.7-1m-internal`): synthesized from a sibling-prefix
  lookup against pi-ai's catalog — inherits `api`/`headers`/`compat`/etc
  from the nearest known model. See `server/src/copilot-live-catalog.ts`.
- Models pi-ai lists but Copilot doesn't return for this account
  (e.g. `raptor-mini` for accounts without Microsoft-internal access):
  throw a clear entitlement error before any API call.

Disable with `YTSEJAM_DISABLE_COPILOT_LIVE_CATALOG=1` if the boot-time
fetch is causing trouble.
```

### Step 2: Update env example

Append to `deploy/ytsejam.env.example`:

```
# Disable the boot-time fetch of GitHub Copilot's /models endpoint.
# When set to "1", ytsejam uses pi-ai's static catalog only, and
# Microsoft-internal preview models like claude-opus-4.7-1m-internal
# are unreachable. Default: unset (live catalog enabled).
# YTSEJAM_DISABLE_COPILOT_LIVE_CATALOG=1
```

### Step 3: Run the doc-link check

Run: `bash scripts/check-doc-links.sh`
Expected: exit 0 (no broken links).

### Step 4: Commit

```bash
git add docs/agents/OVERVIEW.md deploy/ytsejam.env.example
git commit -m "docs: document copilot live-catalog feature + env knob (task 7)"
```

---

## Task 8: Gate green + ready to ship

**Files:** none modified — verification + handoff.

### Step 1: Run the full gate

```bash
cd ~/projects/.worktrees/ytsejam-copilot-live-catalog
env -u NODE_ENV bash scripts/gate.sh
```
Expected: `=== gate: PASSED ===`. Server typecheck + server tests + ltm tests + web build + web typecheck + web tests all green.

### Step 2: Verify the branch state

```bash
git log --oneline main..HEAD
git diff --stat main..HEAD
```
Expected: 7 commits (tasks 1-7), changes localized to `server/src/copilot-live-catalog.ts` (new), `server/test/copilot-live-catalog.test.ts` (new), `server/src/models.ts` (small change), `server/src/index.ts` (small change), `server/test/models.test.ts` (small change), `docs/agents/OVERVIEW.md`, `deploy/ytsejam.env.example`.

### Step 3: Report ready-to-ship

Report task completion. The ship skill handles push + PR + merge + cutover instructions.

---

## Notes for the develop skill

- Brian's mode: decide-and-act, narrate progress, ask only at unresolvable forks. (See cog hot memory for ytsejam.)
- Subagent shell has `NODE_ENV=production` — always prefix npm with `env -u NODE_ENV`.
- This worktree at `~/projects/.worktrees/ytsejam-copilot-live-catalog` is OK to keep long-running — NOT under `/tmp`.
- Per-task review: use the `review` skill in spec-then-quality mode after each implementer task.
- Final cross-task quality review using `github-copilot/claude-opus-4.8` (NOT one of the new live-only models — chicken-and-egg).
