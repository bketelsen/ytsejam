// server/test/memory/dream/miner.test.ts
import { describe, it, expect } from "vitest";
import { mineProposals } from "../../../src/memory/dream/miner.ts";
import { keyOf } from "../../../src/memory/dream/proposal-store.ts";

function fetchReturning(toolArgs: unknown): typeof fetch {
  const body = { choices: [{ message: { tool_calls: [{ function: { name: "propose_changes", arguments: JSON.stringify(toolArgs) } }] } }] };
  return (async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
}
let n = 0;
const deps = (over: Partial<Parameters<typeof mineProposals>[0]>) => ({
  facts: [{ id: "f1", kind: "attribute", predicate: "uses", object: "git", polarity: 1 as const }],
  userTurns: [{ sessionId: "s", entryId: "e", text: "I prefer Go" }],
  dismissedKeys: new Set<string>(), getApiKey: async () => "tok", model: "m", minConfidence: 0.6,
  idFor: () => `p${n++}`, ...over,
});

describe("mineProposals", () => {
  it("parses proposals, drops below-confidence, and filters dismissed", async () => {
    n = 0;
    const fetchImpl = fetchReturning({ proposals: [
      { kind: "drop", factIds: ["f1"], rationale: "generic", confidence: 0.9 },
      { kind: "add", factIds: [], add: { kind: "preference", predicate: "prefers", object: "Go", polarity: 1, sourceRef: { sessionId: "s", entryId: "e" } }, rationale: "stated", confidence: 0.4 },
    ] });
    const out = await mineProposals(deps({ fetchImpl }));
    expect(out.map((p) => p.kind)).toEqual(["drop"]); // add dropped: confidence < 0.6
    expect(out[0].status).toBe("pending");
  });

  it("excludes a proposal whose key is in the dismissed set", async () => {
    n = 0;
    const fetchImpl = fetchReturning({ proposals: [ { kind: "drop", factIds: ["f1"], rationale: "x", confidence: 0.9 } ] });
    const dropProposal = { id: "z", kind: "drop" as const, factIds: ["f1"], rationale: "", confidence: 0.9, status: "dismissed" as const };
    const out = await mineProposals(deps({ fetchImpl, dismissedKeys: new Set([keyOf(dropProposal)]) }));
    expect(out).toHaveLength(0);
  });
});
