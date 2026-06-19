# LLM-based fact extraction for LTM — Design

**Date:** 2026-06-18 · **Branch:** `feat/llm-fact-extraction`

## Problem

LTM's semantic facts are low precision. The current extractor (`packages/ltm/src/semantic/extract.ts:178` `extractFacts`) is a set of regex patterns that match surface clauses with no understanding of whether a statement is a *durable fact about the user*. Result (observed in the live store, 2026-06-18): `prefers "a with a twist"`, `prefers "that"`, `uses "it"`, `prefers 'TypeScript"`→0'` (malformed), plus stray test data (`rel_dog = Biscuit`). Of 15 active facts, only ~3 are real signal (`name=Brian`, `role=Linux developer`, `prefers=my own harness`).

## Goal

Replace regex extraction with a cheap, structured LLM call (`claude-haiku-4.5` via the GitHub Copilot provider) that emits high-precision durable user facts, and re-derive the current fact set clean. Keep regex as a fallback so the `ltm` package stays pure and ingest never breaks.

## Constraints

- The `ltm` package (`packages/ltm`) is decoupled from the network. It must not import a model client. (Same rule the `Embedder` interface already follows.)
- All model calls go through the **GitHub Copilot provider** (copilot OAuth via `resolveApiKey("github-copilot")`), not the direct Anthropic API. `CopilotEmbedder` in `server/src/memory/embedder.ts` is the template for a direct copilot HTTP call.
- `SemanticStore.ingestTurn` already gates to `turn.role === "user"` (`store.ts:82`). Extraction stays user-only.
- The existing fact store machinery — `factId`, `normalizeObject`, `assertFact` dedup/contradiction/strength/decay — is unchanged. Only the *extractor* is swapped.

## Architecture

Mirror the existing `Embedder` dependency-injection pattern (`MemorySystem.open({ embedder })`).

### 1. `FactExtractor` interface — `packages/ltm/src/semantic/fact-extractor.ts` (new)

```ts
export interface FactExtractor {
  /** Extract durable user facts from one turn's text. Returns [] when none. */
  extract(text: string): Promise<FactCandidate[]>;
}
```

- `RegexFactExtractor implements FactExtractor` — wraps today's `extractFacts` (sync → `async`). This is the **default** (tests, CLI, offline) and the **fallback**.
- The interface is `async` so an LLM impl fits without further signature churn.

### 2. `SemanticStore` takes an injected extractor

- Constructor gains an optional `factExtractor?: FactExtractor`, defaulting to `new RegexFactExtractor()`.
- `ingestTurn(turn)` becomes `async`. For `role === "user"` it `await`s `this.factExtractor.extract(turn.text)` and feeds each `FactCandidate` to the unchanged `assertFact(...)`.
- Callers of `ingestTurn` (`MemorySystem` at `memory-system.ts:266`, `pipeline/ingest.ts:92`) become `await`-ing. The purge path's separate `extractFacts(text)` call (`store.ts:272`) stays on regex deliberately — purge verification must be deterministic and offline.

### 3. `CopilotFactExtractor` — `server/src/memory/fact-extractor.ts` (new, server side)

`implements FactExtractor`. One turn → one Copilot chat call to `claude-haiku-4.5` using **tool-use** for forced structured output:

```
tool: extract_user_facts
input_schema: {
  facts: [{
    kind: "identity" | "preference" | "directive" | "attribute",
    predicate: string,        // e.g. "name", "role", "prefers", "uses", "works_at"
    object: string,           // the value, e.g. "Brian"
    polarity: 1 | -1,         // +1 = is/likes, -1 = isn't/dislikes
    confidence: number        // 0..1
  }]
}
```

- **System prompt:** extract only durable facts *about the user* — identity, stable preferences, standing directives, attributes. Skip transient statements, task/tool chatter, code, hypotheticals, and anything about the assistant. Return an empty list when there is nothing. Include a few good-vs-bad few-shot examples drawn from the observed junk (e.g. reject "defer right now", accept "prefers my own harness").
- **Decoding:** low temperature; `tool_choice` forcing the tool.
- **Mapping:** `confidence → initialStrength` (clamped into the strength range the regex path uses). `kind/predicate/object/polarity` map straight to `FactCandidate`.
- **Threshold:** drop candidates below a confidence floor (default 0.6, configurable).
- **Fallback (critical):** any failure — missing copilot creds, network/timeout, non-200, malformed/missing tool call, schema-invalid output — logs once and falls back to `RegexFactExtractor.extract(text)`. Ingest must never throw because of extraction.

### 4. Wiring — `server/src/index.ts`

Where the server builds the embedder (~line 170), also build the `CopilotFactExtractor` (reusing the copilot api-key resolver) and pass it: `MemorySystem.open({ storeDir, embedder, factExtractor })`. When copilot creds are absent, construction yields a `RegexFactExtractor` instead (same opt-down posture as the embedder's hash fallback, but for correctness rather than dimension).

### 5. One-shot re-derivation — `scripts/ltm-rederive-facts.ts` (new)

Cleans the existing 15 facts using the new extractor. Server **stopped**, backup first.

- Open the store; iterate existing episodic `role:"user"` records; run the LLM extractor over each; collect candidates.
- Rebuild the active fact set through the normal `assertFact` pipeline (real sources, dedup, contradiction). Redact prior active facts not reproduced by the clean extraction.
- `--dry-run` prints before/after (which of the 15 survive, what new facts appear) for review **before** any write. Real run requires the dry-run to have been inspected.
- Rate-limited; bounded to user turns (a fraction of the 32k episodic records).

## Data flow

```
new user turn → ingest → SemanticStore.ingestTurn(turn)   [role===user]
   → await factExtractor.extract(turn.text)                [Copilot haiku, tool-use]
       → on failure → RegexFactExtractor.extract(turn.text)
   → FactCandidate[] → assertFact() (existing dedup/contradiction/strength/decay)
```

Downstream of `assertFact` is untouched.

## Error handling

| Failure | Behavior |
|---|---|
| No copilot creds at startup | server builds `RegexFactExtractor`; logs the opt-down once |
| Copilot call fails / times out / non-200 | per-call fallback to regex; warn once |
| Malformed or missing tool output | discard, fall back to regex |
| Confidence < floor | candidate dropped |
| Duplicate fact | existing `factId` dedup → reinforcement, not a new row |

## Testing (TDD)

- `RegexFactExtractor` parity: same output as today's `extractFacts` for a battery of inputs (regression guard).
- `FakeFactExtractor` (deterministic) to test the async, user-gated `ingestTurn` without network.
- `CopilotFactExtractor` with a **mocked** copilot client: prompt/schema construction, response parsing, confidence→strength mapping, threshold, and every fallback branch. No live model calls in CI.
- `ingestTurn`: user turns extracted; non-user turns skipped.
- Re-derivation: dry-run output shape against a small fixture of real-looking user turns.

## Non-goals (YAGNI)

- No change to the fact store, dedup, decay, contradiction logic, embeddings, or episodic store.
- No consolidation-time batching (chosen: per user-turn).
- No full re-extract over all 853 historical sessions — the re-derivation script covers the cleanup; a full historical backfill is a separate, optional op.

## Open implementation detail (resolve in the plan)

The exact Copilot chat-completions endpoint + request shape for a tool-use call (mirroring `CopilotEmbedder`'s use of the copilot api-key resolver and base URL), and whether `@earendil-works/pi-agent-core` exposes a one-shot "generate with tool" helper to reuse instead of a hand-rolled `fetch`. Everything else is settled.

## Files touched

- `packages/ltm/src/semantic/fact-extractor.ts` — new (`FactExtractor`, `RegexFactExtractor`)
- `packages/ltm/src/semantic/store.ts` — inject extractor; `ingestTurn` async
- `packages/ltm/src/api/memory-system.ts` — thread `factExtractor` through `open()`; `await` ingest
- `packages/ltm/src/pipeline/ingest.ts` — `await` ingestTurn
- `packages/ltm/src/index.ts` — export `FactExtractor`/`RegexFactExtractor`
- `server/src/memory/fact-extractor.ts` — new (`CopilotFactExtractor`)
- `server/src/index.ts` — build + inject the copilot extractor
- `scripts/ltm-rederive-facts.ts` — new (one-shot cleanup)
- tests alongside each
