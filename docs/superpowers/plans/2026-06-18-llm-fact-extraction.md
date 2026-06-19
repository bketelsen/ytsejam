# LLM-based Fact Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace LTM's regex fact extractor with a cheap structured `claude-haiku-4.5` call (via the GitHub Copilot provider) behind an injected `FactExtractor` interface, and re-derive the existing facts clean.

**Architecture:** Mirror the existing `Embedder`/`Summarizer` dependency-injection pattern. A new `FactExtractor` interface lives in the pure `ltm` package with a `RegexFactExtractor` default; the network-bound `CopilotFactExtractor` lives in the server and is injected through `MemorySystem.open({ factExtractor })`. `SemanticStore.ingestTurn` becomes async. Production extraction is LLM-only and **skips on any failure** (returns `[]`); regex is never a runtime fallback. A one-shot script re-derives facts from existing episodic user turns, gated by a known-good-facts dry-run check.

**Tech Stack:** TypeScript, Node built-in `fetch` (no SDK), vitest, the GitHub Copilot `/chat/completions` endpoint with OpenAI-style function-calling.

## Global Constraints

- The `ltm` package (`packages/ltm`) must NOT import any network/model client. Network code lives in `server/`. (Same rule `Embedder` follows.)
- All model calls go through the GitHub Copilot provider: base URL `https://api.enterprise.githubcopilot.com`, headers `Authorization: Bearer <key>`, `Content-Type: application/json`, `Copilot-Integration-Id: vscode-chat`; on HTTP 401 re-fetch the key and retry once. Pattern reference: `packages/ltm/src/embedding/copilot-embedder.ts`.
- Extraction model: `claude-haiku-4.5`.
- Production extraction is LLM-only with **skip-on-failure**: any failure (no creds / non-200 / timeout / malformed / throw) returns `[]`. Never substitute regex output at runtime.
- `FactCandidate` shape (from `packages/ltm/src/semantic/extract.ts:12`): `{ kind: FactKind; predicate: string; object: string; polarity: 1 | -1; initialStrength: number }`. `FactKind = "preference" | "directive" | "identity" | "attribute"`.
- Confidence floor default: `0.6`. Map `confidence → initialStrength` as `clamp(confidence, 0.5, 0.95)`.
- Tests use vitest. Run a single test file with: `cd packages/ltm && npx vitest run test/<file>` (package tests) or `cd server && npx vitest run test/<file>` (server tests). Typecheck: `cd packages/ltm && npm run check` / `cd server && npm run check`.
- Do not touch the fact store dedup/decay/contradiction logic, embeddings, or episodic store.

---

### Task 1: `FactExtractor` interface + `RegexFactExtractor` (pure package)

**Files:**
- Create: `packages/ltm/src/semantic/fact-extractor.ts`
- Modify: `packages/ltm/src/index.ts` (add exports)
- Test: `packages/ltm/test/fact-extractor.test.ts`

**Interfaces:**
- Consumes: `extractFacts`, `FactCandidate` from `./extract.ts`.
- Produces: `interface FactExtractor { extract(text: string): Promise<FactCandidate[]> }`; `class RegexFactExtractor implements FactExtractor`; and re-exports `FactExtractor`, `RegexFactExtractor`, `FactCandidate`, `FactKind` from the package root (`"ltm"`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/ltm/test/fact-extractor.test.ts
import { describe, it, expect } from "vitest";
import { RegexFactExtractor } from "../src/semantic/fact-extractor.ts";
import { extractFacts } from "../src/semantic/extract.ts";

describe("RegexFactExtractor", () => {
  it("returns exactly what extractFacts returns (parity)", async () => {
    const text = "My name is Brian. I prefer my own harness.";
    const ext = new RegexFactExtractor();
    expect(await ext.extract(text)).toEqual(extractFacts(text));
  });

  it("returns [] for text with no facts", async () => {
    const ext = new RegexFactExtractor();
    expect(await ext.extract("the build passed and we moved on")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/ltm && npx vitest run test/fact-extractor.test.ts`
Expected: FAIL — cannot find module `../src/semantic/fact-extractor.ts`.

- [ ] **Step 3: Create the interface + regex impl**

```ts
// packages/ltm/src/semantic/fact-extractor.ts
import { extractFacts, type FactCandidate } from "./extract.ts";

/**
 * Pluggable fact extraction. The pure package ships only the regex impl;
 * the server injects an LLM-backed extractor via MemorySystem.open().
 */
export interface FactExtractor {
  /** Extract durable user facts from one turn's text. Returns [] when none. */
  extract(text: string): Promise<FactCandidate[]>;
}

/** Default/offline extractor: wraps the legacy regex extractFacts. */
export class RegexFactExtractor implements FactExtractor {
  async extract(text: string): Promise<FactCandidate[]> {
    return extractFacts(text);
  }
}
```

- [ ] **Step 4: Add package exports**

In `packages/ltm/src/index.ts`, change the existing line
`export { extractFacts, normalizeObject } from "./semantic/extract.ts";`
to:

```ts
export { extractFacts, normalizeObject, type FactCandidate } from "./semantic/extract.ts";
export type { FactKind } from "./types.ts";
export { type FactExtractor, RegexFactExtractor } from "./semantic/fact-extractor.ts";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/ltm && npx vitest run test/fact-extractor.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/ltm/src/semantic/fact-extractor.ts packages/ltm/src/index.ts packages/ltm/test/fact-extractor.test.ts
git commit -m "feat(ltm): add FactExtractor interface + RegexFactExtractor"
```

---

### Task 2: Inject extractor into `SemanticStore`; make `ingestTurn` async

**Files:**
- Modify: `packages/ltm/src/semantic/store.ts` (constructor, `open`, `ingestTurn`)
- Test: `packages/ltm/test/semantic-ingest-extractor.test.ts`

**Interfaces:**
- Consumes: `FactExtractor`, `RegexFactExtractor` from `./fact-extractor.ts`.
- Produces: `SemanticStore.open(storeDir: string, factExtractor?: FactExtractor)`; `ingestTurn(turn: Turn): Promise<void>` (now async, still user-gated).

- [ ] **Step 1: Write the failing test**

```ts
// packages/ltm/test/semantic-ingest-extractor.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SemanticStore } from "../src/semantic/store.ts";
import type { FactExtractor, FactCandidate } from "../src/semantic/fact-extractor.ts";
import type { Turn } from "../src/types.ts";

class FakeFactExtractor implements FactExtractor {
  public calls: string[] = [];
  constructor(private readonly out: FactCandidate[]) {}
  async extract(text: string): Promise<FactCandidate[]> {
    this.calls.push(text);
    return this.out;
  }
}

let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

function tmp(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltm-sem-"));
  return dir;
}

const userTurn: Turn = { sessionId: "s1", entryId: "e1", role: "user", text: "I prefer vim", timestamp: "2026-06-18T00:00:00Z" };
const asstTurn: Turn = { sessionId: "s1", entryId: "e2", role: "assistant", text: "I prefer vim", timestamp: "2026-06-18T00:00:01Z" };

describe("SemanticStore with injected extractor", () => {
  it("uses the injected extractor on user turns and persists the fact", async () => {
    const fake = new FakeFactExtractor([
      { kind: "preference", predicate: "prefers", object: "vim", polarity: 1, initialStrength: 0.7 },
    ]);
    const store = SemanticStore.open(tmp(), fake);
    await store.ingestTurn(userTurn);
    expect(fake.calls).toEqual(["I prefer vim"]);
    expect(store.allFacts().some((f) => f.object === "vim" && f.state === "active")).toBe(true);
  });

  it("skips extraction entirely on non-user turns", async () => {
    const fake = new FakeFactExtractor([
      { kind: "preference", predicate: "prefers", object: "vim", polarity: 1, initialStrength: 0.7 },
    ]);
    const store = SemanticStore.open(tmp(), fake);
    await store.ingestTurn(asstTurn);
    expect(fake.calls).toEqual([]);
    expect(store.allFacts()).toEqual([]);
  });

  it("defaults to the regex extractor when none injected", async () => {
    const store = SemanticStore.open(tmp());
    await store.ingestTurn({ ...userTurn, text: "My name is Brian" });
    expect(store.allFacts().some((f) => f.predicate === "name" && f.object.toLowerCase().includes("brian"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/ltm && npx vitest run test/semantic-ingest-extractor.test.ts`
Expected: FAIL — `SemanticStore.open` takes 1 arg / `ingestTurn` is not awaitable as expected.

- [ ] **Step 3: Edit `store.ts` — imports**

At the top of `packages/ltm/src/semantic/store.ts`, add to the imports:

```ts
import { RegexFactExtractor, type FactExtractor } from "./fact-extractor.ts";
```

- [ ] **Step 4: Edit `store.ts` — constructor + open + ingestTurn**

Replace the constructor and `open`:

```ts
  private factExtractor: FactExtractor;

  private constructor(factLog: JsonlLog<SemanticFact>, factExtractor: FactExtractor) {
    this.factLog = factLog;
    this.facts = factLog.load();
    this.factExtractor = factExtractor;
  }

  static open(
    storeDir: string,
    factExtractor: FactExtractor = new RegexFactExtractor(),
  ): SemanticStore {
    return new SemanticStore(
      new JsonlLog<SemanticFact>(path.join(storeDir, "facts.jsonl")),
      factExtractor,
    );
  }
```

Replace `ingestTurn`:

```ts
  /** Learn facts from one turn. Facts come from user turns only. */
  async ingestTurn(turn: Turn): Promise<void> {
    const source: SourceRef = { sessionId: turn.sessionId, entryId: turn.entryId };
    if (turn.rootSessionId && turn.rootSessionId !== turn.sessionId) {
      source.rootSessionId = turn.rootSessionId;
    }

    if (turn.role === "user") {
      for (const candidate of await this.factExtractor.extract(turn.text)) {
        this.assertFact(candidate.kind, candidate.predicate, candidate.object, candidate.polarity, candidate.initialStrength, source, turn.timestamp);
      }
    }
  }
```

> NOTE: leave the separate regex call in the purge path (`extractFacts(text)` near `store.ts:272`) UNCHANGED — purge verification must stay deterministic and offline.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/ltm && npx vitest run test/semantic-ingest-extractor.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/ltm/src/semantic/store.ts packages/ltm/test/semantic-ingest-extractor.test.ts
git commit -m "feat(ltm): inject FactExtractor into SemanticStore; async ingestTurn"
```

---

### Task 3: Thread `factExtractor` through `MemorySystem`; await ingest call sites

**Files:**
- Modify: `packages/ltm/src/api/memory-system.ts` (`MemorySystemOptions`, `SemanticStore.open` call, `await` ingest)
- Modify: `packages/ltm/src/pipeline/ingest.ts` (`await` ingest)
- Test: `packages/ltm/test/memory-system-extractor.test.ts`

**Interfaces:**
- Consumes: `FactExtractor` from `../semantic/fact-extractor.ts`.
- Produces: `MemorySystemOptions.factExtractor?: FactExtractor`, forwarded to `SemanticStore.open`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ltm/test/memory-system-extractor.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemorySystem } from "../src/api/memory-system.ts";
import type { FactExtractor, FactCandidate } from "../src/semantic/fact-extractor.ts";

class FakeFactExtractor implements FactExtractor {
  public calls = 0;
  async extract(_text: string): Promise<FactCandidate[]> {
    this.calls++;
    return [{ kind: "attribute", predicate: "uses", object: "nixos", polarity: 1, initialStrength: 0.7 }];
  }
}

let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

describe("MemorySystem factExtractor injection", () => {
  it("routes observation ingestion through the injected extractor", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltm-ms-"));
    const fake = new FakeFactExtractor();
    const mem = MemorySystem.open({ storeDir: dir, factExtractor: fake });
    await mem.recordObservation({ text: "I run nixos", timestamp: "2026-06-18T00:00:00Z", tags: ["x"] });
    expect(fake.calls).toBeGreaterThan(0);
    expect(mem.profile().attributes.some((a) => a.object === "nixos")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/ltm && npx vitest run test/memory-system-extractor.test.ts`
Expected: FAIL — `factExtractor` not a known option / extractor not invoked.

- [ ] **Step 3: Add the option + import**

In `packages/ltm/src/api/memory-system.ts`, add the import near the other semantic imports:

```ts
import type { FactExtractor } from "../semantic/fact-extractor.ts";
```

Add to `interface MemorySystemOptions` (after `embedder?: Embedder;`):

```ts
  /** Fact extractor for user turns. Defaults to the regex extractor. */
  factExtractor?: FactExtractor;
```

- [ ] **Step 4: Forward it to SemanticStore + await the two ingest calls**

Change `this.semantic = SemanticStore.open(this.storeDir);` (line ~110) to:

```ts
    this.semantic = SemanticStore.open(this.storeDir, opts.factExtractor);
```

Change `this.semantic.ingestTurn(turn);` inside `recordObservation` (line ~266) to:

```ts
      await this.semantic.ingestTurn(turn);
```

In `packages/ltm/src/pipeline/ingest.ts` (line ~92), change `this.deps.semantic.ingestTurn(turn);` to:

```ts
      await this.deps.semantic.ingestTurn(turn);
```

- [ ] **Step 5: Run test + typecheck**

Run: `cd packages/ltm && npx vitest run test/memory-system-extractor.test.ts && npm run check`
Expected: PASS (1 test) and clean typecheck (no un-awaited-promise or arity errors).

- [ ] **Step 6: Run the full package suite (regression guard)**

Run: `cd packages/ltm && npx vitest run`
Expected: all pass (the async `ingestTurn` change must not break existing ingest/purge tests).

- [ ] **Step 7: Commit**

```bash
git add packages/ltm/src/api/memory-system.ts packages/ltm/src/pipeline/ingest.ts packages/ltm/test/memory-system-extractor.test.ts
git commit -m "feat(ltm): thread factExtractor through MemorySystem; await ingest"
```

---

### Task 4: `CopilotFactExtractor` (server) — tool-use call + skip-on-failure

**Files:**
- Create: `server/src/memory/fact-extractor.ts`
- Test: `server/test/copilot-fact-extractor.test.ts`

**Interfaces:**
- Consumes: `FactExtractor`, `FactCandidate`, `FactKind` from `"ltm"`.
- Produces: `class CopilotFactExtractor implements FactExtractor`; `interface CopilotFactExtractorOptions { getApiKey: () => Promise<string | undefined>; model?: string; baseUrl?: string; confidenceFloor?: number; fetchImpl?: typeof fetch }`.

- [ ] **Step 1: Write the failing test**

```ts
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
    ])));
    expect(await ext.extract("hi")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/copilot-fact-extractor.test.ts`
Expected: FAIL — cannot find module `../src/memory/fact-extractor.ts`.

- [ ] **Step 3: Implement the extractor**

```ts
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

let warned = false;
function warnOnce(msg: string): void {
  if (warned) return;
  warned = true;
  console.warn(`[ltm fact-extractor] ${msg} Falling back to NO extraction (skip) for failed turns.`);
}

export class CopilotFactExtractor implements FactExtractor {
  private readonly getApiKey: () => Promise<string | undefined>;
  private readonly model: string;
  private readonly url: string;
  private readonly floor: number;
  private readonly fetchImpl: typeof fetch;

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
      if (!apiKey) { warnOnce("Copilot API key unavailable."); return []; }
      let res = await this.post(text, apiKey);
      if (res.status === 401) {
        apiKey = await this.getApiKey();
        if (!apiKey) return [];
        res = await this.post(text, apiKey);
      }
      if (!res.ok) { warnOnce(`Copilot returned HTTP ${res.status}.`); return []; }
      const body = (await res.json()) as {
        choices?: { message?: { tool_calls?: { function?: { arguments?: string } }[] } }[];
      };
      const args = body.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
      if (!args) return [];
      const parsed = JSON.parse(args) as { facts?: unknown };
      return this.toCandidates(parsed.facts);
    } catch (err) {
      warnOnce(`extraction threw: ${(err as Error).message}.`);
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/copilot-fact-extractor.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck**

Run: `cd server && npm run check`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/memory/fact-extractor.ts server/test/copilot-fact-extractor.test.ts
git commit -m "feat(server): CopilotFactExtractor (haiku tool-use, skip-on-failure)"
```

---

### Task 5: Wire `CopilotFactExtractor` into the server boot path

**Files:**
- Modify: `server/src/index.ts` (build + inject the extractor)

**Interfaces:**
- Consumes: `CopilotFactExtractor` from `./memory/fact-extractor.ts`; the existing `authStore` (a `PiAuthStore`) and `MemorySystem.open` call (~line 183).
- Produces: nothing new; `MemorySystem` now receives a `factExtractor`.

- [ ] **Step 1: Add the import**

In `server/src/index.ts`, near the other `./memory/...` imports:

```ts
import { CopilotFactExtractor } from "./memory/fact-extractor.ts";
```

- [ ] **Step 2: Build the extractor and inject it**

Immediately before the `ltm = MemorySystem.open({ ... })` call (~line 183), add:

```ts
  const factExtractor = new CopilotFactExtractor({
    getApiKey: () => resolveApiKey("github-copilot", authStore),
    model: process.env.YTSEJAM_LTM_FACT_MODEL,
  });
```

Then change the `MemorySystem.open` call to pass it:

```ts
  ltm = MemorySystem.open({ storeDir: ltmStoreDir, embedder: embedderResult.embedder, factExtractor });
```

Ensure `resolveApiKey` is imported in this file (it is exported from `./pi-auth.ts`); if not already imported, add:

```ts
import { resolveApiKey } from "./pi-auth.ts";
```

> NOTE: `model` is left `undefined` unless `YTSEJAM_LTM_FACT_MODEL` is set, so the extractor's `DEFAULT_MODEL` (`claude-haiku-4.5`) applies. Skip-on-failure means a creds outage degrades to "no new facts," never a crash.

- [ ] **Step 3: Typecheck + full server suite**

Run: `cd server && npm run check && npx vitest run`
Expected: clean typecheck; all server tests pass.

- [ ] **Step 4: Build verification (boot path compiles end-to-end)**

Run: `cd server && node --check src/index.ts || true` then `cd .. && npm run -s build 2>/dev/null || (cd server && npm run check)`
Expected: no type errors involving `factExtractor`/`MemorySystem.open`.

- [ ] **Step 5: Commit**

```bash
git add server/src/index.ts
git commit -m "feat(server): inject CopilotFactExtractor into the LTM bridge"
```

---

### Task 6: One-shot re-derivation script (clean wipe, gated)

**Files:**
- Create: `scripts/ltm-rederive-facts.ts`
- Create: `server/src/memory/rederive.ts` (testable core)
- Test: `server/test/rederive.test.ts`

**Interfaces:**
- Consumes: `FactExtractor` from `"ltm"`; `EpisodicStore`/`SemanticStore` from `"ltm"` (via the package's exports) for reading episodic user turns and building a fresh fact set.
- Produces: `buildFreshFacts(opts): Promise<{ facts: SemanticFactView[]; knownGood: { ok: boolean; missing: string[] } }>` and a CLI wrapper.

> The testable core lives in `server/src/memory/rederive.ts`; the thin CLI (`scripts/ltm-rederive-facts.ts`) parses args, builds the `CopilotFactExtractor`, calls the core, prints the dry-run, and on a real run replaces `facts.jsonl`.

- [ ] **Step 1: Confirm the needed package exports exist**

`buildFreshFacts` needs `EpisodicStore` and `SemanticStore` from `"ltm"`. `SemanticStore` is already exported (`index.ts:32`). Add `EpisodicStore` if missing — check:

Run: `grep -n "EpisodicStore" packages/ltm/src/index.ts`
If absent, add to `packages/ltm/src/index.ts`:

```ts
export { EpisodicStore } from "./episodic/store.ts";
```

(If this export is added, commit it with Task 6.)

- [ ] **Step 2: Write the failing test for the core**

```ts
// server/test/rederive.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EpisodicStore } from "ltm";
import type { FactExtractor, FactCandidate } from "ltm";
import { buildFreshFacts, KNOWN_GOOD } from "../src/memory/rederive.ts";

class ScriptedExtractor implements FactExtractor {
  constructor(private readonly map: Record<string, FactCandidate[]>) {}
  async extract(text: string): Promise<FactCandidate[]> { return this.map[text] ?? []; }
}

let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

function seedEpisodic(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltm-rederive-"));
  const ep = EpisodicStore.open(dir);
  ep.upsertMany([
    { id: "s/u1#0", kind: "turn", sessionId: "s", entryId: "u1", role: "user", text: "my name is Brian", timestamp: "2026-06-18T00:00:00Z", salience: 0.8, accessCount: 0, state: "active" },
    { id: "s/a1#0", kind: "turn", sessionId: "s", entryId: "a1", role: "assistant", text: "noted", timestamp: "2026-06-18T00:00:01Z", salience: 0.4, accessCount: 0, state: "active" },
  ]);
  return dir;
}

describe("buildFreshFacts", () => {
  it("re-derives facts from user turns only and reports known-good present", async () => {
    const store = seedEpisodic();
    const ext = new ScriptedExtractor({
      "my name is Brian": [{ kind: "identity", predicate: "name", object: "Brian", polarity: 1, initialStrength: 0.9 }],
    });
    const r = await buildFreshFacts({ storeDir: store, extractor: ext });
    expect(r.facts.some((f) => f.predicate === "name" && f.object === "Brian")).toBe(true);
    // assistant turn text was never extracted
    expect(r.facts.every((f) => f.object !== "noted")).toBe(true);
  });

  it("flags missing known-good facts so the caller can abort the wipe", async () => {
    const store = seedEpisodic();
    const ext = new ScriptedExtractor({}); // extracts nothing
    const r = await buildFreshFacts({ storeDir: store, extractor: ext });
    expect(r.knownGood.ok).toBe(false);
    expect(r.knownGood.missing).toContain(KNOWN_GOOD[0].label);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && npx vitest run test/rederive.test.ts`
Expected: FAIL — cannot find `../src/memory/rederive.ts`.

- [ ] **Step 4: Implement the testable core**

```ts
// server/src/memory/rederive.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EpisodicStore, SemanticStore, type FactExtractor } from "ltm";

/** Facts we expect a correct extraction to reproduce; absence aborts the wipe. */
export const KNOWN_GOOD: { label: string; predicate: string; match: (object: string) => boolean }[] = [
  { label: "name=Brian", predicate: "name", match: (o) => o.toLowerCase().includes("brian") },
  { label: "prefers own harness", predicate: "prefers", match: (o) => o.toLowerCase().includes("harness") },
];

export interface FreshFactView { kind: string; predicate: string; object: string; polarity: number; }

export interface BuildFreshFactsOptions {
  storeDir: string;
  extractor: FactExtractor;
  /** Optional: write the fresh facts.jsonl into this dir (defaults to a temp dir; caller copies on commit). */
  outDir?: string;
}

export interface BuildFreshFactsResult {
  facts: FreshFactView[];
  knownGood: { ok: boolean; missing: string[] };
  /** Path to the freshly-written facts.jsonl (in outDir) — caller copies over live on a real run. */
  freshFactsPath: string;
}

export async function buildFreshFacts(opts: BuildFreshFactsOptions): Promise<BuildFreshFactsResult> {
  const episodic = EpisodicStore.open(opts.storeDir);
  const outDir = opts.outDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ltm-fresh-facts-"));
  const fresh = SemanticStore.open(outDir, opts.extractor); // empty facts.jsonl in outDir

  for (const rec of episodic.all()) {
    if (rec.state !== "active" || rec.role !== "user" || !rec.text) continue;
    await fresh.ingestTurn({
      sessionId: rec.sessionId,
      entryId: rec.entryId ?? rec.id,
      role: "user",
      text: rec.text,
      timestamp: rec.timestamp,
    });
  }

  const all = fresh.allFacts().filter((f) => f.state === "active");
  const facts: FreshFactView[] = all.map((f) => ({ kind: f.kind, predicate: f.predicate, object: f.object, polarity: f.polarity }));
  const missing = KNOWN_GOOD.filter((g) => !all.some((f) => f.predicate === g.predicate && g.match(f.object))).map((g) => g.label);

  return {
    facts,
    knownGood: { ok: missing.length === 0, missing },
    freshFactsPath: path.join(outDir, "facts.jsonl"),
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && npx vitest run test/rederive.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Implement the CLI wrapper**

```ts
// scripts/ltm-rederive-facts.ts
import fs from "node:fs";
import { parseArgs } from "node:util";
import { PiAuthStore } from "../server/src/pi-auth.ts";
import { resolveApiKey } from "../server/src/pi-auth.ts";
import { CopilotFactExtractor } from "../server/src/memory/fact-extractor.ts";
import { buildFreshFacts } from "../server/src/memory/rederive.ts";

const { values } = parseArgs({ options: { "dry-run": { type: "boolean" }, "store-dir": { type: "string" } } });
const storeDir = values["store-dir"] ?? `${process.env.HOME}/.ytsejam/data/ltm`;
const authStore = new PiAuthStore(`${process.env.HOME}/.pi/agent/auth.json`);
const extractor = new CopilotFactExtractor({ getApiKey: () => resolveApiKey("github-copilot", authStore) });

const r = await buildFreshFacts({ storeDir, extractor });
console.log(JSON.stringify({ mode: values["dry-run"] ? "dry-run" : "rewrite", freshFactCount: r.facts.length, knownGood: r.knownGood, facts: r.facts }, null, 2));

if (!r.knownGood.ok) {
  console.error(`ABORT: known-good facts missing: ${r.knownGood.missing.join(", ")}. Not wiping.`);
  process.exit(1);
}
if (values["dry-run"]) { console.error("dry-run: no writes performed."); process.exit(0); }

// Real run: replace live facts.jsonl with the freshly-built one (operator must have stopped the server + taken a backup).
fs.copyFileSync(r.freshFactsPath, `${storeDir}/facts.jsonl`);
console.error(`rewrote ${storeDir}/facts.jsonl with ${r.facts.length} clean facts.`);
```

- [ ] **Step 7: Typecheck + commit**

Run: `cd server && npm run check`
Expected: clean.

```bash
git add scripts/ltm-rederive-facts.ts server/src/memory/rederive.ts server/test/rederive.test.ts packages/ltm/src/index.ts
git commit -m "feat(ltm): one-shot fact re-derivation (clean wipe, known-good gated)"
```

---

### Task 7: Full-suite green + lint sweep

**Files:** none (verification task)

- [ ] **Step 1: Package + server suites both green**

Run: `cd packages/ltm && npx vitest run && cd ../../server && npx vitest run`
Expected: all pass.

- [ ] **Step 2: Typecheck both**

Run: `cd packages/ltm && npm run check && cd ../../server && npm run check`
Expected: clean.

- [ ] **Step 3: Commit any incidental fixes**

```bash
git add -A
git commit -m "chore(ltm): fact-extraction suite green" || echo "nothing to commit"
```

---

## Manual rollout (after merge, NOT part of the coded tasks)

The re-derivation touches the live store, so it runs by hand like the prior remediation:

1. Deploy a release built from this branch's merge (so the server injects `CopilotFactExtractor`).
2. `systemctl --user stop ytsejam.service`
3. `cp -a ~/.ytsejam/data/ltm ~/.ytsejam/data/ltm.bak.$(date +%Y%m%d-%H%M%S)`
4. Dry-run: `cd ~/projects/ytsejam && node scripts/ltm-rederive-facts.ts --dry-run` — inspect the fresh fact set; confirm `knownGood.ok: true` and that Brian/role/own-harness (and ideally microsoft/C) appear.
5. Real run: `node scripts/ltm-rederive-facts.ts` (aborts itself if known-good missing).
6. `systemctl --user start ytsejam.service`; verify via `GET /api/admin/ltm-debug/compose?q=...` and `profile`.

## Self-Review

- **Spec coverage:** FactExtractor interface (T1) ✓; RegexFactExtractor default/fallback role (T1) ✓; SemanticStore injection + async ingest, user-gated (T2) ✓; MemorySystem threading + await call sites (T3) ✓; CopilotFactExtractor tool-use + skip-on-failure + confidence floor + confidence→strength (T4) ✓; server wiring (T5) ✓; clean-wipe re-derivation gated by known-good dry-run (T6) ✓; purge path stays regex (T2 note) ✓; testing strategy incl. mocked client (T4) ✓.
- **Placeholder scan:** none — all steps carry real code/commands.
- **Type consistency:** `FactExtractor.extract(text): Promise<FactCandidate[]>`, `SemanticStore.open(storeDir, factExtractor?)`, `MemorySystemOptions.factExtractor?`, `CopilotFactExtractor` options, and `buildFreshFacts` signatures are used identically across tasks.
