# Project-Aware Auto-Recall (Phase 1) — Design

**Date:** 2026-06-18 · **Branch:** `feat/project-aware-memory`
**Series:** Phase 1 of 2. Phase 2 = [project-scoped LTM facts](2026-06-18-project-scoped-ltm-facts-phase2-design.md).

## Problem

Memory is written but never automatically *read* into live conversations. Today the model only sees memory if (a) it chooses to call the `recall` tool mid-turn, or (b) via a static, non-query-conditioned cog brief in the system prompt. The LTM `profile()` (the user's name/preferences/directives) is **never** injected. And every new session defaults its working directory to `~/.ytsejam/data` — a useless value — so there is no project signal to scope memory by.

## Goal

Before each user message reaches the model, automatically inject relevant memory — the global profile plus project-scoped recall — and make sessions carry a meaningful project by forcing a working-directory choice at chat creation. No facts-model change; reuse the existing cog+LTM `recall`.

## Constraints

- The `ltm` package stays free of network/UI concerns.
- Reuse existing machinery: `resolveWorkdir`/`WorkdirStore`, the cog domain manifest (`domains.yml` + domain `Controller`/`triggers`), `recall()`/`composeContext`, and the `composeSystemPrompt` injection pattern already used for `cogSection`.
- The manager currently has **ingest-only** LTM coupling (`LtmIngestSink = Pick<MemorySystem,"ingestSessionFile">`). Read access is injected as a **callback**, not a direct `MemorySystem` dependency — preserving that decoupling.
- Memory injection is **best-effort**: any failure yields no section and never blocks the turn.

## Components

### 1. New-chat working-directory selection (the project *input*)

The "new chat" UI flow stops silently defaulting to `~/.ytsejam/data` and instead requires an explicit working-directory choice, offering three sources:

- **Known projects** — cog domains that declare a `workingDir` (see component 2): `{ path: workingDir, label: domain.label }`. This is the curated source of truth — the same list that the resolver maps back to a project tag.
- **Recently used** — distinct workdirs aggregated from `WorkdirStore` history (one `<sessionId>.jsonl` per session under `<dataDir>/workdirs/`; take the latest event per session, dedupe, sort by recency).
- **Free-form** — type/paste an absolute path.

UX: a choice is **required** (no silent `dataDir` default); the most-recent workdir is pre-selected for one-click confirm so it isn't friction. On confirm, the new session's workdir is set via the existing `POST /api/sessions/:id/cwd` path at creation.

Backend: a `GET /api/workdirs/suggestions` endpoint returning `{ knownProjects: {path,label}[], recent: string[] }`. Known = the domains-with-`workingDir` list; recent = aggregate `WorkdirStore`.

### 2. Active-project resolver — `server/src/memory/active-project.ts` (new)

Built on a new **optional `workingDir` attribute on cog domains** (see 2a), so resolution is an explicit lookup, not a heuristic.

`activeProjectTag(sessionId): string | null`

- `resolveWorkdir(sessionId)` → workdir.
- Find the cog domain whose `workingDir` **equals the session workdir, or is its nearest ancestor** (so any subdir of `~/projects/ytsejam` resolves to the ytsejam domain). Nearest-ancestor wins when domains nest.
- Return that domain's path in **tag form** (`projects/ytsejam` → `projects:ytsejam`) — the tag form episodic records already carry, so it feeds `filterTags` directly.
- Return `null` when no domain's `workingDir` matches (e.g. the `dataDir` default, or an unmapped directory).

This resolver is the **reusable building block Phase 2 also consumes**.

#### 2a. Domain manifest gains optional `workingDir`

`domains.yml` (and the manifest parser `server/src/memory/domain/manifest.ts`) gain an **optional** `workingDir: string` (absolute path) per domain. Optional, not required — a domain with no `workingDir` simply never matches a session workdir (recall stays global for those sessions). The manifest is `/cog`-generated, so the `/cog` flow should be able to set/preserve it; manual edits to `domains.yml` are also honored. This single field is the explicit bridge between a filesystem directory, a cog domain, and the LTM project tag.

### 3. Memory-section builder — server side

`buildMemorySection(sessionId, userMessage): Promise<string | undefined>`

- `profile = ltm.profile()` → a compact block (identity, preferences, directives, attributes) — global, always included.
- `recalled = recall(userMessage, { projectTag })` → top interleaved cog+LTM hits, project-scoped/boosted.
- Compose into a labeled section ("What you know about Brian" + "Relevant memory") within a token budget. Returns `undefined` when there's nothing.

### 4. `recall()` extension

`recall(query, opts?: { projectTag?: string; k?: number; tokenBudget?: number })`

- When `projectTag` is set, run a **project pass** (LTM `filterTags=[projectTag]`) and a **global pass**, then merge/dedupe — so project-tagged memory is surfaced **without hard-excluding global/untagged hits** (decision: boost, not hard-filter; globals like identity must still appear). Start with the two-pass merge; a single-pass retriever boost weight is a later optimization, not required here.

### 5. Injection wiring

- `composeSystemPrompt` gains a `memorySection?: string` slot (sibling to `cogSection`).
- The manager's options gain `recallSection?(sessionId, message): Promise<string|undefined>`, built in `index.ts` (which has full read access to `memory`/`ltm`); the manager calls it in the per-turn prompt builder (`manager.ts:309–320`, where `cogSection` is assembled).
- **Open implementation question (resolve in the plan):** whether the query-conditioned recall can ride in the rebuilt-per-turn system prompt (requires the incoming user message to be available at prompt-build time) or must be injected as a pre-turn context block before the user message. The non-query-conditioned `profile()` goes in the system prompt regardless. Investigate the pi-agent-core prompt-build hook to decide.

## Data flow

```
new chat → pick workdir (known/recent/free-form) → session workdir set
user message → manager prompt build → activeProjectTag(session)
            → recallSection(session, message) = profile() + recall(message, {projectTag})
            → injected into context → model sees memory BEFORE responding
```

## Error handling

| Condition | Behavior |
|---|---|
| Workdir matches no project | `projectTag = null` → recall runs global-only; profile still injected |
| `recall`/`profile` throws | section omitted; turn proceeds (best-effort) |
| Known-projects enumeration fails | fall back to recent + free-form in the picker |
| Session has no workdir set (legacy) | resolver returns null; behaves as today plus profile injection |

## Testing

- **manifest parser:** a domain with `workingDir` parses; without it parses (optional); malformed value rejected.
- **active-project resolver:** workdir == a domain's `workingDir` → its tag; workdir nested under a domain's `workingDir` → that tag; nested domains → nearest-ancestor wins; `dataDir` default / unmapped dir → null.
- **memory-section builder:** profile + scoped recall composed; empty/failure → `undefined`; uses a fake `recall`.
- **`recall()` scoping:** with `projectTag`, project-tagged hits appear AND global/untagged hits still appear (two-pass merge).
- **UI:** new-chat flow requires a workdir (no silent default); lists known + recent; free-form path accepted; pre-selects most-recent (web tests per repo conventions).

## Non-goals (YAGNI)

- No facts-model change — that's Phase 2.
- No cog removal; this *uses* cog's existing project memory via `recall`.
- No automatic project inference from message content — the **workdir** is the signal.

## Files (anticipated)

- `server/src/memory/domain/manifest.ts` + manifest types — add optional `workingDir` to the domain schema/parser
- `server/src/memory/active-project.ts` — new (resolver; reads domain `workingDir`)
- `server/src/memory/recall.ts` — extend `recall()` with `projectTag`
- `server/src/memory/<memory-section builder>` — new (compose profile + recall)
- `server/src/persona.ts` — `composeSystemPrompt` gains `memorySection`
- `server/src/manager.ts` — `recallSection` callback + call site
- `server/src/index.ts` — build/inject `recallSection`
- `server/src/server.ts` — `GET /api/workdirs/suggestions`
- `web/…` — new-chat workdir selection flow
