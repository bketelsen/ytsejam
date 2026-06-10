import { describe, expect, test } from "vitest";
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
