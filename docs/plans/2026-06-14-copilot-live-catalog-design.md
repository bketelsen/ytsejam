# Copilot Live Model Catalog — Design Doc

**Branch:** `feat/copilot-live-catalog`
**Brainstormed:** 2026-06-14
**Status:** approved, ready for implementation plan

## Problem

pi-ai's `@earendil-works/pi-ai` package ships a **static, build-time** model
catalog (`models.generated.js`). For the `github-copilot` provider it lists 22
models. But GitHub Copilot's actual `/models` endpoint returns the live,
account-scoped list — for Brian's enterprise account, that's **39 models**,
including:

- `claude-opus-4.7-1m-internal` (1M-context Opus, Microsoft-internal preview)
- `claude-opus-4.7-high`, `claude-opus-4.7-xhigh` (reasoning-effort variants)
- `claude-opus-4.6-1m`
- `mai-code-1-flash-internal` (Microsoft AI MAI line)
- `gpt-5.4-mini`
- `gemini-3.5-flash`

None of these are reachable through `delegate(model: "github-copilot/...")`
today, because `resolveModel()` only consults pi-ai's static catalog.
Conversely, pi-ai's catalog lists `raptor-mini` which Brian's enterprise
account does NOT have — dispatching to it produces a confusing
`400 The requested model is not supported` from the API.

Additionally, pi-ai's catalog hard-codes `baseUrl: api.individual.githubcopilot.com`
for github-copilot models. Brian's account routes to
`api.enterprise.githubcopilot.com`. This is already handled by
`getOAuthProvider("github-copilot").modifyModels()` (which rewrites the baseUrl
per token) — but the live catalog feature also needs to fetch `/models` from
the correct URL, so we use the same mechanism.

## Goals

1. Make every Copilot-entitled model in Brian's enterprise account dispatchable
   via `delegate(model: "github-copilot/<id>")`, automatically.
2. Surface a clear error for models pi-ai lists but Brian's account doesn't
   have (the `raptor-mini` ghost case) — fail at ytsejam's boundary with an
   actionable message, not at the API with `400 not supported`.
3. Preserve pi-ai's hand-curated metadata (`api`, `headers`, `compat` flags
   like `forceAdaptiveThinking`) for models it knows — pi-ai is the curated
   source of truth for *how to talk to* a model.
4. Degrade gracefully: any failure of the Copilot `/models` fetch (network
   down, OAuth fail, malformed response) falls back to pi-ai's static catalog.
   Boot does not block on this.

## Non-goals

- **No live re-fetch.** One fetch at boot, cached for process lifetime. New
  Copilot enrollments require a `systemctl --user restart ytsejam`. Brian
  restarts for every deploy anyway; a background timer is a band-aid for a
  problem that doesn't exist today. (Decision Q1 = a.)
- **No upstream pi-ai change.** This is an additive overlay in ytsejam. An
  upstream PR to pi-ai is a separate workstream.
- **No embeddings.** Copilot's `/embeddings` endpoint is in scope of a separate
  brainstorm — see issue #136.
- **No new tool surface to the agent.** This is purely a server-internal
  resolver enrichment; no new agent tool, no new CLI command.

## Architecture

One new module: **`server/src/copilot-live-catalog.ts`**. Single responsibility:
fetch Copilot's `/models` at boot, transform into `Model<any>[]`, merge with
pi-ai's static catalog per the merge policy below.

Wiring: one new call site in **`server/src/index.ts`** boot path, before the
agent manager + task manager + tool registration touch `resolveModel`.

The merge result lives in process memory. `models.ts:resolveModel` is extended
to accept an optional `extras: Model<any>[]` array, searched before pi-ai's
static catalog. Default `extras: []` preserves current behavior for callers
that don't thread the overlay through (e.g. unit tests).

No data persistence. No SQLite changes. No JSONL changes. No new config file.

One new env knob: `YTSEJAM_DISABLE_COPILOT_LIVE_CATALOG=1` (defaults to off)
disables the feature entirely.

## Components & data flow

### Public surface (`copilot-live-catalog.ts`)

```ts
export async function loadLiveCopilotModels(
  auth: PiAuthStore,
  opts?: { fetch?: typeof fetch; timeoutMs?: number },
): Promise<{
  overlay: Model<any>[];     // live-only ids with sibling-inherited metadata
  prunedIds: Set<string>;    // pi-ai-listed ids that Copilot doesn't return
}>;
// Always resolves. Never throws. Returns empty overlay + empty prunedIds
// on any failure (logged via console.warn / console.info).
```

### Internal (exported for tests)

```ts
export function mergeCatalogs(
  staticGithubCopilotModels: Model<any>[],
  liveIds: string[],
): { overlay: Model<any>[]; prunedIds: Set<string> };

export function inferModelTemplate(
  liveId: string,
  staticGithubCopilotModels: Model<any>[],
): Model<any>;
```

### Boot flow (in `index.ts`)

1. Construct `PiAuthStore`.
2. `const { overlay, prunedIds } = await loadLiveCopilotModels(authStore);`
3. Construct the per-process model resolver: `(ref) => resolveModel(ref, authStore, { extras: overlay, prunedIds })`.
4. Thread that resolver into AgentManager, TaskManager, tool registration.

### `loadLiveCopilotModels` internals

1. Check env: if `YTSEJAM_DISABLE_COPILOT_LIVE_CATALOG=1` → return empty,
   info-log "disabled by env."
2. Check creds: if `auth.hasCredentials("github-copilot") === false` → return
   empty, info-log "OAuth not configured" (NOT a warn — not having Copilot is
   a legitimate state).
3. Refresh + resolve API key via `auth.getApiKey("github-copilot")`. On
   undefined → return empty, warn-log.
4. Resolve effective baseUrl using
   `getOAuthProvider("github-copilot").modifyModels([probe], creds)[0].baseUrl`
   (same trick the diagnostic node-eval uses). This routes correctly to
   `api.enterprise.githubcopilot.com` vs `api.individual.githubcopilot.com`.
5. `fetch("${baseUrl}/models", { headers, signal: AbortSignal.timeout(5000) })`.
6. Parse-guard the response: must be `{ data: [{ id, policy?, model_picker_enabled? }, ...] }`.
   On any parse failure → return empty, warn-log.
7. Filter: keep ids where `policy?.state === "enabled" && model_picker_enabled === true`.
   (Excludes embeddings, deprecated `gpt-3.5-turbo`, internal `trajectory-compaction`.)
8. Call `mergeCatalogs(staticCopilotModels, liveIds)` and return.

### `mergeCatalogs(static, liveIds)`

- `staticIds = new Set(static.map(m => m.id))`
- `liveSet = new Set(liveIds)`
- `overlay = liveIds.filter(id => !staticIds.has(id)).map(id => inferModelTemplate(id, static))`
- `prunedIds = new Set(static.filter(m => !liveSet.has(m.id)).map(m => m.id))`
- Return `{ overlay, prunedIds }`.

### `inferModelTemplate(liveId, static)` — sibling-prefix inheritance

1. Find static model with longest common prefix with liveId, length ≥ 8 (avoids
   gluing unrelated models on coincidental short prefixes).
2. If found: clone its record, override `id` (liveId) and `name` (e.g.
   `"Claude Opus 4.7 (1m-internal)"` — strip the matched prefix from liveId,
   format).
3. If not: fall back to type-by-prefix rule:
   - `claude-*` → anthropic-messages template (id, headers, baseUrl from any
     existing github-copilot claude model in static, or hardcoded defaults if
     no claude exists)
   - everything else → openai-completions template
4. Always preserve `provider: "github-copilot"` and `baseUrl` from a sibling
   (or a default github-copilot model in static, falling back to
   `api.individual.githubcopilot.com` — `modifyModels` will rewrite per token
   at call time).

### `resolveModel` extension (`models.ts`)

```ts
export function resolveModel(
  ref: string,
  oauth?: PiAuthStore,
  opts?: { extras?: Model<any>[]; prunedIds?: Set<string> },
): Model<any>;
```

- Parse `ref` into `(provider, modelId)` as today.
- If `provider === "github-copilot" && opts?.prunedIds?.has(modelId)`:
  throw `Error("Model ${ref} is in pi-ai's catalog but not in your Copilot entitlement. Restart may help if you were recently enrolled.")`.
- Check `opts?.extras` first for a match. Return it (after applyOAuthModelOverrides).
- Else fall through to pi-ai static catalog as today.
- Default behavior unchanged for callers that don't pass `opts`.

## Error handling & observability

| Failure | Log level | Message |
|---|---|---|
| No Copilot creds | info | `github-copilot OAuth not configured; live model catalog skipped` |
| OAuth refresh fails | warn | `github-copilot OAuth token refresh failed; live model catalog skipped` |
| Network / timeout | warn | `github-copilot /models fetch failed: <cause>; using static catalog` |
| Non-2xx | warn | `github-copilot /models returned HTTP <status>; using static catalog` |
| Malformed JSON / missing data[] | warn | `github-copilot /models response malformed; using static catalog` |
| Env disable | info | `github-copilot live catalog disabled by env; using static catalog only` |
| Success | info | `github-copilot live catalog: <N> live models, <K> added (sibling-inherited), <P> pruned` |

All log messages NEVER include the OAuth token, even on error paths. Causes
that come from `fetch` errors get sanitized through the same pattern PR #122
established for `lastError.message`.

## Edge cases

1. **Boot ordering:** `loadLiveCopilotModels` is async; index.ts awaits it
   before constructing agent/task managers. Cold-start cost ≤5s (worst case is
   the fetch timeout); warm case ~300ms based on the diagnostic probe.
2. **OAuth refresh side-effect:** `auth.getApiKey()` may rewrite
   `~/.pi/agent/auth.json` if the token was expired. Already concurrency-safe
   per `pi-auth.ts` comments. Boot calling this once is benign.
3. **Embeddings & deprecated:** Copilot returns `text-embedding-3-small`,
   `gpt-3.5-turbo`, `gpt-4o-mini`, etc. with `model_picker_enabled=false`.
   Our filter excludes them. They remain unreachable through ytsejam (same as
   today).
4. **Preview models:** Gemini 3 flash + 3.1 pro have `preview=true policy=enabled
   picker=true` — they pass our filter and become reachable. Matches VS Code
   Copilot UI behavior.
5. **`raptor-mini` ghost:** pi-ai static lists it; Copilot omits for Brian.
   Lands in pruned set. `delegate(model: "github-copilot/raptor-mini")` throws
   at the resolver with a clear message.
6. **Single-process scope:** no cross-process invalidation needed. `deploy.sh`
   creates a new release symlink → new process → fresh fetch on its boot.
7. **Schema drift on `/models`:** parse-guard catches any missing field and
   falls back. We don't crash; we degrade.

## Testing

### `mergeCatalogs` unit tests (pure)

- live-only id added to overlay
- overlap id skipped (static wins)
- static-only id present in prunedIds
- empty live list → empty overlay, pruned = all static
- empty static list → overlay = all live (each via inferModelTemplate no-sibling fallback)
- non-github-copilot static entries untouched (we only act on the matching provider)

### `inferModelTemplate` unit tests (pure)

- sibling match: `claude-opus-4.7-1m-internal` against `[claude-opus-4.7, claude-opus-4.6]` → inherits 4.7, `forceAdaptiveThinking: true` preserved
- prefix collision: `claude-opus-4.7-xhigh` prefers 4.7 over 4.6 (longer prefix wins)
- no-sibling claude fallback: `claude-future-99` with empty static → anthropic-messages template
- no-sibling fallback (openai): `mai-code-1-flash-internal` → openai-completions template
- no-sibling fallback (gemini): `gemini-99-flash` → openai-completions template (matches pi-ai)
- prefix length floor: `claude-x` (7 chars common with `claude-opus-4.7`) does NOT sibling-match — falls back

### `loadLiveCopilotModels` integration tests (injected fetch mock)

- happy path: mock 200 with valid `data: [...]` → returns populated overlay
- no Copilot creds: returns empty, info log, fetch never called
- 401: returns empty, warn log, no token leaked
- 5xx: returns empty, warn log
- network throw: returns empty, warn log
- AbortError on 5s timeout: returns empty, warn log, wall-clock test completes <6s
- malformed JSON: returns empty, warn log
- missing `data[]`: returns empty, warn log
- env disable: returns empty, info log, fetch never called
- filter: response with mixed enabled/disabled + picker true/false → only `enabled && picker` survive

### e2e wiring test (extends `models.test.ts`)

- Build tiny static catalog `[claude-opus-4.7, claude-opus-4.6]`
- Loader with mock fetch returning `[claude-opus-4.7, claude-opus-4.7-1m-internal]`
- `resolveModel("github-copilot/claude-opus-4.7-1m-internal", ..., {extras, prunedIds})` → record with `api === "anthropic-messages"` and `forceAdaptiveThinking: true`
- Pruned id (`raptor-mini` in static, omitted from live) → resolver throws clear error before any API call

### Mutation-test requirement

For defensive parse-guards (malformed JSON, missing data, missing policy),
implementer must demonstrate test fails when guard is removed. Skip for
structural identity tests (returns Model[], etc).

### No live network test

Copilot API is account-bound + rate-limited + flaky as a test dependency. The
diagnostic node-eval Mentat ran (real 200 from Copilot) serves as one-time
human-eye verification of the response shape the mock asserts.

## Rollout

1. Single PR, branch `feat/copilot-live-catalog`, worktree
   `~/projects/.worktrees/ytsejam-copilot-live-catalog`.
2. Per-task review (spec compliance) after each task.
3. Final cross-task quality review using `github-copilot/claude-opus-4.8`
   (current reviewer default — NOT one of the new live-only models, since
   this PR is the one that makes them dispatchable).
4. Gate green: `scripts/gate.sh`.
5. Squash-merge to main.
6. Brian's manual `systemctl --user restart ytsejam`.
7. Verify in `journalctl --user -u ytsejam`: success info log mentioning
   live model count.
8. Smoke test: `delegate(model: "github-copilot/claude-opus-4.7-1m-internal", task: "print 1..10")`.
9. **Rollback:** set `YTSEJAM_DISABLE_COPILOT_LIVE_CATALOG=1` in
   `~/.ytsejam/ytsejam.env`, restart. No data to revert.

## Documentation

- This design doc: `docs/plans/2026-06-14-copilot-live-catalog-design.md` (canonical spec).
- Update `docs/agents/OVERVIEW.md` model-resolution section: one paragraph
  on the live-catalog merge and the disable knob.
- Update `~/.ytsejam/ytsejam.env.example` with the new `YTSEJAM_DISABLE_COPILOT_LIVE_CATALOG` knob.

## Out of scope (filed elsewhere)

- **Copilot `/embeddings` for LTM semantic recall** — issue #136. Same auth
  surface but different feature: replaces `HashEmbedder` (placeholder) with a
  real semantic embedder backed by Copilot's `text-embedding-3-small`.
