// server/src/memory/dream/miner.ts
import type { Proposal } from "./types.ts";
import { keyOf } from "./proposal-store.ts";

const DEFAULT_BASE_URL = "https://api.enterprise.githubcopilot.com";

const SYSTEM_PROMPT = [
  "You maintain a durable fact profile about ONE user. You are given the current facts and recent statements the USER made.",
  "Propose changes via the propose_changes tool. ONLY user statements are evidence — never infer facts from assistant text.",
  "drop: an existing fact that is junk, obsolete, or task-scoped. merge: 2+ existing facts that are the same fact (give the canonical form). resolve: two facts that contradict (keep one, drop the other). add: a durable user fact missing from the set, grounded in a quoted user statement (include sourceRef).",
  "Be conservative — when unsure, propose nothing. Set confidence in [0,1]; low confidence will be discarded.",
].join(" ");

const TOOL = {
  type: "function",
  function: {
    name: "propose_changes",
    description: "Return proposed fact-profile changes (possibly empty).",
    parameters: {
      type: "object", additionalProperties: false, required: ["proposals"],
      properties: { proposals: { type: "array", items: {
        type: "object", additionalProperties: false, required: ["kind", "factIds", "rationale", "confidence"],
        properties: {
          kind: { type: "string", enum: ["drop", "merge", "resolve", "add"] },
          factIds: { type: "array", items: { type: "string" } },
          rationale: { type: "string" }, confidence: { type: "number" },
          add: { type: "object", additionalProperties: false,
            required: ["kind", "predicate", "object", "polarity", "sourceRef"],
            properties: { kind: { type: "string" }, predicate: { type: "string" }, object: { type: "string" },
              polarity: { type: "integer", enum: [1, -1] },
              sourceRef: { type: "object", additionalProperties: false, required: ["sessionId", "entryId"],
                properties: { sessionId: { type: "string" }, entryId: { type: "string" } } } } },
          canonical: { type: "object", additionalProperties: false, required: ["kind", "predicate", "object", "polarity"],
            properties: { kind: { type: "string" }, predicate: { type: "string" }, object: { type: "string" }, polarity: { type: "integer", enum: [1, -1] } } },
        } } } },
    },
  },
} as const;

export interface MinerDeps {
  facts: { id: string; kind: string; predicate: string; object: string; polarity: 1 | -1 }[];
  userTurns: { sessionId: string; entryId: string; text: string }[];
  dismissedKeys: Set<string>;
  getApiKey: () => Promise<string | undefined>;
  model: string; baseUrl?: string; minConfidence: number;
  fetchImpl?: typeof fetch;
  idFor: (seed: string) => string;
}

export async function mineProposals(deps: MinerDeps): Promise<Proposal[]> {
  if (deps.userTurns.length === 0 && deps.facts.length === 0) return [];
  const apiKey = await deps.getApiKey();
  if (!apiKey) return [];
  const fetchImpl = deps.fetchImpl ?? fetch;
  const userMsg = JSON.stringify({
    facts: deps.facts,
    recent_user_statements: deps.userTurns.map((t) => ({ sessionId: t.sessionId, entryId: t.entryId, text: t.text })),
  });
  const res = await fetchImpl(`${deps.baseUrl ?? DEFAULT_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Copilot-Integration-Id": "vscode-chat" },
    body: JSON.stringify({ model: deps.model, temperature: 0,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userMsg }],
      tools: [TOOL], tool_choice: { type: "function", function: { name: "propose_changes" } } }),
  });
  if (!res.ok) return [];
  const json = (await res.json()) as { choices?: { message?: { tool_calls?: { function?: { arguments?: string } }[] } }[] };
  const args = json.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!args) return [];
  let parsed: { proposals?: unknown };
  try { parsed = JSON.parse(args) as { proposals?: unknown }; } catch { return []; }
  if (!Array.isArray(parsed.proposals)) return [];

  const out: Proposal[] = [];
  for (const raw of parsed.proposals) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const kind = r.kind;
    if (kind !== "drop" && kind !== "merge" && kind !== "resolve" && kind !== "add") continue;
    const confidence = typeof r.confidence === "number" ? r.confidence : 0;
    if (confidence < deps.minConfidence) continue;
    const factIds = Array.isArray(r.factIds) ? (r.factIds.filter((x) => typeof x === "string") as string[]) : [];
    if (kind === "add" && !r.add) continue;
    if ((kind === "drop" || kind === "merge" || kind === "resolve") && factIds.length === 0) continue;
    const p: Proposal = {
      id: deps.idFor(`${kind}:${factIds.join(",")}:${JSON.stringify(r.add ?? "")}`),
      kind, factIds,
      add: r.add as Proposal["add"], canonical: r.canonical as Proposal["canonical"],
      rationale: typeof r.rationale === "string" ? r.rationale : "",
      confidence, status: "pending",
    };
    if (deps.dismissedKeys.has(keyOf(p))) continue; // anti-thrash
    out.push(p);
  }
  return out;
}
