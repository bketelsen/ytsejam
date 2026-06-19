# Project-Scoped LTM Facts (Phase 2) — Design

**Date:** 2026-06-18 · **Branch:** `feat/project-aware-memory`
**Series:** Phase 2 of 2. Depends on [Phase 1](2026-06-18-project-aware-recall-phase1-design.md) (the active-project resolver + the `workingDir` domain attribute).

## Problem

LTM facts are **global** — `SemanticFact`/`FactCandidate` carry no project dimension. A project rule like "always run `scripts/gate.sh` before committing **in ytsejam**" would be stored as a global directive and fire in *every* conversation (truenas-mcp, work, personal). cog handles project memory today, but via brittle keyword-trigger routing and non-semantic grep over distilled markdown. For LTM to hold project memory well — and eventually let cog's project role retire — facts must carry project scope.

## Goal

Facts gain an optional project scope. The extractor classifies each fact as global vs project-specific; the system stamps the actual project tag from Phase 1's resolver; recall surfaces global facts always and project-scoped facts only when their project is active. Additive and backward-compatible; cog is untouched.

## Constraints

- **Reuse Phase 1's active-project resolver** as the only source of the project tag — the model never emits a project id.
- Don't disturb existing global-fact behavior, dedup, decay, or contradiction.
- The `ltm` package stays network-free; the global-vs-project classification rides the existing server-side `CopilotFactExtractor`.
- Existing (untagged) facts must keep behaving exactly as today (global).

## Components

### 1. Scope on the fact model

- `FactCandidate` gains `scope?: "global" | "project"` — the *classification* the extractor returns (defaults to `"global"` when absent).
- `SemanticFact` gains `projectTag?: string` — the *resolved* project (e.g. `projects:ytsejam`). Absent ⇒ global. (Storing the resolved tag, not the raw "project" flag, keeps the store self-describing and back-compat: old facts simply lack the field.)

### 2. Extraction schema + prompt

- The `extract_user_facts` tool schema gains a per-fact `scope: "global" | "project"`.
- System-prompt guidance: identity and general preferences are **global** ("my name is Brian" stays global even when said in a ytsejam session); rules/preferences specific to the current codebase, repo, or task are **project** ("use gate.sh here", "this repo deploys via deploy.sh").
- The model returns only `scope`; it never returns a project id.

### 3. Assert-time project stamping

- `SemanticStore.ingestTurn` / `assertFact` receive the **active project tag** for the turn (passed from the ingest call site, which knows the session → Phase 1 resolver).
- If `candidate.scope === "project"` **and** an active project tag exists → `fact.projectTag = activeTag`. Otherwise the fact is global (no tag).
- Edge: `scope === "project"` but no active project → store as **global** (can't scope without a project) and debug-log via the existing fact-extractor debug channel (`YTSEJAM_LTM_FACT_DEBUG`).

### 4. Identity & contradiction

- `factId` incorporates `projectTag` (alongside kind/predicate/polarity/objectNorm), so "prefers tabs (global)" and "prefers tabs (ytsejam)" are distinct facts that **contradict/supersede independently** — a project override doesn't clobber the global belief and vice-versa.
- Contradiction and reinforcement operate **within a scope** only.

### 5. Retrieval & profile scoping

- `profile(activeProjectTag?)` returns global facts **always** + facts whose `projectTag === activeProjectTag`. With no active project, only globals.
- Fact promotion inside `recall`/`composeContext` respects the same rule, so project directives surface in their project and are invisible elsewhere.

### 6. Coexistence / migration

- cog project memory is **untouched**; LTM project facts accrue alongside it. Phase 1's `recall` already interleaves both.
- Retiring cog's project role is a **separate, later decision** — made only once LTM project-fact coverage is demonstrably good. **Explicitly out of scope here.**

## Data flow

```
project-session user turn → CopilotFactExtractor returns facts, each with scope:global|project
   → assertFact stamps projectTag = activeProjectTag (Phase 1) when scope=project
   → stored (global facts untagged; project facts tagged)
recall while project active → profile()/promotion = globals + facts tagged with active project
   → other projects never see them
```

## Error handling

| Condition | Behavior |
|---|---|
| Model omits `scope` | default `"global"` (safe) |
| `scope="project"`, no active project | store global + debug-log |
| Legacy untagged facts | behave as global (back-compat) |

## Testing

- **Scope classification → stamping** (fake extractor): `scope:"project"` + active tag → `projectTag` set; `scope:"global"` → untagged; `scope:"project"` + no active project → untagged (global) + logged.
- **`factId` scope-uniqueness:** a global and a project fact with the same predicate/object coexist; contradiction stays within scope.
- **profile/recall scoping:** project fact hidden outside its project, shown inside; globals always present; no active project → globals only.
- **Back-compat:** facts written before this change (no `projectTag`) load and surface as global.

## Non-goals (YAGNI)

- No cog removal or migration of existing cog project content.
- No cross-project fact sharing or project hierarchies.
- No re-classification of the existing global fact set — scope applies to facts learned from here on.

## Dependencies

- **Phase 1** must land first: the active-project resolver (and the `workingDir` domain attribute that powers it) is the sole source of the project tag, and the new-chat workdir flow is what makes a project actually active.

## Files (anticipated)

- `packages/ltm/src/semantic/extract.ts` — `FactCandidate.scope`; `factId` includes `projectTag`
- `packages/ltm/src/types.ts` — `SemanticFact.projectTag`
- `packages/ltm/src/semantic/store.ts` — `assertFact`/`ingestTurn` accept + stamp the active project tag; scope-aware contradiction
- `packages/ltm/src/semantic/fact-extractor.ts` — `RegexFactExtractor` emits `scope:"global"`
- `server/src/memory/fact-extractor.ts` — `CopilotFactExtractor` schema/prompt gains `scope`; maps it through
- retrieval/profile paths — scope-aware filtering
