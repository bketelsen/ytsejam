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

## PR 0 — workspace plumbing (~1 day)

**Purpose:** add `~/projects/ltm` as a dependency importable from
`server/src/`. Smallest reversible change first; unblocks PRs 1-3.

### Tasks

- [ ] Decide packaging shape: file-dep (`"ltm": "file:../ltm"` in
  `server/package.json`) vs npm workspace move. Recommend file-dep.
- [ ] Wire dependency; `npm install`; confirm `import { MemorySystem }
  from "ltm"` resolves in a throwaway `server/src/_smoke.ts`.
- [ ] Validate ESM/CJS interop: LTM is pure ESM, ytsejam server is
  TS+tsx. Almost certainly works; verify before checking off.
- [ ] Add a no-op test file `server/src/memory/__tests__/ltm-import.test.ts`
  that does `import("ltm")` and asserts the symbol surface (so future
  ytsejam main breakages of the LTM contract surface during gate).
- [ ] LTM gate (`cd ~/projects/ltm && npm test && npm run check`) must
  pass standalone after the wiring.
- [ ] ytsejam gate (`scripts/gate.sh`) must pass.

### Done when

- One PR opened against ytsejam main, gate green.
- Throwaway smoke file removed; only the symbol-surface test stays.
- LTM main untouched.

---

## PR 1 — Bridge 1: cog observation → LTM `recordObservation` (~1-2 days)

**Purpose:** every cog observation also lands in LTM as
`kind: "observation"`. LTM gains a semantic search surface over Brian's
deliberate writes.

### Tasks

- [ ] New file `server/src/memory/bridge/ltm-observer.ts` (~50 LOC).
  Pure function that parses one observation line and calls
  `mem.recordObservation`.
- [ ] Hook the cog `append-to-observations.md` write path in
  `server/src/memory/index.ts` (or wherever the consolidated cog write
  layer lives — confirm during brainstorm).
- [ ] Compute `origin: "cog:<domain-path>/<filename>#<sha256(line)[:12]>"`.
- [ ] Best-effort + log: LTM unavailability must NOT block the cog write.
- [ ] Replay script `scripts/ltm-replay-cog.sh` (or `.ts`): one-shot
  walk of all `~/.ytsejam/data/*/observations.md`, seeds LTM from
  existing content. Idempotent (SEAM 4 content-addressed id makes it so).
- [ ] Periodic reconciler in the ytsejam server process: every 5 min
  (configurable), re-tail observations.md files, replay any line LTM
  doesn't have. Fail-quiet, log at WARNING per `cog-meta/patterns.md`.
- [ ] Tests:
  - parser: line shapes (tagged, untagged, multi-tag, weird whitespace)
  - origin: content-hash collisions on same line in two files distinguish
  - hook: cog write succeeds even if LTM throws
  - reconciler: tombstoned-but-re-typed line stays tombstoned (don't
    resurrect via reconcile)
- [ ] Manual smoke: write a fresh cog observation, query LTM with a
  matching question, confirm hit within 5s.

### Done when

- One PR opened, ytsejam gate + LTM gate both green.
- Replay script seeds an empty LTM store from the current cog tree
  without errors.
- Reconciler logged a clean cycle on a freshly-restarted server.

---

## PR 3 — Bridge 3: unified `recall(query)` agent tool (~1 day)

**Purpose:** single tool call returns interleaved results from both
substrates, labeled by source.

> Note: PR 3 before PR 2 (out of numeric order) because Bridge 3 makes
> Bridge 1's value visible to the agent, and Bridge 2's gate tuning
> needs real LTM data to be sensible.

### Tasks

- [ ] New file `server/src/memory/recall.ts` (~80 LOC).
- [ ] Implement interleave-top-k merge: call `mem.retrieve(query, {k: 5})`
  and `cog_search(query)` top-5, alternate them, dedupe by content (cog
  item wins when text matches an LTM observation — better `where`).
- [ ] Filter pass-through: `recall(query, {filterTags})` scopes LTM via
  SEAM 3 + cog via domain path prefix.
- [ ] Result shape: `{from, text, where, score, stale?, tags?}` per item.
- [ ] Register as agent tool alongside existing `cog_search`. Wire the
  tool catalog.
- [ ] Tests:
  - merge order: alternates correctly when both sides return ≥1
  - dedupe: LTM observation with identical text to a cog line drops
  - stale flag: LTM dormant-section result passes the flag through
  - empty side: one substrate returns 0 → other substrate's items pass through
  - filterTags: scoping behaves correctly when only one side honors a tag
- [ ] Manual smoke: ask `recall("fold-cogmemory cutover")` in a fresh
  session, confirm BOTH the dev-log entry AND the LTM turns surface
  interleaved.

### Done when

- One PR opened, ytsejam gate + LTM gate both green.
- Tool appears in the agent's tool catalog with a clear description.
- Manual recall on a query known to have both-substrate matches returns
  interleaved hits with correct labels.

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
