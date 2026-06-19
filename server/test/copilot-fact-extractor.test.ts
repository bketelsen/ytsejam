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
      { kind: "identity", predicate: "name", object: "Brian", polarity: 1, initialStrength: 0.9, scope: "global" },
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

  it("debug: logs a fact summary when facts are extracted", async () => {
    const lines: string[] = [];
    const ext = new CopilotFactExtractor(opts(fakeFetch(toolResponse([
      { kind: "identity", predicate: "name", object: "Brian", polarity: 1, confidence: 0.9 },
    ])), { debug: true, log: (m: string) => lines.push(m) }));
    await ext.extract("my name is Brian");
    expect(lines.some((l) => l.includes("1 fact(s)") && l.includes("name=Brian"))).toBe(true);
  });

  it("debug: logs '0 facts' when extraction succeeds but finds nothing", async () => {
    const lines: string[] = [];
    const ext = new CopilotFactExtractor(opts(fakeFetch(toolResponse([])), { debug: true, log: (m: string) => lines.push(m) }));
    await ext.extract("just some task chatter");
    expect(lines.some((l) => l.includes("0 facts"))).toBe(true);
  });

  it("debug: logs a skip line with the reason on failure", async () => {
    const lines: string[] = [];
    const ext = new CopilotFactExtractor(opts(fakeFetch({ error: "boom" }, 500), { debug: true, log: (m: string) => lines.push(m) }));
    await ext.extract("hi");
    expect(lines.some((l) => l.includes("skipped") && l.includes("HTTP 500"))).toBe(true);
  });

  it("returns [] when fetch throws", async () => {
    const throwing = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
    const ext = new CopilotFactExtractor(opts(throwing));
    expect(await ext.extract("hi")).toEqual([]);
  });

  it("retries on 401 and returns facts from the successful second response", async () => {
    let callCount = 0;
    const facts = [{ kind: "identity", predicate: "name", object: "Brian", polarity: 1, confidence: 0.9 }];
    const fetchImpl = (async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(JSON.stringify({}), { status: 401, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify(toolResponse(facts)), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    let keyCallCount = 0;
    const getApiKey = async () => { keyCallCount += 1; return "tok"; };
    const ext = new CopilotFactExtractor({ getApiKey, fetchImpl });
    const out = await ext.extract("my name is Brian");
    expect(out).toEqual([
      { kind: "identity", predicate: "name", object: "Brian", polarity: 1, initialStrength: 0.9, scope: "global" },
    ]);
    expect(keyCallCount).toBeGreaterThanOrEqual(2);
  });

  it("drops candidates with invalid kind/polarity", async () => {
    const ext = new CopilotFactExtractor(opts(fakeFetch(toolResponse([
      { kind: "bogus", predicate: "x", object: "y", polarity: 1, confidence: 0.9 },
      { kind: "identity", predicate: "name", object: "", polarity: 1, confidence: 0.9 },
      { kind: "identity", predicate: "name", object: "Brian", polarity: 2, confidence: 0.9 },
    ]))));
    expect(await ext.extract("hi")).toEqual([]);
  });

  it("maps scope:project from tool response to candidate scope:project", async () => {
    const ext = new CopilotFactExtractor(opts(fakeFetch(toolResponse([
      { kind: "directive", predicate: "test-command", object: "npm test", polarity: 1, confidence: 0.9, scope: "project" },
    ]))));
    const out = await ext.extract("always run npm test for this repo");
    expect(out).toHaveLength(1);
    expect(out[0].scope).toBe("project");
  });

  it("defaults scope to global when scope is missing or invalid in tool response", async () => {
    const ext = new CopilotFactExtractor(opts(fakeFetch(toolResponse([
      { kind: "identity", predicate: "name", object: "Brian", polarity: 1, confidence: 0.9 },
      { kind: "preference", predicate: "prefers", object: "vim", polarity: 1, confidence: 0.9, scope: "bogus" },
    ]))));
    const out = await ext.extract("my name is Brian, I prefer vim");
    expect(out).toHaveLength(2);
    for (const c of out) {
      expect(c.scope).toBe("global");
    }
  });
});
