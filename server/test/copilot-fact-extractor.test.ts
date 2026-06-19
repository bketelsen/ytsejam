// server/test/copilot-fact-extractor.test.ts
import { describe, it, expect } from "vitest";
import { CopilotFactExtractor } from "../src/memory/fact-extractor.ts";

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
}

function toolResponse(facts: unknown) {
  return { choices: [{ message: { tool_calls: [{ function: { name: "extract_user_facts", arguments: JSON.stringify({ facts }) } }] } }] };
}

const opts = (fetchImpl: typeof fetch, extra = {}) => ({
  getApiKey: async () => "tok", fetchImpl, ...extra,
});

describe("CopilotFactExtractor", () => {
  it("parses tool_call facts into FactCandidates above the confidence floor", async () => {
    const ext = new CopilotFactExtractor(opts(fakeFetch(toolResponse([
      { kind: "identity", predicate: "name", object: "Brian", polarity: 1, confidence: 0.9 },
      { kind: "preference", predicate: "prefers", object: "vim", polarity: 1, confidence: 0.4 }, // below floor
    ]))));
    const out = await ext.extract("hi");
    expect(out).toEqual([
      { kind: "identity", predicate: "name", object: "Brian", polarity: 1, initialStrength: 0.9 },
    ]);
  });

  it("returns [] when getApiKey yields undefined (no creds)", async () => {
    const ext = new CopilotFactExtractor({ getApiKey: async () => undefined, fetchImpl: fakeFetch(toolResponse([])) });
    expect(await ext.extract("hi")).toEqual([]);
  });

  it("returns [] on non-200", async () => {
    const ext = new CopilotFactExtractor(opts(fakeFetch({ error: "boom" }, 500)));
    expect(await ext.extract("hi")).toEqual([]);
  });

  it("returns [] on malformed/missing tool call", async () => {
    const ext = new CopilotFactExtractor(opts(fakeFetch({ choices: [{ message: {} }] })));
    expect(await ext.extract("hi")).toEqual([]);
  });

  it("returns [] when fetch throws", async () => {
    const throwing = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
    const ext = new CopilotFactExtractor(opts(throwing));
    expect(await ext.extract("hi")).toEqual([]);
  });

  it("drops candidates with invalid kind/polarity", async () => {
    const ext = new CopilotFactExtractor(opts(fakeFetch(toolResponse([
      { kind: "bogus", predicate: "x", object: "y", polarity: 1, confidence: 0.9 },
      { kind: "identity", predicate: "name", object: "", polarity: 1, confidence: 0.9 },
      { kind: "identity", predicate: "name", object: "Brian", polarity: 2, confidence: 0.9 },
    ]))));
    expect(await ext.extract("hi")).toEqual([]);
  });
});
