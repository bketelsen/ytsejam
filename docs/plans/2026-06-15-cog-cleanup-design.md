# Cog cleanup — `/cog` skill and daemon contract coherence

**Status:** design, awaiting plan
**Scope:** [#200](https://github.com/bketelsen/ytsejam/issues/200), [#201](https://github.com/bketelsen/ytsejam/issues/201), [#202](https://github.com/bketelsen/ytsejam/issues/202), [#203](https://github.com/bketelsen/ytsejam/issues/203), [#206](https://github.com/bketelsen/ytsejam/issues/206)
**Out of scope:** [#205](https://github.com/bketelsen/ytsejam/issues/205) (cog_append response shape) — standalone daemon fix, not part of this cleanup. [#204](https://github.com/bketelsen/ytsejam/issues/204) is handled separately by normalizing `cog_rpc` `domain` params to accept id or path.
**Author:** Mentat (with Brian, 2026-06-15)

## Problem

The `/cog` skill and the cog daemon's write-side guards have drifted. The skill instructs the agent to perform operations the daemon refuses, and the daemon's failure modes hide root causes from the agent that would let it recover.

One `/cog` run for a new subdomain surfaced seven distinct friction points in under five minutes. Five of them are the same shape: *skill says X, daemon does Y*. The other two were standalone daemon bugs: #204 is fixed separately by normalizing `domain` id/path handling, while #205 remains deferred.

Concretely:

- `cog_write` refuses every canonical memory filename (`hot-memory.md`, `observations.md`, `action-items.md`, `dev-log.md`, `entities.md`, etc.) — but the `/cog` skill text says "create the missing ones with `cog_write`" (#200).
- The `cog_append` validator rejects an L0 header line on observations files — and there is no `cog_*` tool that legitimately writes the header to a brand-new observations file, forcing a backwards bootstrap (append entries first, then `cog_patch` the header in above) (#201).
- Manifest write-validation is blind: `cog_write("domains.yml", ...)` returns `{bytes: N}` even when the resulting content fails to validate at next load. The error surfaces on a later, unrelated RPC as `domain: unknown id "X"` — the agent has to deduce that an unknown-domain error means its earlier write was rejected (#202).
- The manifest validator is strict at load-time but absent at write-time; pre-existing on-disk manifests with duplicate ids are grandfathered into the load path but rejected on the next re-render (#203).
- The skill says to write the routing-skill file with the agent's `write` tool to an undocumented path under the data directory; the agent has to discover the path by `ls` and reverse-engineer the frontmatter shape from a peer file (#206).

These are all the same root cause: the daemon's contract evolved (guards were tightened, validators were added) but the `/cog` skill was never re-grounded against the new contract. The cleanup makes the daemon expose the primitives the skill needs to do its job correctly, and rewrites the skill to use them.

## Scope and non-goals

**In scope:**
- Two new `cog_rpc` methods that let the skill do what it needs to do without the agent writing raw files outside the cog tool surface.
- Two daemon-side hardening changes that prevent invalid manifests from silently landing and that surface manifest load errors when subsequent routing RPCs fail.
- A `/cog` skill rewrite that uses the new RPCs and dedupes legacy grandfathered manifests on the agent's behalf.

**Explicitly out of scope:**
- #204 (`cog_rpc` `domain:` param accepts id at some methods, path at others) is fixed outside this cleanup by making domain-scoped RPCs accept either a registered domain id or path.
- #205 (`cog_append` response shape uninformative). Standalone daemon response shape bug.
- Moving the routing-skill directory into the cog memory root. Bigger architectural shift; the skills directory is consumed by the harness's skill loader, not the memory store, and changing that path is a separate brainstorm.
- A unified atomic `domain_create` RPC that does manifest + files + skill in one call. Considered (Q2 Option 3); rejected as too coupled — `/cog`'s conversational shape (Phase 1 discovery, Phase 2 confirm) benefits from the skill orchestrating multiple calls, not handing one opaque envelope to the daemon.

## Architecture

Two new daemon primitives, two daemon hardening changes, one skill rewrite. The seam is clean: the daemon owns *what a canonical artifact looks like* (header shape, frontmatter shape, path resolution) and the skill orchestrates *when* to create one.

### Primitive 1: `cog_rpc("init_canonical_file", ...)` (Q2, Q3)

Creates a canonical memory file with the standard L0 header and any file-type-specific structural lines. Refuses if the file already exists (no clobbering of history). Refuses if the path isn't under a registered domain. Refuses if the basename doesn't match the slug rule.

**Signature (TypeScript):**

```ts
interface InitCanonicalFileParams {
  path: string;                 // memory-relative, e.g. "projects/intuneme/observations.md"
  file_type:                    // template selector
    | "hot-memory"
    | "observations"
    | "action-items"
    | "dev-log"
    | "generic";
  label: string;                // human-readable domain label, used in the title line
}

interface InitCanonicalFileResult {
  created: boolean;             // true if file was created; false if it already existed
  path: string;                 // echoed
  bytes: number;                // bytes written (0 if not created)
}
```

**Validation rules (Q3 Option B'):**
1. Path must resolve under a registered `domain.path` from `domains.yml`. Refuses with `init_canonical_file: path "X" not under any registered domain`.
2. Basename (stem, without `.md`) must match `^[a-z][a-z0-9-]*$`. Refuses with `init_canonical_file: basename "X" must match [a-z][a-z0-9-]*`.
3. If file exists, return `{created: false, path, bytes: 0}` (idempotent, not an error — calling skills can probe-then-create).
4. If `file_type` is unrecognized, default to `generic`.

**Templates:**

`hot-memory`:
```
<!-- L0: Current state and top-of-mind for {label} -->
# {label} — Hot Memory

<!-- Rewrite freely. Keep under 50 lines. -->
```

`observations`:
```
<!-- L0: Timestamped observations and events for {label} -->
# {label} — Observations

<!-- Append-only. Format: - YYYY-MM-DD [tags]: observation -->
```

`action-items`:
```
<!-- L0: Open and completed tasks for {label} -->
# {label} — Action Items

## Open

## Completed
```

`dev-log`:
```
<!-- L0: Development log and architectural decisions for {label} -->
# {label} — Dev Log

<!-- Append entries with date headers. Use for ADR-style decisions, design notes, and post-mortems. -->
```

`generic` (fallback for `entities`, `architecture`, `habits`, `health`, `calendar`, `projects`, `patterns`, etc.):
```
<!-- L0: {basename-title-cased} for {label} -->
# {label} — {basename-title-cased}
```

Where `basename-title-cased` capitalizes each `-`-separated segment (`hot-memory` → `Hot Memory`).

**Why not extend `cog_write` instead (Q2 Option 2):** The daemon would lose its opinion about L0 header shape. The L0 header is a daemon contract (the indexer consumes it); the daemon should own its format. Loosening `cog_write` relocates the drift instead of fixing it.

**Why not one unified `domain_create` RPC (Q2 Option 3):** Forces atomicity at the wrong layer. `/cog`'s discovery phase is conversational; the skill needs to call multiple primitives between user messages. A single opaque RPC would either swallow that conversation or require multiple specialized variants — same surface area, less composable.

### Primitive 2: `cog_rpc("skill_write", ...)` (Q6)

Writes the routing-skill markdown file with the canonical YAML frontmatter. Owns path resolution (`<dataDir>/skills/<id>.md`), frontmatter shape, and the slug-id validation. Overwrite-safe (skill template is the source of truth on every `/cog` run).

**Signature:**

```ts
interface SkillWriteParams {
  id: string;                   // skill id, used as filename and frontmatter `name`
  description: string;          // frontmatter `description` line
  triggers: string[];           // frontmatter `triggers` array
  body: string;                 // markdown body (everything after the frontmatter)
}

interface SkillWriteResult {
  path: string;                 // absolute path written
  bytes: number;
}
```

**Validation:**
1. `id` must match `^[a-z][a-z0-9-]*$`. Refuses with `skill_write: id "X" must match [a-z][a-z0-9-]*`.
2. `triggers` must be non-empty.
3. Path resolution: `${process.env.YTSEJAM_DATA_DIR ?? path.join(homedir(), ".ytsejam/data")}/skills/${id}.md`.
4. Writes frontmatter + body atomically.

**Frontmatter shape (emitted):**

```yaml
---
name: {id}
description: {description}
triggers: [{trigger1}, {trigger2}, ...]
---

{body}
```

**Why a second new tool instead of folding into `init_canonical_file` (Q6 Option 2):** Conflates two different responsibilities. Canonical memory files are about memory; routing-skill files are about prompt-system routing. They live in different directories for a reason. One tool per obvious purpose is cheaper to learn than one tool with a hidden dual purpose.

**Why RPC instead of top-level `cog_*` tool (Q7 Option 2):** Both new operations are called by specific skills at specific moments, not by every-turn agent reasoning. The existing `cog_rpc` surface already houses this class of operation (`domain_summary`, `housekeeping_scan`, `link_audit`, `entity_audit`). Top-level tool surface costs tokens on every turn forever; RPC surface costs zero per-turn tokens.

### Hardening 1: Validate `domains.yml` on write (Q4 Option 1)

Today `cog_write("domains.yml", ...)` writes atomically without running `loadManifest` on the proposed content. An invalid manifest lands on disk and the next load fails — by which time the writing agent is gone.

`store/write.ts` gets a special case: when the target path is `domains.yml`, parse the proposed content through `loadManifest`'s normalization pipeline BEFORE the atomic write. If validation fails, throw the same error message that `loadManifest` would throw at load-time, and skip the write entirely.

**Pseudocode:**

```ts
// in store/write.ts
export async function write(path: string, content: string): Promise<WriteResult> {
  const { abs, rel } = await resolveMemoryPath(path);
  await validateWholeFileWritePath(rel);
  if (rel === "domains.yml") {
    // Throws on parse error or normalization failure; same error string as load-time
    validateManifestContent(content);
  }
  await atomicWrite(abs, content);
  await maybeAutoCommit();
  return { bytes: Buffer.byteLength(content) };
}
```

Where `validateManifestContent` is `loadManifest`'s body extracted from filesystem I/O — same normalization logic, applied to in-memory content.

**Side effect:** any `cog_write` to `domains.yml` that would have previously succeeded silently and broken the next load now fails inline with the precise validation error. The caller can correct and retry.

### Hardening 2: Surface manifest load errors through routing RPCs (Q4 Option 3)

Today when the manifest fails to load, the daemon throws inside the load path. Routing RPCs that depend on the controller (`domain_summary`, `domains.get`, etc.) then return `domain: unknown id "X"` because the in-memory routing state is empty (or stale). The agent has no signal that the underlying problem is manifest invalidity.

The daemon's domain controller will cache the last load error (if any) alongside the parsed domain list. Every routing RPC that fails with an unknown-id error includes the cached error in its message:

**Before:**
```
domain: unknown id "intuneme"
```

**After (when a recent load failed):**
```
domain: unknown id "intuneme" (last manifest load failed: duplicate domain id "ytsejam")
```

When the manifest loads cleanly, the error stays in today's shape — no clutter for the normal case.

**Implementation seam:** `domain/controller.ts` exposes `lastLoadError(): string | null`; `consolidated/domain-summary.ts`, `consolidated/l0index.ts`, and any other routing consumer wraps its unknown-id error with the cached message when present.

### Skill rewrite (Q1, Q5)

`/cog` (file: `~/.ytsejam/data/skills/cog.md`) is rewritten to:

1. **Drop the `cog_write canonical files` instruction.** Replaced with `cog_rpc("init_canonical_file", {path, file_type, label})` per file declared in the domain's `files` list. The skill walks the `files` list; for each one, calls the RPC with the appropriate `file_type` (the 4 typed names or `generic`).

2. **Drop the "use the local `write` tool" instruction for routing skills.** Replaced with `cog_rpc("skill_write", {id, description, triggers, body})`. The skill builds `body` from the existing template (the long markdown block) and hands it to the daemon.

3. **Add Phase 0.5: dedupe legacy manifests.** Between Phase 0 (orientation) and Phase 1 (discovery), the skill walks the parsed manifest (from `cog_rpc("domains.list")`) and detects ids that appear as both a `projects.subdomains` entry AND a top-level entry. The skill drops the top-level duplicate (keeps the subdomain entry — Q5 subdomain-preference rule). This dedupe is done in the skill's in-memory representation; the deduped manifest is what gets written in Phase 3. The Phase 4 summary line reports the dedupes ("cleaned up 2 legacy duplicate entries: ytsejam, truenas-mcp") so the user has visibility.

4. **Remove path discovery for the skills directory.** The skill no longer mentions `~/.ytsejam/data/skills/` — the daemon owns that path now.

5. **Update Phase 3 verbiage** to reflect that the new RPCs are the canonical bootstrap mechanism. Reference the RPC method names; don't re-document their signatures (those live in the daemon-side prompt or are discoverable via the RPC enumeration).

The skill's overall conversational shape (Phase 0 orientation → Phase 1 discovery → Phase 2 confirm → Phase 3 generate → Phase 4 summary) is preserved. Only the mechanism inside Phase 3 changes.

## Data flow

A first-time `/cog` run for a new subdomain `intuneme` under the existing `projects` parent now looks like:

```
agent: /cog
skill: cog_rpc("session_brief")
  → returns non-empty domains: this is a re-run
skill: cog_rpc("domains.list")
  → returns parsed manifest
skill: <internal: detect dupes, none found in this case>
skill: <conversation: discovery + confirmation with user>
skill: cog_write("domains.yml", <re-rendered manifest with intuneme added>)
  → daemon validate-on-write passes, file lands
skill: cog_rpc("domain_summary", {domain: "intuneme"})
  → returns files_present: [] (none yet)
skill: cog_rpc("init_canonical_file", {path: "projects/intuneme/hot-memory.md", file_type: "hot-memory", label: "intuneme"})
  → {created: true, bytes: 132}
skill: cog_rpc("init_canonical_file", {path: "projects/intuneme/observations.md", file_type: "observations", label: "intuneme"})
  → {created: true, bytes: 124}
skill: cog_rpc("init_canonical_file", {path: "projects/intuneme/action-items.md", file_type: "action-items", label: "intuneme"})
  → {created: true, bytes: 91}
skill: cog_rpc("init_canonical_file", {path: "projects/intuneme/dev-log.md", file_type: "dev-log", label: "intuneme"})
  → {created: true, bytes: 138}
skill: cog_rpc("skill_write", {id: "intuneme", description: "...", triggers: ["intune", "intuneme"], body: "..."})
  → {path: "/home/bjk/.ytsejam/data/skills/intuneme.md", bytes: 2141}
skill: <Phase 4 summary to user>
```

Compare to the friction-laden current flow which had ~12 failed-and-retried tool calls.

## Error handling

**Daemon-side:**
- `init_canonical_file` returns `{created: false, ...}` (not an error) when the file already exists — lets the skill probe-then-create without try/catch.
- `init_canonical_file` rejects with a precise error message when the path or basename is invalid.
- `skill_write` rejects with a precise error message when the id slug is invalid or triggers is empty.
- `cog_write("domains.yml", ...)` now rejects with the manifest validation error before any state change.
- Routing RPC unknown-id errors carry the cached last-load error when one is present.

**Skill-side:**
- `/cog` checks the result of each `init_canonical_file` call. If `created: false` and the file content doesn't already match the expected template, the skill warns the user but proceeds (existing files are never clobbered).
- If `cog_write("domains.yml", ...)` rejects mid-Phase-3, the skill surfaces the validation error to the user and aborts. The user can re-run `/cog` after fixing the conflicting state.

## Testing

**PR-1 (RPCs):**
- `init_canonical_file` creates each of the 5 file_type variants with correct templates (5 tests).
- `init_canonical_file` is idempotent on existing files (returns `created: false`, doesn't overwrite).
- `init_canonical_file` refuses paths outside any registered domain (1 test).
- `init_canonical_file` refuses basenames violating the slug rule (3 typos: underscore, capital, space).
- `init_canonical_file` defaults to `generic` for unknown file_type (1 test).
- `skill_write` writes a correct frontmatter + body atomically (1 test).
- `skill_write` refuses id slug violations (3 typos).
- `skill_write` refuses empty triggers (1 test).
- `skill_write` resolves path via `YTSEJAM_DATA_DIR` env override (1 test).

**PR-2 (manifest hardening):**
- `cog_write` to `domains.yml` rejects a manifest with duplicate ids (1 test).
- `cog_write` to `domains.yml` rejects a manifest missing required fields (1 test).
- `cog_write` to `domains.yml` accepts a valid manifest (1 test, regression guard).
- Routing RPC after invalid-manifest-load includes the cached error in the unknown-id message (1 test).
- Routing RPC after clean-manifest-load returns the bare unknown-id message (1 test, regression guard).

**PR-3 (skill rewrite):**
- Skill rewrite is markdown-only. Hand-verification by re-running `/cog` on the live system to add a throwaway test domain, then `/cog` again to remove it.
- End-to-end smoke: bootstrap a new subdomain in a clean memory dir, verify all 4 canonical files exist with correct headers, verify the routing skill exists with correct frontmatter, verify the L0 indexer can read all the headers.
- Dedupe test: take a legacy manifest with duplicate ids, run `/cog`, verify the on-disk manifest has only the subdomain entries (top-level dupes dropped) and that routing still resolves.

## Implementation sequence (Q8 Option 3)

Three PRs:

1. **PR-1 (daemon, additive): `init_canonical_file` + `skill_write` RPCs.**
   - Files: `server/src/memory/consolidated/init-canonical-file.ts` (new), `server/src/memory/consolidated/skill-write.ts` (new), `server/src/memory/consolidated/index.ts` (wire), `server/src/memory/types.ts` (param/result types), tests under `server/test/memory/consolidated/`.
   - No closure: pure infrastructure for PR-3.
   - PR body: "Infrastructure for #200, #201, #206 — closed by skill rewrite in follow-up PR."

2. **PR-2 (daemon, tightening): validate-on-write for `domains.yml` + routing error surface.**
   - Files: `server/src/memory/store/write.ts` (validate hook), `server/src/memory/domain/manifest.ts` (export `validateManifestContent`), `server/src/memory/domain/controller.ts` (cache last load error, expose `lastLoadError()`), `server/src/memory/consolidated/domain-summary.ts` + `consolidated/l0index.ts` + any other unknown-id throwers (wrap error). Tests added.
   - Closes #202, #203.

3. **PR-3 (skill): `/cog` rewrite.**
   - Files: `server/skills/cog.md` (canonical seed in the repo) — this is the source-of-truth edit. The seed is copied to `~/.ytsejam/data/skills/cog.md` at first boot via `SkillsStore.seed()` (COPYFILE_EXCL, copy-if-missing only). `deploy/deploy.sh` runs `scripts/check-skills-drift.sh` between build and symlink-swap to catch seed-vs-live drift; activating a seed edit on a running instance requires `bash deploy/sync-skills.sh --yes`. The earlier claim that `cog.md` was runtime-only was wrong — verified `server/skills/cog.md` exists and is the SSOT.
   - Closes #200, #201, #206.

PR-1 and PR-2 are independent and can be drafted in parallel. PR-3 depends on both being deployed.

## Decisions log

| Q | Decision | Why |
|---|---|---|
| Q1 | New `cog_init_canonical_file`-style primitive (Option 1) | Daemon owns header shape; skill owns sequencing. Loosening `cog_write` (Option 2) would relocate drift; unified `domain_create` (Option 3) collapses conversational shape. |
| Q2 | 4 typed templates + generic fallback (Option 2 revised) | 4-only would leave skill stuck on `entities.md`, `architecture.md`, etc. (allow-list is tighter than `files` list). Generic fallback covers them without daemon opinionation. |
| Q3 | Domain-path containment + slug-validated basename (Option B') | A' (loose) leaves typo footguns; C' (with `files`-list check) over-couples to `files` and breaks `/reflect`'s lazy `patterns.md` creation. B' is the minimum rule that catches typos. |
| Q4 | Validate-on-write + cached-error surface; skip self-heal (Options 1+3, skip 2) | 1 is unconditional good; 3 cheap and pays back beyond our specific scenario; 2 is band-aid for a one-time data fix handled by Q5. |
| Q5 | Skill dedupes silently with subdomain preference (Option A) | Duplicates are skill-emitted artifacts, never user-authored choices. Confirm-prompt (B) is theater; abort-and-direct (C) is hostile. |
| Q6 | New `cog_skill_write` RPC, separate from `init_canonical_file` (Option 1) | Conflating memory and routing-skill responsibilities under one tool buys symmetry not worth the loss of obvious purpose. |
| Q7 | Both new operations as `cog_rpc` methods (Option 2) | Structural/admin operations already live in `cog_rpc` (`domain_summary`, `housekeeping_scan`, etc.). Top-level tools cost tokens forever; RPC methods cost nothing per turn. |
| Q8 | Three PRs: RPCs (additive), manifest hardening (tightening), skill rewrite (Option 3) | Five PRs (Option 1) over-fragments; two PRs (Option 2) bundles too many distinct daemon changes for clean review. Three PRs slice along the natural thematic seam. |
| Q9b | Decision-focused doc (Option A) | This cleanup exists because past reasoning was lost. Modeling the fix means writing the doc that preserves *why*, not just *what*. |

## Open questions for write-plan / develop

1. **Where does the canonical `cog.md` skill source live for SSOT (PR-3)?** Verify whether `contrib/skills/cog/SKILL.md` exists or whether `cog.md` is runtime-only. If repo source exists, both must be edited.
2. **Should `init_canonical_file` accept a `domains_yml_path` override for testing?** Most tests will set `YTSEJAM_MEMORY_DIR` to a tmp dir, which already isolates the domain manifest. Probably no override needed; flag if tests get awkward.
3. **`skill_write` overwrite policy.** Today the skill template IS the source of truth on every `/cog` run, so overwrite is correct. But a hand-customized routing-skill file would be silently clobbered. Probably fine — if a user hand-edits a routing skill, the next `/cog` run will tell them in Phase 4 that the skill was regenerated. Worth a one-line warning in the Phase 4 summary when the skill_write replaced existing content.
