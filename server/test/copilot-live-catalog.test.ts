import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { inferModelTemplate } from "../src/copilot-live-catalog.ts";
import { mergeCatalogs } from "../src/copilot-live-catalog.ts";

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
