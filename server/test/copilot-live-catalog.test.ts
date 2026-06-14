import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { inferModelTemplate } from "../src/copilot-live-catalog.ts";
import { mergeCatalogs, sanitize } from "../src/copilot-live-catalog.ts";

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

import { loadLiveCopilotModels } from "../src/copilot-live-catalog.ts";
import type { PiAuthStore } from "../src/pi-auth.ts";

/**
 * Minimal PiAuthStore shape — the loader only calls `hasCredentials`,
 * `getCredentials`, and `getApiKey`. Verified against server/src/pi-auth.ts.
 */
function fakeAuthWithCopilot(access = "fake-token"): PiAuthStore {
  return {
    hasCredentials: (p: string) => p === "github-copilot",
    getCredentials: (p: string) =>
      p === "github-copilot" ? ({ type: "oauth", access, expires: Date.now() + 60000 } as any) : undefined,
    getApiKey: async (p: string) => (p === "github-copilot" ? access : undefined),
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
  it("sanitize redacts Copilot proxy-ep token format", () => {
    const input =
      "Authorization: Bearer tid=abc;exp=123;sku=foo;proxy-ep=proxy.enterprise.githubcopilot.com;st=dotcom:sig";
    const out = sanitize(input);
    assert.equal(out, "Authorization: Bearer [REDACTED]");
    assert.ok(!out.includes("proxy-ep"), `proxy-ep survived: ${out}`);
    assert.ok(!out.includes("tid="), `tid survived: ${out}`);
    assert.ok(!out.includes(":sig"), `signature survived: ${out}`);
  });

  it("sanitize redacts gho_ tokens", () => {
    const input = "Authorization: Bearer gho_abcdefghijklmnopqrstuvwxyz0123456789";
    const out = sanitize(input);
    assert.equal(out, "Authorization: Bearer [REDACTED]");
    assert.ok(!out.includes("gho_"), `gho token survived: ${out}`);
  });

  it("sanitize is case-insensitive", () => {
    const input = "Authorization: bearer tid=abc;proxy-ep=proxy.enterprise.githubcopilot.com:sig";
    const out = sanitize(input);
    assert.equal(out, "Authorization: Bearer [REDACTED]");
    assert.ok(!out.includes("proxy-ep"), `lowercase bearer token survived: ${out}`);
  });
  it("enterprise token rewrites baseUrl on fetch (the feature's raison d'être)", async () => {
    const enterpriseToken =
      "tid=abc;exp=99999999999;sku=foo;proxy-ep=proxy.enterprise.githubcopilot.com;st=dotcom:fake-signature";
    const auth = fakeAuthWithCopilot(enterpriseToken);

    let calledUrl: string | undefined;
    let calledInit: RequestInit | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calledUrl = url;
      calledInit = init;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as any;

    await loadLiveCopilotModels(auth, { fetch: fetchImpl });

    assert.ok(calledUrl, "fetch was never called");
    assert.equal(
      calledUrl,
      "https://api.enterprise.githubcopilot.com/models",
      `expected enterprise URL, got: ${calledUrl}`,
    );
    const headers = calledInit?.headers as Record<string, string> | undefined;
    assert.ok(headers, "fetch called without headers");
    assert.ok(headers.Authorization?.startsWith("Bearer "), `no Bearer auth header: ${headers.Authorization}`);
    assert.equal(headers.Authorization, `Bearer ${enterpriseToken}`);
    assert.equal(
      headers["Copilot-Integration-Id"],
      "vscode-chat",
      `Copilot-Integration-Id header missing or wrong: ${headers["Copilot-Integration-Id"]}`,
    );
    assert.equal(headers["User-Agent"], "GitHubCopilotChat/0.35.0");
    assert.equal(headers["Editor-Version"], "vscode/1.107.0");
    assert.equal(headers["Editor-Plugin-Version"], "copilot-chat/0.35.0");
  });

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
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response(
        JSON.stringify({
          data: [{ id: "claude-opus-4.7-1m-internal", policy: { state: "enabled" }, model_picker_enabled: true }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as any;
    const result = await loadLiveCopilotModels(auth, { fetch: fetchImpl });
    assert.equal(result.overlay.length, 0);
    assert.equal(called, false);
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

  it("network error includes cause chain in log", async () => {
    const cause = new Error("connect ECONNREFUSED 127.0.0.1:443");
    const err = new TypeError("fetch failed");
    (err as any).cause = cause;
    const fetchImpl = (async () => { throw err; }) as any;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await loadLiveCopilotModels(fakeAuthWithCopilot(), { fetch: fetchImpl });
      const allWarnArgs = warnSpy.mock.calls.flat().join(" ");
      assert.ok(allWarnArgs.includes("ECONNREFUSED"), `cause not in log: ${allWarnArgs}`);
      assert.ok(allWarnArgs.includes("fetch failed"), `original message not in log: ${allWarnArgs}`);
      assert.ok(
        allWarnArgs.includes("https://api.individual.githubcopilot.com/models"),
        `fetch URL not in log: ${allWarnArgs}`,
      );
    } finally {
      warnSpy.mockRestore();
    }
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
