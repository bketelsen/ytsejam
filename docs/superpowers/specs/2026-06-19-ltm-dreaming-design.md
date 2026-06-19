# LTM "Dreaming" — supervised nightly memory maintenance

**Date:** 2026-06-19
**Status:** Design (approved, pre-plan)

## Context

A run of work this week fixed the LTM memory subsystem's acute problems: bridge
auto-reconnect, an empty-query guard, fact canonicalization + a tighter
extractor (#275), a one-time live purge of 69 junk facts → 8 (#276), and the
provenance gate that stops assistant-authored cog observations from minting
"user facts" (#277).

Two gaps remain that those PRs do **not** close:

1. **No steady-state curation.** The one-time purge was a manual script because
   `purgeStaleFacts()` is regex-based and cannot resolve `cog:` origins. Drift
   (dupes, contradictions, stale facts, the occasional bad extraction from a
   user turn) will re-accumulate slowly with no automated correction.
2. **No holistic re-mining.** The per-turn extractor sees one message at a time;
   facts that only become clear across a conversation are missed, and there is
   no pass that revisits history to correct or fill them in.

This design adds a **nightly "dreaming" job**: a deterministic mechanical
maintenance pass that runs autonomously, plus an LLM pass that proposes
judgment-level corrections for the user to approve. The biological analogy is
apt — sleep both prunes weak traces and replays/integrates — but integration
stays **supervised**: the system never invents or destroys a fact on the
strength of LLM judgment alone.

## Goals

- Keep the active fact set clean and small without manual scripts.
- Catch facts the per-turn extractor missed, and contradictions/dupes that
  deterministic rules miss.
- Apply only mechanical, reversible changes autonomously; route every judgment
  call through the user.
- Preserve the #277 invariant end-to-end.

## Non-goals (deferred)

- Autonomous LLM rewriting of the store (cost, thrash, debuggability).
- Full re-mining of all session history nightly (incremental only).
- A web review UI (chat is the surface). A provenance type system or a separate
  `recordUserAssertion` API (out of scope; the existing channels suffice).

## Principles / invariant

- **Mechanical = autonomous; judgment = proposed.** Deterministic, reversible
  ops apply on their own; anything that drops, merges, resolves, or adds a fact
  is a proposal.
- **Provenance-gated.** Only user-authored turns are evidence for a fact (the
  #277 invariant). The miner ignores assistant turns; an approved `add` counts
  as a user-confirmed assertion.
- **Reversible.** Every mutating step snapshots `facts.jsonl` and writes an
  audit line; drops are tombstones, never hard deletes.
- **Anti-thrash.** Dismissed proposals are remembered and never re-surfaced.

## Architecture

A `DreamJob` subsystem in the server process (sibling of the reconciler), using
the **live `MemorySystem`** instance — same process, so no store-lock
contention. Single-purpose units:

| Unit | Responsibility | Depends on |
|---|---|---|
| `DreamScheduler` | unref'd timer; wakes hourly, runs `DreamJob` once/day after the configured hour; survives restart | `dream-state.json` |
| `MechanicalPass` | runs the deterministic ops; returns a summary | existing `MemorySystem` ops, reconciler |
| `ProposalMiner` | builds the prompt {facts + new user turns}, calls Copilot, parses → `Proposal[]` | Copilot client, mining cursor |
| `ProposalStore` | persists `pending-proposals.jsonl`; apply/dismiss; remembers dismissals | — |
| `ReportComposer` | formats the chat report text | mechanical summary + proposals |
| `ltm_apply_proposals` / `ltm_dismiss_proposals` | scoped session tools; apply/dismiss by id | `ProposalStore`, `MemorySystem` |

**Data files** (new `dream/` subdir under the ltm store dir):

- `dream-state.json` — last-run date, mining cursor, maintenance session id
- `pending-proposals.jsonl` — open proposals (stable id + status)
- `dream-log.jsonl` — per-run stats (audit)
- reuses existing `facts.jsonl.bak.<ts>` + `redactions.jsonl` for reversibility

**Flow:** timer → `MechanicalPass` (autonomous) → `ProposalMiner` →
`ProposalStore.save` → ensure maintenance session visible → `ReportComposer` →
post report → (you reply) → agent calls apply/dismiss tools.

## Phase 1 — Mechanical pass (autonomous, deterministic, idempotent)

Ordered, each step backed up + audited:

1. Snapshot `facts.jsonl` → `.bak.<ts>`.
2. **Canonicalize + dedup sweep** — new `SemanticStore` method: for each active
   fact, apply `canonicalizePredicate`; if the canonical id collides with an
   existing fact, merge (max strength, union sources, keep latest) and tombstone
   the variant. (#275's rule only covers *new* writes; this fixes stragglers and
   future drift.)
3. `consolidate()` — existing decay-driven episodic folding + semantic compaction.
4. **Orphan prune** — reuse `reconciler.reconcile({rebuild:true, prune:true})`.
5. `doctor --fix` — compact logs + prune stale ingest-state.
6. `backfillFactEmbeddings()` — embed any active facts missing an embedding.

Only canonicalize-merge and orphan-prune are destructive, both reversible via
the backup. A second run with no new drift is a no-op (tested). Returns
`{canonicalized, merged, folded, pruned, embedded}`.

## Phase 2 — Proposal miner (judgment, provenance-gated)

Inputs: the active fact set + **new user turns since the cursor** — session
files touched since the last run, `role:"user"` turns only, capped to a token
budget (newest-first). Prompt requests structured ops via a tool schema:

- `drop(factId, reason)` — junk/obsolete existing fact
- `merge(factIds[], canonical, reason)` — semantic dupes the id-dedup misses
  ("Go" vs "Go for programming tasks")
- `resolve(keepId, dropId, reason)` — a contradiction single-valued supersede missed
- `add(kind, predicate, object, sourceRef, confidence)` — a durable fact the
  per-turn extractor missed, grounded in a quoted user statement

Baked-in rules: only user statements are evidence; `add` must cite the source
turn; be conservative; **never re-propose anything in the dismissed set**. Each
proposal carries a stable id, type, payload, rationale, confidence, source ref.
Below-`DREAM_MIN_CONFIDENCE` proposals are discarded. Default model: Copilot
**sonnet** (better judgment; small nightly input keeps it cheap), configurable.

## Phase 3 — Report + supervised apply

**Maintenance session visibility (runs before posting):**
- If the stored session id is missing (deleted), recreate it and update
  `dream-state.json`.
- If `isArchived(id)`, call `unarchiveSession(id)` first — clears the archived
  flag and emits `session_unarchived`, so a hidden maintenance session pops back
  into the UI exactly when there's something to review.

**Report:** `ReportComposer` formats "Autonomous (done): …" + a numbered "Needs
your call:" list (rationale per item), appended to the maintenance session as an
assistant message via the same session append path the manager uses to persist
assistant turns — **not** `injectMessage` (which would run a real agent turn).
The append must emit the session-update event the UI already listens to, so the
report shows live. Optionally fire the notification hook.

**Apply:** your reply ("apply 1,2", "dismiss 4", "explain 3") triggers a normal
agent turn; the agent maps numbers → ids and calls the scoped tools:

- `ltm_apply_proposals(ids)` — drop→tombstone by id; merge→write canonical +
  tombstone others; resolve→tombstone loser; **add→`assertFact` via the
  user-confirmed path** (you approved → satisfies the #277 gate). Backup + audit
  each; mark applied.
- `ltm_dismiss_proposals(ids)` — marked dismissed, remembered so it never resurfaces.
- "explain N" — agent reads the rationale/source; no mutation.

New methods: `SemanticStore.redactFactById(id)` (drop); reuse `assertFact` (add)
and `restoreFacts` (merge canonical).

## Safety / reversibility

- Every mutating step (mechanical and each applied proposal) snapshots
  `facts.jsonl` and appends to `redactions.jsonl` / `dream-log.jsonl`.
- **Kill switch:** `DREAM_ENABLED=0` disables the job; `DREAM_PROPOSE_ONLY=1`
  skips even the mechanical writes (report becomes pure advisory).
- **Fail-safe:** any phase that throws logs and aborts *that run* without
  partial-applying proposals; the mechanical pass already backed up first. A
  failed night means no report — never a corrupted store.
- **Bounded cost:** incremental mining (cursor), token-budget cap, configurable model.

## Config (env, defaults)

`DREAM_ENABLED=1`, `DREAM_HOUR=3` (local), `DREAM_MODEL` (default: a Copilot
sonnet-tier model — the fact extractor already uses `claude-haiku-4.5` via the
same provider, so reuse that client with a stronger model id),
`DREAM_MINE_TOKEN_BUDGET=8000`, `DREAM_MIN_CONFIDENCE=0.6`, `DREAM_PROPOSE_ONLY=0`.

## Observability

`dream-log.jsonl` per run: `{ranAt, mechanical:{…counts}, proposed,
dismissedSkipped, reportSessionId}`, plus `applied`/`dismissed` events when you
act. The chat report is the human-facing surface.

## Testing

- `MechanicalPass`: canonicalize/dedup sweep correctness; **idempotency**
  (second run = no-op); orphan-prune reuse; backup written.
- `ProposalMiner`: stub Copilot client → provenance gate (assistant turns
  ignored), confidence floor, **dismissed-set dedup**, `add` requires a source ref.
- `ProposalStore`: persist / apply / dismiss; dismissals survive restart.
- Apply tools: drop/merge/resolve/add semantics each back up + audit; `add` goes
  through the user-confirmed gate.
- `DreamScheduler`: "due" logic — runs once/day after the hour, not twice,
  survives restart.
- Maintenance session: an archived session is unarchived before the report posts.

## Verification (end-to-end)

1. Seed a store with drift (a synonym-predicate dupe, a contradiction, an
   un-embedded fact) + a session file with a user turn stating a new fact.
2. Trigger one `DreamJob` run (test hook / forced `--now`).
3. Assert: mechanical counts > 0 and store is canonical/compacted; a report
   appears in the (unarchived) maintenance session listing the dupe-merge,
   contradiction, and the missed `add`.
4. Reply "apply all" → assert facts mutated as proposed, backups + audit written,
   proposals marked applied.
5. Re-run with no new drift → mechanical no-op, no duplicate proposals (dismissed
   + applied excluded).
