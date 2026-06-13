# cog-LTM Bridge Plan

> Roadmap doc — NOT a single develop-skill execution. Each of the four
> PRs below will get its own brainstorm/write-plan/develop cycle when its
> turn comes up.

**Goal:** Wire ytsejam's cog (deliberative markdown memory) and LTM
(experiential JSONL memory with decay + semantic retrieval) through a
thin two-direction bridge: 100% additive, neither substrate changes its
storage layout, both gain capabilities they didn't have before.

**Spec:** `docs/plans/2026-06-13-cog-ltm-bridge-design.md`

**Architecture:** Three bridges in three PRs (plus PR 0 for workspace
plumbing). Each useful alone. PR 0 → PR 1 (cog → LTM ingest) →
PR 3 (unified recall) → PR 2 (LTM → cog promotion via `/reflect`).

**Tech Stack:** TypeScript (server: Node 22, vitest), npm workspaces for
the LTM dependency.

**Worktree(s):** one per PR, `/tmp/cog-ltm-bridge-<n>`.

**Branch(es):** `feat/cog-ltm-bridge-0-workspace`, `feat/cog-ltm-bridge-1-observer`, etc.

---

## PR 0 — workspace plumbing — **SUPERSEDED by phase 0.0 (PR #90, `9343dfe`)**

> Originally proposed: `"ltm": "file:../ltm"` keeping LTM as a sibling
> repo. Brian's direction: bring LTM fully into ytsejam. PR #90 imported
> LTM via `git subtree add --prefix=packages/ltm`, preserving all 68
> LTM commits in the ytsejam DAG with original shas and tags intact.
> Workspace wired in the same PR; smoke test at
> `server/test/ltm-import.test.ts`; `scripts/gate.sh` extended with an
> `ltm tests (vitest)` step (140-test LTM suite now blocks gate).
>
> Net: PR 0 done, stronger than designed. The original task list below
> is kept for historical context; do NOT re-execute.

### Original tasks (historical — DO NOT re-execute)

- [x] ~~Decide packaging shape: file-dep (`"ltm": "file:../ltm"` in
  `server/package.json`) vs npm workspace move. Recommend file-dep.~~
  Shipped as npm workspace via subtree import (stronger).
- [x] ~~Wire dependency; `npm install`; confirm `import { MemorySystem }
  from "ltm"` resolves in a throwaway `server/src/_smoke.ts`.~~
  Resolves via `packages/ltm/` workspace; smoke is permanent at
  `server/test/ltm-import.test.ts`.
- [x] ~~Validate ESM/CJS interop: LTM is pure ESM, ytsejam server is
  TS+tsx. Almost certainly works; verify before checking off.~~
  Verified by gate.
- [x] ~~Add a no-op test file `server/src/memory/__tests__/ltm-import.test.ts`
  that does `import("ltm")` and asserts the symbol surface (so future
  ytsejam main breakages of the LTM contract surface during gate).~~
  Landed at `server/test/ltm-import.test.ts` (server vitest's `include`
  is `test/**/*.test.ts`, not `src/**/__tests__/**`).
- [x] ~~LTM gate (`cd ~/projects/ltm && npm test && npm run check`) must
  pass standalone after the wiring.~~ LTM gate now lives inside
  `scripts/gate.sh` directly.
- [x] ~~ytsejam gate (`scripts/gate.sh`) must pass.~~ Passed at PR #90.

### What actually shipped

- `packages/ltm/` — full LTM tree, 67 files, history preserved via
  subtree import (PR #90 sha `9343dfe`).
- `package.json` — `workspaces` gains `"packages/ltm"`; root
  `npm test` and `npm run check` extended.
- `scripts/gate.sh` — new `ltm tests (vitest)` step.
- `server/test/ltm-import.test.ts` — symbol-surface smoke (asserts
  `MemorySystem` and `DEFAULT_CONFIG` exports).
- Standalone `~/projects/ltm` archived: README banner, tag
  `v1.0.0-archived` on commit `3631358`.

### Done when (historical)

- ~~One PR opened against ytsejam main, gate green.~~ PR #90 merged.
- ~~Throwaway smoke file removed; only the symbol-surface test stays.~~
  No throwaway needed; smoke went straight to its final location.
- ~~LTM main untouched.~~ N/A — LTM main IS ytsejam main now.

---

## PR 1 — Bridge 1: cog observation → LTM `recordObservation` (~1-2 days) — **SHIPPED**

**Purpose:** every cog observation also lands in LTM as
`kind: "observation"`. LTM gains a semantic search surface over Brian's
deliberate writes.

**Shipped:** see `docs/plans/2026-06-13-cog-ltm-bridge-1-observer-design.md`
(design) and `docs/plans/2026-06-13-cog-ltm-bridge-1-observer.md`
(implementation plan as actually executed).

### Tasks

- [x] New file `server/src/memory/bridge/ltm-observer.ts` (~50 LOC).
  Pure function that parses one observation line and calls
  `mem.recordObservation`. **Shipped at `b34b659`** (parse + origin) and
  `4a5b407` (mirrorToLtm best-effort).
- [x] Hook the cog `append-to-observations.md` write path in
  `server/src/memory/index.ts` (or wherever the consolidated cog write
  layer lives — confirm during brainstorm). **Shipped at `8ed7127`**
  (first-class `recordObservation()` + `attachLtm()` API) and `0f79ec5`
  (route `cog_append` through `recordObservation`).
- [x] Compute `origin: "cog:<domain-path>/<filename>#<sha256(line)[:12]>"`.
  **Shipped at `b34b659`** (`computeOrigin` helper).
- [x] Best-effort + log: LTM unavailability must NOT block the cog write.
  **Shipped at `4a5b407`** (`mirrorToLtm` returns `{ok:false,error}` and
  never throws).
- [x] ~~Replay script `scripts/ltm-replay-cog.sh` (or `.ts`)~~ —
  superseded by `ytsejam ltm replay [--force]` CLI subcommand
  (`server/src/cli/ltm-commands.ts`). **Shipped at `c4aa755`**. Idempotent
  via the same content-addressed origin (`hasObservation(origin)`).
- [x] Periodic reconciler in the ytsejam server process: every 5 min
  (configurable via `LTM_RECONCILE_INTERVAL_MS`), re-tail observations.md
  files, replay any line LTM doesn't have. Fail-quiet, log at WARNING per
  `cog-meta/patterns.md`. **Shipped at `53c1a93`** (`LtmReconciler`
  class), `a2b88d6` (CRLF + glacier/dotdir hardening), and `cbd789a`
  (lifecycle wiring on server boot).
- [x] Tests:
  - parser: line shapes (tagged, untagged, multi-tag, weird whitespace) — **dc389fc**
  - origin: content-hash collisions on same line in two files distinguish — **b34b659**
  - hook: cog write succeeds even if LTM throws — **4a5b407**, **8ed7127**
  - reconciler: tombstoned-but-re-typed line stays tombstoned (don't
    resurrect via reconcile) — **53c1a93** (via `hasObservation` dedup)
- [x] Manual smoke: write a fresh cog observation, query LTM with a
  matching question, confirm hit within 5s. **Documented in PR
  description; to be run post-merge by Brian.**

### Done when

- [x] One PR opened, ytsejam gate + LTM gate both green. **Branch
  `feat/cog-ltm-bridge-1-observer`, 25 commits ahead of `origin/main`,
  gate green.**
- [x] Replay script seeds an empty LTM store from the current cog tree
  without errors. **`ytsejam ltm replay` covers this; smoke deferred to
  post-merge.**
- [x] Reconciler logged a clean cycle on a freshly-restarted server.
  **Smoke deferred to post-merge per Task 9 Step 3.**

---

## PR 3 — Bridge 3: unified `recall(query)` agent tool (~1 day)

**Purpose:** single tool call returns interleaved results from both
substrates, labeled by source.

> Note: PR 3 before PR 2 (out of numeric order) because Bridge 3 makes
> Bridge 1's value visible to the agent, and Bridge 2's gate tuning
> needs real LTM data to be sensible.

### Tasks

- [x] New file `server/src/memory/recall.ts` (~80 LOC). **ddcebfc**
- [x] Implement interleave-top-k merge: call `mem.retrieve(query, {k: 5})`
  and `cog_search(query)` top-5, alternate them, dedupe by content (cog
  item wins when text matches an LTM observation — better `where`). **ddcebfc**
- [x] ~~Filter pass-through~~ **DEFERRED** — see design doc §"Non-goals"
  and `recall.ts` JSDoc. The two substrates use different coordinate
  systems (LTM tags vs cog paths) and conflating them in a single param
  is a footgun. Revisit when usage data shows agents want scoped recall;
  add SEPARATE `filterTags` (LTM-only) and `scopePaths` (cog-only)
  parameters — never a single conflated one.
- [x] Result shape: `{from, text, where, score, stale?, tags?}` per item.
  **ddcebfc** + `RecallResult` envelope adds `{hits, cogCount, ltmCount, dropped}`
- [x] Register as agent tool alongside existing `cog_search`. Wire the
  tool catalog. **f1f1a5b**
- [x] Add `getLtm()` read accessor on `memory/index.ts` so recall doesn't
  reach into module-private state. **f46eb2f**
- [x] Tests:
  - merge order: alternates correctly when both sides return ≥1 — **case 1**
  - dedupe: LTM observation with identical origin path drops — **case 2**
  - stale flag: LTM dormant-section result passes the flag through — **case 3** (deterministic mock; case 3b proves OMIT semantics)
  - empty side: one substrate returns 0 → other substrate's items pass through — **cases 4, 5, 6**
  - tag propagation on cog hits parsed as observations — **case 7**
  - OMIT tags on non-observation cog hits — **case 8** (mutant-kill via `"tags" in hit`)
  - substrate-error swallow (one side throws, other still returns) — **case 9** (mutation-tested)
  - over-drop trade-off documented — **case 10**
  - tool wiring: name, label, description, parameters schema — **3 tests in cog-recall-tool.test.ts**
  - lifecycle: getLtm accessor null/identity/post-detach — **3 tests in lifecycle.test.ts**
- [x] Manual smoke: ask `recall("bridge1 substrate-validation smoke")` in
  a fresh session post-merge, confirm cog observation at
  `cog-meta/observations.md:14` AND `dropped >= 1` (LTM duplicate
  `obs-c3f2962779f0` dropped). Documented in PR description; to be run
  post-merge by Brian.

### Done when

- [x] One PR opened, ytsejam gate + LTM gate both green. **Branch
  `feat/recall-tool`, 5 commits ahead of `origin/main` (2 docs + 3 feat),
  gate green at `f1f1a5b`.**
- [x] Tool appears in the agent's tool catalog with a clear description
  that names both substrates. **`name: "recall"`, description references
  cog + long-term memory in `server/src/tools/cog.ts`.**
- [ ] Manual recall on a query known to have both-substrate matches
  returns interleaved hits with correct labels. **Pending post-merge
  smoke by Brian.**

---

## PR 2 — Bridge 2: LTM fact promotion → cog observation (~2-3 days)

**Purpose:** when LTM turn-extracted facts cross a stability gate,
`/reflect` surfaces them as proposed cog observations for human review.

> Ship last. Tune the gate from ~14 days of real LTM data accumulated
> via Bridge 1, not from cold-design guesses.

### Tasks

- [ ] LTM-side additions (one PR to LTM main, separate from ytsejam):
  - [ ] `SemanticFact.promotedAt?: string` on the type
  - [ ] `MemorySystem.markPromoted(factId, origin: string): void` setter
  - [ ] `MemorySystem.listPromotionCandidates(gate?): SemanticFact[]`
    convenience reader applying the default gate
  - [ ] Tests: promoted fact stays listed but is flagged; markPromoted is
    idempotent
- [ ] ytsejam-side: new file `server/src/skills/reflect/ltm-promotions.ts`.
- [ ] Promotion gate: `mentionCount ≥ 3` AND `distinct sessions ≥ 2`
  AND `first-seen span ≥ 14d` AND `promotedAt === undefined`.
- [ ] Domain inference table: predicate → suggested domain path. Edit
  in place. Unsure cases route to `pkb/proposed.md`.
- [ ] `/reflect` skill update: after the existing consolidation pass,
  render the promotion candidates as a numbered list; Brian confirms
  per-line (or all-of, or none-of). Confirmed items get written via
  existing `cog_append` AND marked in LTM via `mem.markPromoted`.
- [ ] Tests:
  - gate logic: fact at 2 mentions/2 sessions → not surfaced; 3/2/15d
    → surfaced; 3/1/15d → not surfaced
  - already-promoted: surfaced once, never re-surfaced after markPromoted
  - domain inference: predicate→domain table behaves; fallback to
    `pkb/proposed.md` when no rule matches
  - loop defense (regression): Bridge 1 re-ingesting Bridge 2's output
    does NOT bump fact mentionCount (already tested in LTM SEAM 5;
    smoke-confirm here)
- [ ] Manual smoke: with ~2 weeks of Bridge 1 ingest, run `/reflect`,
  confirm the candidate list is ~10-30 items and at least 50% are
  things you'd actually promote.

### Done when

- Two PRs opened (one to LTM, one to ytsejam); both gates green; LTM PR
  merges first.
- `/reflect` weekly run surfaces a Top-N promotion list, ordered by
  confidence (sessions × span × mentionCount), with sane domain
  suggestions.
- Confirmed promotions write to cog AND tag the fact in LTM.

---

## Cross-cutting concerns

- **No band-aids.** Every PR's gate must pass cleanly; no `--no-verify`,
  no commented-out tests.
- **One PR per bridge.** Push + merge before the next. Standard ytsejam
  ship workflow.
- **Memory + dev-log discipline.** After each PR merge, append to
  `projects/ytsejam/dev-log.md` with the PR sha + LOC + gate result;
  append observation to `projects/ytsejam/observations.md` if anything
  pattern-worthy surfaced. After all 4 PRs merge, update
  `projects/ytsejam/hot-memory.md` "Current Focus" section to mention
  the cog-LTM bridge as substrate-feature.
- **Reviewer attention routing.** Each per-PR plan should label its
  "highest risk" task explicitly so the spec/quality reviewers know
  where to look hardest. Bridge 1's reconciler logic, Bridge 2's gate
  thresholds, and Bridge 3's dedupe heuristic are the candidates.
- **Substrate-swap check.** If during implementation any PR feels like
  it's pulling LTM behavior into cog (or cog into LTM), STOP and re-read
  the design doc's "bridge, not fold" section. The bridges are wires;
  if they're growing storage logic, the design is being violated.

## What this plan does NOT cover

- The brainstorm + write-plan + develop cycle for each individual PR.
  Each PR gets its own design + plan + implementer pair in its own
  worktree at the time it ships.
- Real-time fact-promotion notifications (Bridge 2 is /reflect-driven;
  event-driven is a v2 consideration if weekly batching proves lossy).
- LTM-side performance work for very large ingest volumes (the bench
  showed 20.9k turns/s ingest at 10k records; if cog drives ingest above
  that range we'll know).
- A migration tool for cog domain renames cascading to LTM origin
  selectors (`mem.renameOrigin(oldPrefix, newPrefix)`). Designed in PR 1
  implementation phase if the data shape makes it obvious; otherwise
  filed as a follow-up.
