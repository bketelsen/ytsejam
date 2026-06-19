// server/src/memory/fact-extractor.ts
import type { FactCandidate, FactExtractor, FactKind } from "ltm";

const DEFAULT_BASE_URL = "https://api.enterprise.githubcopilot.com";
const DEFAULT_MODEL = "claude-haiku-4.5";
const VALID_KINDS: ReadonlySet<string> = new Set<FactKind>(["preference", "directive", "identity", "attribute"]);

const SYSTEM_PROMPT = [
  "You extract DURABLE FACTS ABOUT THE USER from a single chat message.",
  "Emit a fact only when it states something stable and personal: the user's identity",
  "(name, role, employer), a standing preference, a standing directive (always/never),",
  "or a durable attribute (tools they use, where they live).",
  "DO NOT emit: transient or task-scoped statements, plans for right now, opinions about",
  "the current code/task, hypotheticals, questions, code snippets, or anything about the assistant.",
  "If there are no durable user facts, return an empty list.",
  "Examples — EMIT: 'my name is Brian' -> {kind:identity,predicate:name,object:Brian}.",
  "EMIT: 'I prefer my own harness' -> {kind:preference,predicate:prefers,object:my own harness}.",
  "DO NOT EMIT: 'let's defer this right now', 'I'll fire these off before bed', 'use the current state'.",
].join(" ");

const TOOL = {
  type: "function",
  function: {
    name: "extract_user_facts",
    description: "Return the durable user facts found in the message (possibly empty).",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["facts"],
      properties: {
        facts: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "predicate", "object", "polarity", "confidence"],
            properties: {
              kind: { type: "string", enum: ["preference", "directive", "identity", "attribute"] },
              predicate: { type: "string" },
              object: { type: "string" },
              polarity: { type: "integer", enum: [1, -1] },
              confidence: { type: "number" },
            },
          },
        },
      },
    },
  },
} as const;

export interface CopilotFactExtractorOptions {
  /** Resolves a GitHub Copilot API key/token. Called again for the one 401 retry. */
  getApiKey: () => Promise<string | undefined>;
  model?: string;
  baseUrl?: string;
  /** Minimum confidence to keep a fact. Default 0.6. */
  confidenceFloor?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class CopilotFactExtractor implements FactExtractor {
  private readonly getApiKey: () => Promise<string | undefined>;
  private readonly model: string;
  private readonly url: string;
  private readonly floor: number;
  private readonly fetchImpl: typeof fetch;
  private warned = false;

  private warnOnce(msg: string): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[ltm fact-extractor] ${msg} Falling back to NO extraction (skip) for failed turns.`);
  }

  constructor(opts: CopilotFactExtractorOptions) {
    this.getApiKey = opts.getApiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.url = `${opts.baseUrl ?? DEFAULT_BASE_URL}/chat/completions`;
    this.floor = opts.confidenceFloor ?? 0.6;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async extract(text: string): Promise<FactCandidate[]> {
    try {
      let apiKey = await this.getApiKey();
      if (!apiKey) { this.warnOnce("Copilot API key unavailable."); return []; }
      let res = await this.post(text, apiKey);
      if (res.status === 401) {
        apiKey = await this.getApiKey();
        if (!apiKey) return [];
        res = await this.post(text, apiKey);
      }
      if (!res.ok) { this.warnOnce(`Copilot returned HTTP ${res.status}.`); return []; }
      const body = (await res.json()) as {
        choices?: { message?: { tool_calls?: { function?: { arguments?: string } }[] } }[];
      };
      const args = body.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
      if (!args) return [];
      const parsed = JSON.parse(args) as { facts?: unknown };
      return this.toCandidates(parsed.facts);
    } catch (err) {
      this.warnOnce(`extraction threw: ${(err as Error).message}.`);
      return [];
    }
  }

  private post(text: string, apiKey: string): Promise<Response> {
    return this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Copilot-Integration-Id": "vscode-chat",
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        tools: [TOOL],
        tool_choice: { type: "function", function: { name: "extract_user_facts" } },
      }),
    });
  }

  private toCandidates(facts: unknown): FactCandidate[] {
    if (!Array.isArray(facts)) return [];
    const out: FactCandidate[] = [];
    for (const f of facts) {
      if (!f || typeof f !== "object") continue;
      const { kind, predicate, object, polarity, confidence } = f as Record<string, unknown>;
      if (typeof kind !== "string" || !VALID_KINDS.has(kind)) continue;
      if (typeof predicate !== "string" || !predicate) continue;
      if (typeof object !== "string" || !object.trim()) continue;
      if (polarity !== 1 && polarity !== -1) continue;
      if (typeof confidence !== "number" || confidence < this.floor) continue;
      out.push({
        kind: kind as FactKind,
        predicate,
        object: object.trim(),
        polarity,
        initialStrength: Math.min(0.95, Math.max(0.5, confidence)),
      });
    }
    return out;
  }
}
