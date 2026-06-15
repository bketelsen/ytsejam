# Cog Decision Kind — Design Doc

**Status:** Design approved 2026-06-15. Ready for implementation as a cog/skill update (no production code).

**Companion narrative:** `wiki/ideas/cog-decision-kind/index.md` in cog memory (`/home/bjk/.ytsejam/data/memory/wiki/ideas/cog-decision-kind/index.md`) carries the same content for cross-session retrieval; this repo doc is canon.

## Problem

Cog has six effective kinds (observation, action-item, entity, thread, pattern, hot-memory). None capture **decisions** — the architectural calls that supersede prior choices or close forks, with their reasoning trail attached.

A workaround grew up in the wiki: `wiki/projects/<slug>/decisions.md`, populated by the `ship` skill as a side-effect of merging branches. It accumulated ~60 entries during the 2026-06-12/13 fold-cogmemory burst, then went dormant.

The wiki-decisions pattern failed three ways:

1. **No active trigger.** Only `ship` wrote to it; non-branch decisions (most of them) had no entry point.
2. **No retrieval path.** Not in L0 index, not loaded by domain skill, not in hot-memory. Even fresh entries went unread.
3. **Wrong home.** Wiki is read-optimized synthesis (Current State → Timeline → Insights). A chronological append log of decisions is observation-shaped data jammed into the wrong substrate.

The wiki convergence is evidence the kind has felt-need but no working substrate. **Not evidence the existing surface works.**

## Solution shape

Add `decision` as a first-class cog kind. Codify the pattern, replace the wiki surface, fix the trigger and retrieval gaps that killed v0.

## Design decisions

### 1. Scope: A′ — codify + replace + relocate + wire

Not just lift the wiki pattern (the existing thing doesn't work). Build the kind properly: trigger, file layout, retrieval, lifecycle. Migrate the existing 60 entries forward as seed corpus. Retire `wiki/projects/<slug>/decisions.md` after migration.

Rejected alternatives:
- **A (codify what works):** rejected on evidence — the wiki pattern doesn't work.
- **B (decision + question together):** holding off on `question` — speculative, no felt-pain story yet. Let it earn its place.
- **C (bigger restructure):** the wiki-vs-domain home is a separate fight. This doc decides home-of-decisions; not home-of-everything.
- **D (don't add a kind):** rejected — decisions need referenceable structure (supersedes links) that observations.md can't carry cleanly.

### 2. File layout: one `decisions.md` per domain

`projects/ytsejam/decisions.md`, `infra/decisions.md`, etc. — append-only chronological, sibling to `observations.md` / `action-items.md` / `entities.md`. Each entry is a single line with structured metadata.

Entry format:

```markdown
- 2026-06-12 [d-mem-controller-side-effect-free]: Memory module Controller is side-effect-free — the Controller class in server/src/memory/ only records root in its constructor; all methods are async stubs that throw notImplemented(pr). Real domain-controller behavior lands in PR-1b. <!-- origin: PR-0 fold-cogmemory, commits 2768acb+619d893 -->
- 2026-06-14 [d-mem-storage-rev]: Switch to per-domain shard files for scale-out. <!-- supersedes: d-mem-controller-side-effect-free, origin: PR #142 -->
```

Three fields:
- **Dated prefix** (`- YYYY-MM-DD`) — matches observations.md convention.
- **Slug id in tag brackets** (`[d-<slug>]`) — `d-` prefix marks it as a decision id; slug is short kebab-case.
- **HTML-comment metadata** (`<!-- ... -->`) — origin (PR/commit), optional supersedes link.

Body is the line itself. Reasoning is 1-3 sentences. Decisions needing more detail reference a separate design doc (`docs/plans/...` or cog `wiki/ideas/...`).

Rejected alternatives:
- **One file per decision** (`decisions/d-<slug>.md`): per-decision frontmatter is overkill for 1-3 sentence reasoning; volume math says 200+ files/year for ytsejam; glacier flow is uglier than the file-per-domain version.
- **Rolled-up `projects/decisions.md`:** loses per-project locality.

### 3. Trigger: B — two mechanical sub-triggers, OR'd

A decision write fires when EITHER:

**B1 (linguistic tell — in-conversation):** The agent's response contains language stating a chosen direction in the *recommendation* of a turn:
- "we chose X over Y because..."
- "supersedes..."
- "going with X" (in a verdict, not an exploration)
- Equivalent phrasings

**B2 (workflow tell — branch ship):** The `ship` skill is processing a merge whose body or commits contain a substantive architectural decision. Same hook the current wiki/decisions.md uses — kept, just retargeted.

Both triggers are independent. Either alone is sufficient.

**Obligation when B1 fires:** write the decision in the **same turn** the call crystallizes. Not "remember later" — same turn, one `cog_append`, before moving on. This is the cog discipline rule that must land in `cog-meta/patterns.md`.

**Obligation when B2 fires:** ship skill appends to `projects/<slug>/decisions.md` (was: `wiki/projects/<slug>/decisions.md`). One-line skill change.

Rejected alternatives:
- **A (vague "architectural call" phrase):** judgment words rot; six months from now no one will know what counts.
- **C (every recommendation-with-tradeoffs writes a decision):** way too noisy — every brainstorm turn would write.

**Deferred:** an explicit `/decision` skill as an escalation path if B1 under-fires in practice. Keep as option, don't ship in v1.

### 4. Retrieval: R1 + R2, defer R3

**R1 — L0 index inclusion (ship in v1):** `decisions.md` carries a standard L0 summary line (`<!-- L0: decisions for <domain> -->`). Picked up by `cog_rpc("l0index", {domain})` like any other domain file. Zero cost, zero new mechanism.

**R2 — Domain skill loads it (ship in v1):** Each domain skill reads `projects/<slug>/decisions.md` on activation and surfaces most-recent-N entries in routing context, alongside `## Hot Memory`. New `## Recent Decisions` section in the routing block.

Cap: most-recent-20 entries, plus any entry referenced by `supersedes:` from one of the recent 20 (so the chain is followable in-context). If the file grows past that, full retrieval falls through to L1 outline + L2 section read — same pattern as long observations files.

**R3 — Supersedes-check on write (deferred):** when B1 fires, the cog skill greps existing decisions.md for related decisions before the write, forcing "is this a fresh call or am I overturning d-X?" to be answered. Speculative — defer until R1+R2 are running and we see whether `supersedes:` stays empty when it shouldn't.

Cost check: ytsejam's existing ~60 entries are ~600 lines, ~5-8K tokens uncompressed. Truncated to most-recent-20: ~1.5-2K tokens. Acceptable for the project that IS the substrate; smaller domains will stay smaller naturally.

### 5. Lifecycle: Live + Superseded + Archived. Defer Stale + Rescinded

**Live (ship in v1):** default state. No marker.

**Superseded (ship in v1):** newer decision points back via `<!-- supersedes: d-old -->`. When the new entry is written, the old entry gets a paired `<!-- superseded-by: d-new -->` HTML comment appended. Two-way link, both files.

**Archived (ship in v1):** glacier-rules same shape as observations.md. When `decisions.md` crosses **100 entries** OR head entry is older than **6 months**, the housekeeping skill moves oldest entries that are EITHER superseded OR older than the cutoff to `glacier/{domain-path}/decisions-YYYY-MM.md` with standard YAML frontmatter (type: decisions, domain, tags, date_range, entries, summary). **Live, non-superseded decisions never glacier regardless of age.**

**Stale (deferred):** the Sync-staleness-primitive lift is on its own design thread. When that lands, it stamps `<!-- stale-since-commit: <sha> -->` on file frontmatter generically; decisions get the behavior for free.

**Rescinded (deferred):** too rare to design upfront. Model retroactively as "superseded by a no-policy decision" if it happens. Earn first-class status by recurring.

Threshold guesses (100 entries / 6 months) are first-cut — adjust on first signal.

## Implementation (cog updates only — no production code)

Two skill-source roots in this repo:
- `server/skills/<name>.md` — flat single-file skills (cog, housekeeping, reflect, history, evolve, foresight, create-gate)
- `contrib/skills/<name>/SKILL.md` — dir-bundle skills (ship, brainstorm, develop, write-plan, ponytail, etc.)

The deployed copies live at `~/.ytsejam/data/skills/`; the seeds here are canon.

1. **`cog-meta/patterns.md` (cog memory, not in this repo)** — add a `## Decisions` section (~5 lines): trigger language (B1 + B2), same-turn obligation when B1 fires, the entry format. This is a cog file edit and ships *with* the PR via a documented post-merge step, but lives outside the repo.

2. **System-prompt memory rules (in `server/src/agent/system-prompt.ts` or wherever the rules table is built)** — add `decisions.md` as kind #7 with its file pattern (append new, optional supersedes-pair stamp on cited entry). This is the only "code" change in the PR.

3. **`server/skills/cog.md`** — update the starter-file generation so any new domain created by `/cog` includes a stub `decisions.md` with just the L0 line. Existing domains get retroactive stubs via the migration script.

4. **Generated domain-skill template** (in `cog` skill — `server/skills/cog.md` or the script it dispatches) — add `## Recent Decisions` section to the generated per-domain skill markdown, populated by `cog_read` of `{domain-path}/decisions.md` with most-recent-20.

5. **`contrib/skills/ship/SKILL.md`** — retarget the decisions hook from `cog wiki wiki/projects/<slug>/decisions.md` to `projects/<slug>/decisions.md` (per `norma-port` ship-skill description).

6. **`server/skills/housekeeping.md`** — add decisions.md to the glacier rotation logic with the 100-entry / 6-month thresholds; live-non-superseded entries never glacier.

7. **Migration script** (`scripts/migrate-decisions.ts` or a one-shot in `scripts/`) — move existing `wiki/projects/ytsejam/decisions.md` entries into `projects/ytsejam/decisions.md`; assign slug-ids from first 5 significant words kebab-cased; preserve dates and origins. After migration, the wiki file becomes a 1-line redirect or is deleted.

8. **Stub `decisions.md` files** — create empty stubs with just the L0 line in `infra/`, `personal/`, `pkb/`, `work/`, `projects/truenas-mcp/`, `projects/intuneme/` so the L0 scan picks them up immediately. (`projects/ytsejam/decisions.md` is created by the migration in step 7.)

## Acceptance criteria

- `projects/ytsejam/decisions.md` exists in cog memory (`~/.ytsejam/data/memory/projects/ytsejam/decisions.md`), populated with the migrated entries.
- `wiki/projects/ytsejam/decisions.md` is gone or 1-line redirect.
- `cog_rpc("l0index", {"domain": "ytsejam"})` returns decisions.md in its file list.
- The generated ytsejam domain skill's playbook contains a `## Recent Decisions` section.
- `cog-meta/patterns.md` contains the trigger rule (post-merge step).
- `contrib/skills/ship/SKILL.md` writes to `projects/<slug>/decisions.md`.
- `server/skills/housekeeping.md` knows about decisions.md and its thresholds.
- All gates pass: `bash scripts/gate.sh` exit 0.
- One full week passes with the new system and at least 3 decisions are written via B1 (the in-conversation trigger). [Soft criterion — observed in subsequent week, not in this PR.]

## Open questions for implementation

- **Slug-id collisions across domains:** `d-frontmatter-parser` could exist in both ytsejam and chapterhouse. **Recommendation: domain-scoped.** Cross-domain `supersedes` is rare; when it happens, use full path: `supersedes: ytsejam/d-frontmatter-parser`.
- **Whether existing 60 wiki entries get assigned slugs in bulk or migrated as-is with auto-generated slugs.** **Recommendation: auto-generate from first 5 significant words, kebab-cased.** Worth ~2 minutes of script; tighter ids than human-chosen ones at this volume.
- **The L0 summary line text** — generic ("decisions for ytsejam") or richer ("N decisions, latest YYYY-MM-DD")? **Recommendation: generic for v1**; the richer form is a script artifact that drifts unless auto-maintained.

## What I'd most expect to be wrong

- **B1 over-fires on brainstorm turns** where the agent is proposing a decision rather than recording one. Mitigation in trigger language ("recommendation of a turn, not the exploration") — but soft. Will see in week one.
- **100-entry / 6-month glacier thresholds are guesses.** Adjust on first signal.
- **R2 token cost compounds across domains.** If every domain skill loads its decisions, the routing context grows. Mitigation: only the active domain skill loads (which is already how hot-memory works).
- **Migration script slug collisions** within ytsejam: the auto-generator might produce two identical slugs for two different decisions. Mitigation: append `-2`, `-3` on collision in slug-generation.

## Out of scope

- Question kind (deferred — needs to earn felt-pain story)
- Stale-decision marking via git-cursor (own design thread, on tomorrow's resurface)
- Explicit `/decision` skill (deferred — option if B1 under-fires)
- Cross-domain decision indexing (rare, defer)
- A web UI surface for decisions (no demand)

## Post-merge runbook

After this PR merges and the new release deploys, the maintainer (Brian) runs these steps to land the kind in live memory:

1. **Update domains.yml** — Add `decisions` to the `files:` list of each non-system domain you want decision-tracking on. Edit `~/.ytsejam/data/memory/domains.yml` directly, OR re-run `/cog` which regenerates the manifest from the updated cog skill defaults. Minimum set: `projects/ytsejam`. Recommended: all `projects/*`, `infra`, plus `personal` if you want personal decisions tracked.

2. **Run migration on ytsejam:**
   ```sh
   cd ~/projects/ytsejam
   npx tsx scripts/migrate-decisions.ts --root ~/.ytsejam/data/memory --domain projects/ytsejam
   ```
   This reads `~/.ytsejam/data/memory/wiki/projects/ytsejam/decisions.md` and writes `~/.ytsejam/data/memory/projects/ytsejam/decisions.md` with the new format. The script REFUSES to overwrite an existing destination — if `decisions.md` was scaffolded empty by `/cog` in step 1, delete it first OR pass `--force`.

3. **Retire the wiki copy:**
   ```sh
   echo "Moved to [[projects/ytsejam/decisions]]." > ~/.ytsejam/data/memory/wiki/projects/ytsejam/decisions.md
   ```
   (Or delete it — the redirect form is nicer for any stale link.)

4. **(Optional) Migrate the chapterhouse decisions to glacier** (chapterhouse is already archived):
   ```sh
   npx tsx scripts/migrate-decisions.ts --root ~/.ytsejam/data/memory --domain glacier/projects/chapterhouse
   ```
   Then delete `~/.ytsejam/data/memory/wiki/projects/chapterhouse/decisions.md`.

5. **Create stub decisions.md files for other domains** (where step 1 added `decisions` to the manifest):
   ```sh
   for d in infra personal pkb work projects/truenas-mcp projects/intuneme; do
     [ -d ~/.ytsejam/data/memory/$d ] && [ ! -f ~/.ytsejam/data/memory/$d/decisions.md ] && \
       printf '<!-- L0: Decisions for %s -->\n# %s — Decisions\n' "$d" "$d" > ~/.ytsejam/data/memory/$d/decisions.md
   done
   ```
   (Or use the cog `init_canonical_file` RPC via the agent — it routes to the new typed template added in Task 1.)

6. **Append the trigger discipline to `cog-meta/patterns.md`** — the entry-format rules are already in `COG_CONVENTIONS` (rule #9, see `server/src/cog/brief.ts`) and load every session. But the operational triggers (WHEN to write a decision) are not auto-loaded; copy-paste this verbatim under a new `## Decisions` section of `~/.ytsejam/data/memory/cog-meta/patterns.md`:

   ```markdown
   ## Decisions

   Decision-write triggers (OR'd, mechanical — write the decision in the SAME TURN, not "remember later"):
   - **B1 linguistic tell** in the *recommendation* of a turn: "chose X over Y", "supersedes", "going with X" (verdict, not exploration). When B1 fires, cog_append the entry to `<active-domain>/decisions.md`.
   - **B2 workflow tell**: ship skill processes a merge with an architectural decision in the body/commits — the ship skill itself files via `cog_append` per `contrib/skills/ship/SKILL.md`.

   Entry format and edit patterns are in COG_CONVENTIONS rule #9 (auto-loaded).
   ```

7. **Verify L0 scan picks up the new files:**
   ```
   cog_rpc("l0index", {"domain": "ytsejam"})
   ```
   Should include `projects/ytsejam/decisions.md` in the list.

8. **Optional: regenerate the ytsejam domain skill** by re-running `/cog`. The updated skill template (Task 5) adds the `decisions` retrieval bullet and the entry-append behavior bullet, so the next session's domain-skill activation will load decisions.md into context.

### Rollback

If anything goes wrong post-merge:
- The PR change set is reversible — `git revert <merge-commit>` puts the code back to pre-decisions-kind state. The data files written in steps 2-6 are not deleted by the revert; they're just unread.
- To also remove the data side: `rm ~/.ytsejam/data/memory/projects/ytsejam/decisions.md` and any stubs from step 5, and edit `domains.yml` to remove `decisions` from `files:` lists.
- The old `wiki/projects/ytsejam/decisions.md` is still present (step 3 wrote a redirect, didn't delete) unless you `rm`'d it manually.
