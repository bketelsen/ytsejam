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
  test("only lists providers that have API keys in env", () => {
    const models = listAvailableModels({ env: {} });
    expect(models).toEqual([]);
  });
});
