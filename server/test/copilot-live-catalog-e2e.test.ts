import { describe, expect, it } from "vitest";
import { loadLiveCopilotModels } from "../src/copilot-live-catalog.ts";
import { resolveModel } from "../src/models.ts";
import type { PiAuthStore } from "../src/pi-auth.ts";

/**
 * Minimal PiAuthStore shape — this e2e path only needs Copilot credentials
 * for the live loader and OAuth model override plumbing in resolveModel.
 */
function fakeAuthWithCopilot(access = "fake-token"): PiAuthStore {
  return {
    hasCredentials: (p: string) => p === "github-copilot",
    getCredentials: (p: string) =>
      p === "github-copilot" ? ({ type: "oauth", access, expires: Date.now() + 60_000 } as any) : undefined,
    getApiKey: async (p: string) => (p === "github-copilot" ? access : undefined),
  } as unknown as PiAuthStore;
}

function makeFetchOk(body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as any;
}

describe("e2e: loadLiveCopilotModels → resolveModel", () => {
  it("overlay model resolves end-to-end (live-only id reaches resolveModel)", async () => {
    const auth = fakeAuthWithCopilot();
    const merge = await loadLiveCopilotModels(auth, {
      fetch: makeFetchOk({
        data: [
          // Known static sibling; it should stay out of prunedIds and teach the overlay template.
          { id: "claude-opus-4.7", model_picker_enabled: true, policy: { state: "enabled" } },
          // Live-only id absent from pi-ai's static catalog.
          { id: "claude-opus-4.7-1m-internal", model_picker_enabled: true, policy: { state: "enabled" } },
        ],
      }),
    });

    expect(merge.overlay.find((m) => m.id === "claude-opus-4.7-1m-internal")).toBeDefined();
    expect(merge.prunedIds.has("claude-opus-4.7")).toBe(false);

    const resolved = resolveModel("github-copilot/claude-opus-4.7-1m-internal", auth, merge);
    expect(resolved.id).toBe("claude-opus-4.7-1m-internal");
    expect(resolved.provider).toBe("github-copilot");
    expect(resolved.api).toBe("anthropic-messages");
  });

  it("pruned id throws entitlement error end-to-end", async () => {
    const auth = fakeAuthWithCopilot();
    const merge = await loadLiveCopilotModels(auth, {
      fetch: makeFetchOk({
        data: [
          // Deliberately short entitlement list that omits raptor-mini.
          { id: "claude-opus-4.7", model_picker_enabled: true, policy: { state: "enabled" } },
        ],
      }),
    });

    expect(merge.prunedIds.has("raptor-mini")).toBe(true);
    expect(() => resolveModel("github-copilot/raptor-mini", auth, merge)).toThrow(/not in your Copilot entitlement/i);
  });
});
