# Tiered Patterns — Design

**Date:** 2026-06-14
**Status:** Approved, ready for implementation
**Branch:** `feat/tiered-patterns`
**Related:** ytsejam PR #135 (band-aid `patterns_bytes` 5500→8000), [[cog-meta/improvements]] item "Tiered patterns"

## Problem

`cog-meta/patterns.md` is injected in every system prompt (always-loaded tier) via `session-brief.ts` rendering `### Patterns\n\n${brief.patterns.trim()}`. The byte cap was 5500. Today (2026-06-14) /housekeeping had to push it to 8000 with a `TODO(tiered-patterns)` marker because rules earned from real failures (~21 in the ytsejam supernova) no longer fit through compression alone. Every /reflect promotion of a project-specific rule into the global file makes unrelated work pay context tax. Cap-raising without a structural fix is a known anti-pattern — the file will keep growing.

## Goal

Split patterns into two tiers:

- **Global tier** — `cog-meta/patterns.md`, cross-project rules, always loaded into session-brief, **6000-byte cap / 70-line cap**.
- **Per-domain tier** — `{domain-path}/patterns.md`, domain-specific rules, loaded **only when the domain skill activates**, **3000-byte cap / 40-line cap each**.

Bound CONCURRENT context (global + active domain), not a combined sum across all domains.

## Split test

**"Would this rule be true if ytsejam didn't exist?"** If yes → global. If no → domain. Ambiguous → global (default to visible cost over silent failure).

Applied to today's `cog-meta/patterns.md` (7 sections):

| Section | Tier | Reasoning |
|---|---|---|
| Tooling | global | cog/bash mechanics — universal |
| Memory Consistency | global | SSOT / append-only — cog universal |
| User Context | global | Brian's preferences — universal |
| Test Validation | global | LLM-eng general; calibration test universal |
| Parallel Task Safety | global | applies to any worktree-based work |
| Harness Discipline | ytsejam | every bullet names harness / server-side TS |
| Subagent Execution | ytsejam | rules earned from ytsejam's delegate system |

Predicted post-split sizes: ~5KB global / ~2.5KB ytsejam. Both fit caps with slack.

## Architecture

```
session start
  └─ session-brief.ts → cog_read("cog-meta/patterns.md")  [GLOBAL, 6KB cap]
       └─ rendered into system prompt as today

domain activation (skill triggers)
  └─ generated domain skill → cog_read("{path}/patterns.md")  [DOMAIN, 3KB cap]
       └─ arrives in tool-result context, compaction-eligible
```

## Components changed

| Component | Change | Surface |
|---|---|---|
| `cog-meta/patterns.md` | Drop Harness Discipline + Subagent Execution → ~5KB | content |
| `projects/ytsejam/patterns.md` (NEW) | Receives the 2 dropped sections → ~2.5KB | content |
| `server/src/memory/consolidated/housekeeping.ts` | `patterns_bytes: 8000` split into `global_patterns_bytes: 6000` + `domain_patterns_bytes: 3000`; scan finds all `{domain-path}/patterns.md` recursively | server (~30 LOC) |
| `server/src/memory/types.ts` | Type declaration follow-up for new threshold key(s) | server (small) |
| `server/test/memory/consolidated.test.ts` | Fixtures + assertions for both caps; remove the 9000-byte band-aid fixture | tests |
| `server/skills/cog.md` Phase 3d template | Add `cog_read("{path}/patterns.md")` to "Always read on activation" block | skill markdown |
| `server/skills/reflect.md` Gate 3 | Add LLM split-test classification step before pattern write | skill markdown |
| Runtime regeneration | After merge + restart, re-run `/cog setup` to regenerate `~/.ytsejam/data/skills/{domain}.md` from the new template | manual one-shot post-restart |

## Cap details

**Global** (`cog-meta/patterns.md`):
- `global_patterns_bytes: 6000`
- `global_patterns_lines: 70` (unchanged from today's line cap)

**Per-domain** (`{domain-path}/patterns.md`):
- `domain_patterns_bytes: 3000`
- `domain_patterns_lines: 40` (proportional to byte cap)

## Per-domain scan logic

Scan finds all `{anything}/patterns.md` files under the memory data root, **excluding**:
- `cog-meta/patterns.md` (global, scanned separately)
- `glacier/**/patterns.md` (read-only archives)

Implementation: hardcoded exclusion list (`cog-meta`, `glacier`) rather than reading `domains.yml` and intersecting. Reasoning: the scan should also catch orphaned per-domain patterns files (e.g., a removed domain's patterns.md lingering); a domains.yml-driven scan would miss them.

## /reflect Gate 3 routing

When /reflect synthesizes a candidate rule at Gate 3, **before writing**, it asks the LLM:

> Would this rule be true if {dominant_domain} did not exist?
>
> Rule: "{candidate}"
>
> Reply with one word: `global` or `domain`.

- `global` → append to `cog-meta/patterns.md`
- `domain` → append to `{dominant_domain_path}/patterns.md` (create file if missing, with L0 summary)

The classifier prompt is in the skill markdown (`server/skills/reflect.md`), not server code. Cost: ~50 tokens per promotion, 1-3 promotions per weekly /reflect run.

## Error handling

| Failure | Recovery |
|---|---|
| Per-domain patterns.md missing | `cog_read` soft-miss; skill continues. No error to user. |
| Global over-cap after promotion | /housekeeping flags via thresholds output; same as today (no auto-close) |
| Per-domain over-cap | /housekeeping flags per-file; user/Mentat prunes that domain's file |
| Reflect classifier mis-route | Cap trip on wrong tier surfaces it; re-classify at next /reflect run |
| Split-test ambiguous | Default to `global` (visible cost > silent failure) |

## Testing

**Unit:**
- Cap-check for global over/under (existing pattern, retargeted to `global_patterns_bytes`)
- Cap-check for domain over/under
- Cap-check when per-domain patterns.md missing (should not error, should not flag)
- `recursiveFindPatternsFiles()` returns correct set: includes domain paths, excludes `cog-meta`, excludes `glacier/**`

**Integration:**
- End-to-end /housekeeping run on fixture data dir with one over-cap domain patterns.md, asserts thresholds output

**Manual smoke (post-restart, Brian morning brief):**
- Activate ytsejam domain in fresh session
- Probe: ask about "harness check" or "subagent IMPLEMENTER STOP rule" — verify model has the rule in context
- Run `/housekeeping` — should report 0 violations (or just the expected new state)

## Migration (atomic in this PR)

Two commits structured for review legibility:

**Commit 1 — content split:**
- Edit `cog-meta/patterns.md` to remove Harness Discipline + Subagent Execution sections
- Create `projects/ytsejam/patterns.md` with those 2 sections + new L0 summary
- Verify: `wc -c` before = `wc -c` after-global + `wc -c` after-ytsejam ± section-header overhead

**Commit 2 — code:**
- Split `patterns_bytes` into `global_patterns_bytes: 6000` + `domain_patterns_bytes: 3000` in `housekeeping.ts`
- Remove the band-aid `TODO(tiered-patterns)` comment
- Widen scan to find recursive `{path}/patterns.md`
- Update test fixtures + assertions
- Update `types.ts` declarations for new threshold keys

**Commit 3 — skill template:**
- `server/skills/cog.md` Phase 3d template: add patterns.md to activation read list

**Commit 4 — reflect Gate 3:**
- `server/skills/reflect.md` Gate 3: insert tier classification step

## Out of scope (deferred)

- Visualization of which tier each rule lives in (no UI surface for patterns today)
- Auto-migration of other domains' rules from global (only ytsejam has rules today)
- Backfill of historical rules from glacier (curated post-housekeeping set; nothing to recover)

## Rollback

PR-revert restores single-tier code AND content. No data migration. Skill template revert means future `/cog setup` doesn't add the activation read; already-generated runtime skills keep reading a now-empty per-domain file (harmless soft-miss).

## Self-modification posture

Server-side + skill-template change; activates on Brian's next deliberate ytsejam restart. **Manual one-shot after restart:** run `/cog` to regenerate runtime domain skills with the new activation block.

## Justify-server-change (per harness-check gate)

This crosses `server/src/` — `housekeeping.ts` (~30 LOC) and `types.ts` (type only). Justified:

1. **Cap enforcement requires server-side scan** — the existing `housekeeping_scan` RPC already does file-system traversal and cap checks; widening it to recursive `{path}/patterns.md` is a natural extension, not a new substrate.
2. **No skill-only alternative.** /housekeeping is the only place that surfaces cap violations to the user; a skill cannot enforce caps without an RPC backing.
3. **All other changes are skill markdown** (3 of 4 commits) — the harness-check bias toward skills is honored where possible.

## Success criteria

1. Gate green: `scripts/gate.sh` passes
2. `cog-meta/patterns.md` ≤ 6000 bytes after split
3. `projects/ytsejam/patterns.md` ≤ 3000 bytes after split
4. `/housekeeping` post-merge run reports 0 patterns violations (or expected new shape)
5. After post-restart `/cog` regeneration, generated `projects/ytsejam.md` skill includes `cog_read("projects/ytsejam/patterns.md")` in activation block
6. /reflect Gate 3 prompts include the classifier step (verifiable by reading the updated skill markdown)

— Mentat
