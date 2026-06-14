# CopilotEmbedder + runtime embedder factory — design

Resolves [#136](https://github.com/bketelsen/ytsejam/issues/136). Adds a fourth `Embedder` implementation backed by Copilot's `/embeddings` endpoint AND fixes the structural gap that the runtime `MemorySystem` silently uses `HashEmbedder` regardless of what embedders the `packages/ltm` package ships. Both Copilot and Ollama get wired into the live server in the same PR.

## Background

`packages/ltm` ships four embedders after this PR: `HashEmbedder` (default, 256-dim feature-hash, no semantic content), `LocalEmbedder` (transformers.js, in-process seam — model integration still deferred), `OllamaEmbedder` (working, 768-dim default via `nomic-embed-text`, requires the Ollama daemon), and the new `CopilotEmbedder` (1536-dim via `text-embedding-3-small`, requires Copilot OAuth in `PiAuthStore`).

`packages/ltm/src/api/memory-system.ts` already accepts an optional `embedder` in `MemorySystemOptions` and defaults to `new HashEmbedder()`. The runtime server (`server/src/index.ts:139`) and the LTM CLI (`server/src/cli/ltm-commands.ts:47`) both call `MemorySystem.open({ storeDir })` with no embedder, so the running ytsejam agent has been recording every observation with hash vectors since the cog→LTM bridge shipped (PR #96). The `recall(query)` tool (PR #101) has been doing token-overlap matching, not semantic recall.

The structural lesson observed 2026-06-14: a package can be "shipped" while the only consumer silently uses the default. The package gate goes green; the consumer's gate asserts nothing about the construction choice; the regression is invisible. This design fixes the immediate symptom (no Copilot, no live Ollama) AND the structural cause (one source of truth for runtime embedder selection that future embedders extend instead of bypass).

## Architecture

Four moving parts, in dependency order:

1. **`CopilotEmbedder`** (`packages/ltm/src/embedding/copilot-embedder.ts`). Mirrors `OllamaEmbedder` shape — `static async create()`, probe-once for dimension, defensive L2 renorm, plain `fetch`, no SDK. Constructor takes `getApiKey: () => Promise<string | undefined>` so the package stays zero-dep on PiAuthStore; the ytsejam server injects `() => store.getApiKey('github-copilot')` at construction time.

2. **Runtime embedder factory** (`server/src/memory/embedder.ts`, new). One function `createLtmEmbedder(authStore, opts)` that:
   - Reads `YTSEJAM_LTM_EMBEDDER` (`auto` | `copilot` | `ollama` | `hash`).
   - In `auto` mode: probes Copilot creds → Ollama reachability → falls back to Hash. Logs the selection.
   - In a pinned mode: constructs that embedder exclusively; throws if the backend is unreachable (fail-closed).
   - Wraps the result in `CachedEmbedder` with namespace `"<provider>:<modelName>"` (e.g. `"copilot:text-embedding-3-small"`, `"ollama:nomic-embed-text:latest"`).
   - Returns `{embedder, label, dimension}` for the caller to log and use in startup checks.

3. **Server + CLI wire-in**. `server/src/index.ts:139` and `server/src/cli/ltm-commands.ts:47` both go through the factory. Single source of truth; the next embedder is a one-file adapter plus one factory case.

4. **Dimension-mismatch refusal at startup**. The factory's dimension is compared against the existing LTM index dimension (if the store has prior data). On mismatch the server logs `"LTM embedder dimension changed from N → M. Run: node server/src/index.ts ltm replay --force"` and exits non-zero. No auto-replay — the operator owns the cutover deliberately. Same check in the `ltm health` CLI path so misconfiguration is detected outside of a full server start.

Eval discipline (PLAN-OLLAMA pattern): `npm run eval:copilot` runs the LTM eval harness against Copilot, mutex with `--semantic` / `--ollama`, results land in the README maturity table. `CachedEmbedder` makes re-runs free after the first.

## Configuration

| env var | values | default (prod) | default (dev) |
| --- | --- | --- | --- |
| `YTSEJAM_LTM_EMBEDDER` | `auto` \| `copilot` \| `ollama` \| `hash` | `copilot` | `auto` |
| `YTSEJAM_LTM_OLLAMA_MODEL` | model id | `nomic-embed-text:latest` | same |
| `YTSEJAM_LTM_OLLAMA_URL` | base url | `http://localhost:11434` | same |
| `YTSEJAM_LTM_COPILOT_MODEL` | model id | `text-embedding-3-small` | same |
| `YTSEJAM_LTM_COPILOT_URL` | base url | `https://api.enterprise.githubcopilot.com` | same |

Prod `copilot` is pinned-and-fail-closed: if the Copilot OAuth token vanishes, the server refuses to start until either the token is restored or the operator opts down to `ollama` or `hash`. The cost of a startup failure on credential expiry is much lower than the cost of silently re-embedding observations with the wrong model. Dev defaults to `auto` so contributors without Copilot creds get a working server.

`deploy/dev.sh` and the prod systemd unit set these explicitly (no inheritance — per the pattern "a dev/test launcher SETs every isolation-critical env var explicitly").

## Data flow

**Observation recording:**

`memory.recordObservation()` → `MemorySystem.recordObservation()` → `this.embedder.embed(text)` → `CachedEmbedder` checks disk → on miss, `CopilotEmbedder.embed()` POSTs to `/embeddings` with `Authorization: Bearer <key>`, `Content-Type: application/json`, `Copilot-Integration-Id: vscode-chat` → response `{data: [{embedding: [...]}]}` → defensive L2 renorm → cache write → JSONL append with the 1536-dim vector.

**Recall:**

`recall(query)` → `MemorySystem.retrieve()` → `this.embedder.embed(query)` → `CachedEmbedder` hits on identical query, otherwise one round-trip — same path as recording.

**Startup:**

`server/src/index.ts` → `createLtmEmbedder(authStore, {mode: env.YTSEJAM_LTM_EMBEDDER})` → reads mode, runs probe (or pinned construction), wraps in `CachedEmbedder` namespaced by provider+model, returns `{embedder, label, dimension}` → server logs `"LTM embedder: copilot:text-embedding-3-small (1536-dim)"` → `MemorySystem.open({storeDir, embedder})` → dimension-mismatch check against existing index → either proceed or refuse-with-message.

## Error handling

**`CopilotEmbedder.embed()`:**
- HTTP non-2xx: throw with `{url, model, status, body}` in the message.
- HTTP 401: refetch the API key via `getApiKey()`, retry once with the fresh token, then throw if it fails again. (One-shot retry only — 401 is the OAuth-expiry case the auth-injection contract is designed to fix; other transients belong in a higher layer.)
- Missing `data[0].embedding`: throw with the contract violation and the response body prefix.
- Dimension wire-disagrees with configured: throw, instruct to drop the `dimension` option to probe.
- `getApiKey()` returns undefined: throw immediately, the server already failed the startup probe so this is an invariant violation.

**Factory:**
- `auto` mode, all probes fail: log loudly, fall through to `HashEmbedder` with WARN. Server starts.
- Pinned mode, probe fails: throw with the cause. Server exits non-zero with the error message containing the env var to change.

**Dimension mismatch at startup:**
- Detected: log the mismatch and the exact `ltm replay --force` command. Exit non-zero. No auto-replay.
- Same check in `ltm health` so the operator can validate config without starting the full server.

**Observer bridge:**
- Already catches embedder failures (per Bridge 1 design, PR #96). Continues working even if one observation fails to embed. A persistent embed failure pattern would surface in the WARN log volume — visible signal, not silent loss.

## Testing

Unit tests, all hermetic (mocked `globalThis.fetch`):

1. `CopilotEmbedder` probe sets dimension from the wire (1536 for the live model, mocked).
2. Subsequent `embed()` reuses discovered dimension, no second probe.
3. HTTP 500 throws with url + model + status + body.
4. HTTP 401 triggers one-shot key refetch + retry; second 401 throws.
5. Missing `data[0].embedding` throws with contract-violation context.
6. Returned vector is unit-norm (sum-of-squares ≈ 1 within 1e-9).
7. `getApiKey()` returning undefined throws immediately.
8. Composes with `CachedEmbedder` — repeat calls cache-hit (existing `countingEmbedder` pattern, wraps the Copilot embedder).

Factory tests (`server/src/memory/embedder.test.ts`):

9. `auto` mode with Copilot creds present selects Copilot.
10. `auto` mode without Copilot, with Ollama reachable, selects Ollama.
11. `auto` mode with neither falls back to Hash with WARN.
12. Pinned `copilot` with no creds throws.
13. Pinned `ollama` with unreachable daemon throws.
14. Namespace string is `"<provider>:<modelName>"` for all real embedders; `"hash:N"` for hash fallback.

Live smoke test (`packages/ltm/test/copilot-live.test.ts`):

15. Gated behind `LTM_COPILOT_LIVE=1` env var. Asserts a real `text-embedding-3-small` embed returns a 1536-dim unit-norm vector. NOT in default `npm test`.

Server integration test (one):

16. Server startup with a stored LTM whose index dimension disagrees with the configured embedder dimension refuses to start and logs the remediation command.

## Migration / cutover

This is the **first** cutover that exercises the dimension-mismatch refusal — Brian's live LTM store at `~/.ytsejam/data/memory/ltm/` is full of 256-dim hash vectors. The PR ships the detection-and-refuse logic; the actual cutover is a deliberate operator step:

1. Merge + deploy. First restart triggers the dimension-mismatch refusal (256 → 1536); server exits with the remediation command.
2. Operator runs `node server/src/index.ts ltm replay --force`. Re-embeds every record with Copilot. Brian's store is small enough that this is seconds-to-minutes.
3. Operator restarts the service. Startup probe succeeds, dimensions match, server opens.

The cutover is loud, visible, single-stepped. Future embedder swaps follow the same script.

## Anti-goals

- **Not adding Copilot to `dependencies` or `peerDependencies` of `packages/ltm`.** Pure `fetch`, like `OllamaEmbedder`.
- **Not batching embed calls.** The OpenAI shape supports it but `CachedEmbedder` plus the per-observation single-string contract makes this YAGNI until benchmarks show >20% time in HTTP overhead.
- **Not auto-replaying on dimension change.** Deliberate operator step.
- **Not making Copilot the default for `packages/ltm`'s eval harness.** `HashEmbedder` stays the default there — `npm test` and `npm run eval` remain hermetic and free.
- **Not changing the `Embedder` interface, the cache layer, or the JSONL store layout.**
- **Not splitting LTM stores by embedder.** One store, one embedder per deployment.

## Rollout discipline

One PR. Commits structured:

1. `feat(ltm): CopilotEmbedder adapter + unit tests`
2. `feat(ltm): eval CLI --copilot mode + npm run eval:copilot`
3. `feat(server): runtime embedder factory + Copilot/Ollama wire-in`
4. `feat(server): dimension-mismatch refusal at startup`
5. `docs: README + AGENTS.md + this design`

Gate: `scripts/gate.sh` plus `npm run eval:copilot` on Brian's host (will run live against Copilot — one-time cost, then cached).

Operator runbook for the cutover lands in the PR description, not the docs (it's a one-time event, not a recurring procedure).
