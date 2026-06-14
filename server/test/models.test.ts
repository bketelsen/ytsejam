import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  githubCopilotOAuthProvider,
  registerOAuthProvider,
  unregisterOAuthProvider,
  type OAuthProviderInterface,
} from "@earendil-works/pi-ai/oauth";
import { describe, expect, test } from "vitest";
import { PiAuthStore } from "../src/pi-auth.ts";
import { listAvailableModels, resolveModel } from "../src/models.ts";

describe("resolveModel", () => {
  test("resolves catalog models by provider/id", () => {
    const model = resolveModel("anthropic/claude-sonnet-4-6");
    expect(model.provider).toBe("anthropic");
    expect(model.id).toBe("claude-sonnet-4-6");
  });

  test("throws a helpful error for unknown refs", () => {
    expect(() => resolveModel("nope/nothing")).toThrow(/Unknown model/);
    expect(() => resolveModel("garbage")).toThrow(/provider\/modelId/);
  });
});

describe("listAvailableModels", () => {
  test("only lists providers that have API keys", () => {
    const models = listAvailableModels({ getKey: () => undefined });
    expect(models).toEqual([]);
  });

  test("a key enables only that provider's models", () => {
    const models = listAvailableModels({
      getKey: (p) => (p === "anthropic" ? "k" : undefined),
    });
    expect(models.length).toBeGreaterThan(0);
    expect(new Set(models.map((m) => m.provider))).toEqual(new Set(["anthropic"]));
  });
});

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
      registerOAuthProvider(githubCopilotOAuthProvider);
    }
  });

  test("resolveModel without a store is unchanged", () => {
    const model = resolveModel("anthropic/claude-sonnet-4-6");
    expect(model.baseUrl).toContain("anthropic");
  });
});

describe("resolveModel — overlay + prunedIds (copilot live-catalog)", () => {
  test("resolves an overlay-only id by searching overlay first", () => {
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
    expect(m.id).toBe("claude-opus-4.7-1m-internal");
    expect((m as any).compat?.forceAdaptiveThinking).toBe(true);
  });

  test("throws with clear message for pruned id BEFORE consulting static catalog", () => {
    const prunedIds = new Set(["raptor-mini"]);
    expect(() => resolveModel("github-copilot/raptor-mini", undefined, { prunedIds })).toThrow(
      /not in your Copilot entitlement/i,
    );
  });

  test("still resolves a normal pi-ai static model when overlay doesn't have it", () => {
    // Pick any model known to be in the pi-ai static catalog. claude-opus-4.7 is in prod today.
    const m = resolveModel("github-copilot/claude-opus-4.7", undefined, { overlay: [] });
    expect(m.id).toBe("claude-opus-4.7");
  });

  test("preserves existing default behaviour when opts is undefined", () => {
    const m = resolveModel("github-copilot/claude-opus-4.7");
    expect(m.id).toBe("claude-opus-4.7");
  });
});
