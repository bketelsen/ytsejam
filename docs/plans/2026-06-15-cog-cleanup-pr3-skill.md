# PR-3: `/cog` skill rewrite — use the new RPCs

> Execute with the `develop` skill, task-by-task.

**Goal:** Rewrite the `/cog` skill to use the new `init_canonical_file` and `skill_write` RPCs (from PR-1), drop the instructions that the daemon refuses (file-by-file `cog_write` of canonical files; agent's `write` tool for routing skills), and add a Phase 0.5 dedupe step for legacy manifests with duplicate ids.

**Spec:** `docs/plans/2026-06-15-cog-cleanup-design.md` (section "Skill rewrite")

**Architecture:** Single-file edit to `server/skills/cog.md` (the canonical seed in the repo). Skill is markdown; no code change. The seed is propagated to `~/.ytsejam/data/skills/cog.md` via `SkillsStore.seed()` at boot (COPYFILE_EXCL) or via `bash deploy/sync-skills.sh --yes` for live activation. `scripts/check-skills-drift.sh` catches seed-vs-live drift at deploy time.

**Tech Stack:** Markdown only. Shell-side validation: `scripts/check-skills-drift.sh` + a smoke run of `/cog` post-merge.

**Worktree:** `/tmp/cog-cleanup-skill`

**Branch:** `feat/cog-cleanup-skill`

**Dependencies:** PR-1 (`init_canonical_file` + `skill_write` RPCs) MUST be merged to `main` and live in production BEFORE this PR is merged. PR-2 (manifest validate-on-write) is independent — it doesn't block this PR but its `validate-on-write` rejection improves the failure mode of bad `domains.yml` writes the skill emits.

**Closure:** Closes #200 (canonical-file `cog_write` instruction broken), #201 (no header bootstrap for observations.md), #206 (skill-file write path undocumented and external to cog).

---

## Baseline

Recorded before any task: `bash scripts/gate.sh` PASSES (server tests 158/158, web tests 158/158, lint + typecheck clean). Recorded from this worktree at 2026-06-15 against base commit `cc37e44` (`docs: correct PR-3 edit target — cog.md is seeded from server/skills/, not runtime-only`).

Every task ends with a gate re-run; "no regressions" means against this baseline. The drift-gate test (`scripts/test/check-skills-drift.test.sh`) is part of the gate and verifies the seed-vs-live tooling itself; the actual seed-vs-live runtime drift check (`scripts/check-skills-drift.sh`) only runs at deploy time.

---

## Pre-task: Read the design doc cross-reference

Before writing any code, the implementer must open and re-read these sections of `docs/plans/2026-06-15-cog-cleanup-design.md`:
- "Skill rewrite (Q1, Q5)" — enumerates the 5 changes
- "Data flow" — the worked example of a new `intuneme` subdomain run
- "Primitive 1: `cog_rpc(\"init_canonical_file\", ...)`" — for the 5 template names and validation rules
- "Primitive 2: `cog_rpc(\"skill_write\", ...)`" — for frontmatter shape

These are the canonical sources for any decision the implementer faces about *what* the rewritten skill should say.

---

## Task 1: Rewrite `server/skills/cog.md`

**Files:**
- Modify: `server/skills/cog.md` (the seed in the repo — the canonical SSOT for the cog skill)

### Step 1: Read the current skill in full

```bash
cat server/skills/cog.md
```

Sections to preserve (conversational shape):
- YAML frontmatter (`name`, `description`, `triggers`)
- The `# Cog Setup` intro paragraph (1 line)
- Phase 0 (orientation) — `cog_rpc("session_brief")` + re-run detection logic
- Phase 1 (discovery) — natural conversation, domain-type table
- Phase 2 (confirm) — show summary, wait for confirmation
- Phase 4 (summary) — domains/files/skills + "Just talk naturally" closer
- Rules section (1-6)

Sections to rewrite:
- **Phase 3a (write `domains.yml`)** — preserve unchanged; this still goes through `cog_write("domains.yml", ...)` and now benefits from PR-2's validate-on-write
- **Phase 3b (create starter files)** — REPLACE the file-by-file template-copying + `cog_write` instruction with a single `cog_rpc("init_canonical_file", ...)` call per file, walking the domain's `files` list and selecting the matching `file_type`. Remove the inlined templates (they live in the daemon now)
- **Phase 3c (cross-domain files)** — KEEP `cog_list` probe + `cog_write` for `link-index.md`, `glacier/index.md`, `hot-memory.md` (all in the allowlist); these are not canonical-file shape, so they don't use `init_canonical_file`
- **Phase 3d (domain skills)** — REPLACE the "use the local `write` tool to skills/{id}.md" instruction with `cog_rpc("skill_write", {id, description, triggers, body})`. The body template (the long markdown block starting `Use this skill when the conversation involves...`) is preserved; only the *mechanism* of writing the file changes

New section to add:
- **Phase 0.5 (dedupe legacy duplicates)** — between Phase 0 and Phase 1, the skill walks the parsed manifest (from `cog_rpc("domains.list")`) and detects ids that appear as both a `projects.subdomains` entry AND a top-level entry. When found, the skill drops the top-level duplicate (keeps the subdomain entry per the Q5 subdomain-preference rule). This dedupe happens in the skill's working representation of the manifest — the deduped manifest is what Phase 3a writes. The Phase 4 summary line reports the dedupes so the user has visibility.

### Step 2: Write the replacement

Replace the entire file with this content. (The implementer should consult the design doc's "Data flow" section as ground-truth for the call sequence and the "Primitive 1/Primitive 2" sections for the template names and frontmatter shape.)

````markdown
---
name: cog
description: >
  Bootstrap or reconfigure cog memory domains. Creates the domain manifest,
  starter files, and a generated skill per domain. Run for first-time setup
  or to add new domains.
triggers: [setup memory, configure domains, add domain, reconfigure memory]
---

# Cog Setup

Bootstrap the memory system through conversation. Discover the user's domains, then generate `domains.yml`, the canonical memory files for each domain, and a routing skill per domain. The memory root is owned by the cog daemon — all memory writes go through `cog_*` tools and `cog_rpc` methods.

## Phase 0: Orientation

Call `cog_rpc("session_brief")`.

- **`domains` is empty** → first-time setup; continue to Phase 0.5.
- **`domains` is non-empty** → this is a re-run. Show the current domain table (id, path, label) and ask: "Want to add more domains or reconfigure an existing one?" Only touch what the user asks for. Fetch the full current manifest with `cog_rpc("domains.list")` before writing anything — re-renders must preserve every existing entry verbatim.

## Phase 0.5: Dedupe Legacy Duplicates (silent)

On any non-empty manifest, walk `domains.list` and detect ids that appear BOTH as a top-level entry AND as a subdomain (typically under `projects`). When such a duplicate is found, drop the **top-level** entry from the working manifest — the subdomain wins (it has the structured parent context and the correct path). The user is not asked; the dedupe is reported in Phase 4 ("cleaned up N legacy duplicate entries: <ids>"). When no duplicates exist, this phase is silent and adds nothing to the Phase 4 summary.

This dedupe applies only to the in-memory working manifest the skill is about to write in Phase 3a. The on-disk manifest still has the duplicates until Phase 3a re-renders.

## Phase 1: Discovery (Conversational)

Have a natural conversation to understand the user's domains. Ask about:

1. **Work** — "What do you do for work? Company name, role?" → becomes a `work` domain
2. **Side projects** — "Any side projects or ventures?" → each becomes a `side-project` subdomain under `projects`
3. **Personal** — The `personal` domain is always created. Ask: "Anything specific you want to track? Health, hobbies, habits, kids?"
4. **Anything else** — "Any other areas you want persistent memory for?"

Keep it natural. 3-4 questions max. Use their answers to build the manifest.

### Domain Types

| Type | Meaning | Files |
|------|---------|-------|
| `personal` | Personal life (always one) | hot-memory, action-items, entities, observations, habits, health, calendar |
| `work` | Day job | hot-memory, action-items, entities, projects, observations |
| `side-project` | Ventures, hobbies (subdomain under `projects`) | hot-memory, action-items, dev-log, observations |
| `system` | Cog internals (auto-created) | self-observations, patterns, improvements |

Side projects nest under a `projects` parent domain as subdomains (`id: myapp`, `path: projects/myapp`). Never declare a side project as a top-level domain — that's the duplicate shape Phase 0.5 cleans up.

## Phase 2: Confirm

Before writing, show the user a summary:

```
Here's what I'll set up:

Domains:
- personal — Family, health, day-to-day
- acme — Work at Acme Corp (Designer)
- myapp — Side project (under projects/)

This will create:
- domains.yml (domain manifest)
- Canonical memory files for each domain
- A skill per domain so future sessions route to its memory
```

If Phase 0.5 found duplicates, include in the summary: "Also cleaning up N legacy duplicate top-level entries: <ids>."

Wait for confirmation.

## Phase 3: Generate

### 3a. Write `domains.yml`

Render the complete manifest — existing entries (from `domains.list`, with the Phase 0.5 dedupe applied) preserved verbatim plus the new ones — and write it with `cog_write("domains.yml", ...)`. Always include `cog-meta` as a system domain automatically. The daemon validates the manifest before writing (rejects duplicate ids, empty paths, absolute paths) and hot-reloads on success; the new domains are live for the very next call.

```yaml
# Cog Domain Manifest — generated by /cog
# Single source of truth for all memory domains.
# To modify: run /cog again.

domains:
  - id: personal
    path: personal
    type: personal
    label: "<from conversation>"
    triggers: [<inferred keywords>]
    files: [hot-memory, action-items, entities, observations, habits, health, calendar]

  - id: cog-meta
    path: cog-meta
    type: system
    label: "Cog self-knowledge and patterns"
    triggers: [cog, meta, memory system, patterns]
    files: [self-observations, patterns, improvements]
```

If `cog_write` rejects the manifest (PR-2 validate-on-write), surface the error to the user verbatim and abort. The user can correct the prior state and re-run `/cog`.

### 3b. Create Canonical Memory Files

For each domain you created or are reconfiguring, walk its `files` list. For each file, call `cog_rpc("init_canonical_file", ...)` with the matching `file_type`:

| `files` entry | `file_type` |
|---|---|
| `hot-memory` | `"hot-memory"` |
| `observations` | `"observations"` |
| `action-items` | `"action-items"` |
| `dev-log` | `"dev-log"` |
| anything else (entities, habits, health, calendar, projects, patterns, etc.) | `"generic"` |

```
cog_rpc("init_canonical_file", {
  path: "{domain.path}/{file}.md",
  file_type: "{file_type from table}",
  label: "{domain.label}"
})
```

The daemon owns the template (L0 header + section structure). If the file already exists, the RPC returns `{created: false, path, bytes: 0}` — not an error; existing files are never clobbered. If `created: false` and the user mentioned wanting fresh content for a file, warn the user that the existing file was preserved and proceed.

### 3c. Cross-Domain Files

Check with `cog_list()`; create via `cog_write` only if missing:
- `hot-memory.md` — cross-domain strategic context (use the same template as a domain hot-memory but with cross-domain framing)
- `link-index.md` — backlink index (single line stub; rebuilt by housekeeping)
- `glacier/index.md` — glacier catalog (single line stub; rebuilt by housekeeping)

These are not canonical-file shape — they're cross-cutting indexes — so they use `cog_write` (which is in the allowlist for these specific paths) rather than `init_canonical_file`.

### 3d. Generate Domain Skills

For each non-system domain you created or reconfigured (skip `cog-meta`), call `cog_rpc("skill_write", ...)` to write its routing skill. The daemon owns the path resolution (`<dataDir>/skills/<id>.md`) and the YAML frontmatter shape; the skill provides the `id`, `description`, `triggers` array, and `body` markdown.

```
cog_rpc("skill_write", {
  id: "{domain.id}",
  description: "{domain.label} — domain memory routing",
  triggers: [{domain.triggers}],
  body: "<the markdown body — see template below>"
})
```

**Body template** (assemble the string and pass as `body`):

```markdown
Use this skill when the conversation involves: {triggers and label, expanded into natural topic phrases}.

## Domain

{label}. Memory lives at `{path}/` (always use this path with cog tools, never the id `{id}`).

## Memory Files

Always read on activation:
- cog_read("{path}/hot-memory.md")
- cog_read("{path}/patterns.md") — domain-specific patterns (loads silently if missing; created by /reflect Gate 3 when a project-specific rule is promoted)

Then load per the retrieval protocol based on the query:
- Status query → cog_read("{path}/action-items.md"){, or calendar.md if the domain has one}
- Entity query → cog_read("{path}/entities.md")
{- Health query → cog_read("{path}/health.md") — only for domains with a health file}
- Update/observation → target file only
- Complex query → hot-memory first, then drill into [[linked]] files

Available warm files: {files list from the manifest}

Historical data: cog_read("glacier/index.md"), filter by this domain.

## Behaviors

- Follow [[wiki-links]] when the linked topic is relevant
- Track people in entities.md (3-line registry, edit in place)
- Append notable events to observations.md: `- YYYY-MM-DD [tags]: <observation>`
- Add tasks to action-items.md: `- [ ] task | due:YYYY-MM-DD | pri:high/med/low | added:YYYY-MM-DD`
- Keep time-sensitive context in hot-memory.md (<50 lines, rewrite freely)
{- Log schedule changes to calendar.md / health observations to health.md — per the domain's files}

## Activation

Read hot-memory, classify the query, load the minimum files needed, and respond.
```

Tailor the trigger paragraph, retrieval bullets, and behavior bullets to the domain's actual `files` list — don't reference files the domain doesn't declare. `skill_write` overwrites on re-run: the template is the source of truth. If the user has hand-edited a routing skill, the next `/cog` run will regenerate it; mention this in Phase 4 if any `skill_write` replaced existing content.

## Phase 4: Summary

Output:
- Domains created/updated (list)
- Files generated (count, or per-domain breakdown if user is new)
- Skills generated (list)
- If Phase 0.5 deduped: "Cleaned up N legacy duplicate top-level entries: <ids>."
- If any `skill_write` overwrote a hand-edited skill: warn with the affected skill ids.
- Next steps: "Just talk naturally. Your memory system is ready."

## Rules

1. **Never delete** — setup only creates and updates
2. **Idempotent** — running again is safe; `init_canonical_file` skips existing files; domain skills regenerate
3. **cog-meta is automatic** — always included, never ask about it
4. **Conversational first** — no one edits YAML manually
5. **Re-runs are additive** — "Want to add more domains or reconfigure?"
6. **Paths, never ids** — every cog tool call targets the domain's `path`; the daemon rejects id-as-path writes
7. **Side projects are subdomains** — nest under `projects`, never declare top-level; Phase 0.5 dedupes legacy violations
````

### Step 3: Verify the drift-gate test still passes

The skill rewrite changes a file the drift-gate is responsible for. Run the drift-gate's own tests to confirm the gate logic itself is unchanged:

Run: `bash scripts/test/check-skills-drift.test.sh`
Expected: PASS — all cases (identical, live-missing, live-extra, one-drift, multiple-drifts) green. The test exercises the gate against synthetic seed/live dirs; it doesn't read the actual `server/skills/cog.md`.

### Step 4: Run the full gate

Run: `bash scripts/gate.sh`
Expected: PASS, server tests 158, web tests 158 (no test counts change — this PR doesn't add code, only rewrites a skill).

### Step 5: Commit

```bash
cd /tmp/cog-cleanup-skill
git add server/skills/cog.md
git commit -m "feat(skills): rewrite /cog to use init_canonical_file + skill_write RPCs"
```

---

## Task 2: Manual end-to-end smoke test

The skill rewrite cannot be exercised by the automated gate — `/cog` is a conversational skill that lives in the assistant's prompt context, not in unit-test reach. Verify the rewrite end-to-end by running it against a clean memory dir.

This task is intentionally manual; the implementer (or Brian) runs it before approving the PR.

### Step 1: Verify PR-1 is deployed

The rewritten skill calls `cog_rpc("init_canonical_file", ...)` and `cog_rpc("skill_write", ...)`. These RPCs ship in PR-1 and MUST be in production before the skill is exercised.

Confirm by running, in any Mentat session against the dev or prod ytsejam:

```
cog_rpc("init_canonical_file", {
  path: "personal/throwaway-test.md",
  file_type: "generic",
  label: "test"
})
```

Expected: `{created: true, path: "personal/throwaway-test.md", bytes: <N>}` (or `created: false` if the file already exists).

If the call returns `unknown cog_rpc method: init_canonical_file`, PR-1 is NOT yet live. Block this PR's merge until it is. Then clean up the throwaway file with the appropriate `cog_*` tool.

### Step 2: Synthetic clean-dir smoke

In a scratch directory:

```bash
SMOKE_DIR=$(mktemp -d)
export YTSEJAM_MEMORY_DIR="$SMOKE_DIR/memory"
export YTSEJAM_DATA_DIR="$SMOKE_DIR/data"
mkdir -p "$SMOKE_DIR/memory" "$SMOKE_DIR/data/skills"
# Start a fresh ytsejam dev server against these dirs, OR run a one-off
# script that imports the memory module and calls initCanonicalFile + skillWrite
# directly to verify the seed templates produce the expected outputs.
```

The minimum acceptance is that the templates produced by `init_canonical_file` for each of `hot-memory`, `observations`, `action-items`, `dev-log`, and `generic` match the L0-header shape the indexer expects (verify by reading the files and confirming each starts with `<!-- L0: ... -->`).

### Step 3: Live re-run on Brian's instance

The genuine end-to-end test is running `/cog` on Brian's live instance after the rewrite is deployed. Brian or the operator does this; the implementer is not responsible for it. The expected outcome:

- A fresh subdomain bootstrap that previously had ~12 failed-and-retried tool calls now completes in the call sequence shown in the design doc's "Data flow" section.
- No `cog_write` rejection on a canonical file basename.
- No `cog_append` rejection on the L0 header line of a new observations.md.
- No `ls` of `~/.ytsejam/data/skills/` to discover the path.

If any of those friction points reappear, file a follow-up issue against `bketelsen/ytsejam` referencing this PR.

### Step 4: No commit for Task 2

Task 2 is verification, not implementation. Nothing to commit.

---

## Task 3: Update the `~/.ytsejam/data/skills/cog.md` live copy

Because of `COPYFILE_EXCL`, editing `server/skills/cog.md` (the seed) does NOT update the live runtime copy. Two propagation paths:

**Path A (in this worktree before deploy):** Run `bash deploy/sync-skills.sh --yes` against the dev/prod data dir. This copies seeds → live for drifted skills.

**Path B (at deploy time):** `deploy/deploy.sh` runs `scripts/check-skills-drift.sh` between build and symlink-swap; a deploy with un-synced seeds aborts. The operator runs `sync-skills.sh` and re-deploys.

For PR-3 review purposes, the canonical edit is `server/skills/cog.md`. The live activation is a deploy-time / operator concern. The implementer does NOT manually edit `~/.ytsejam/data/skills/cog.md` — that path would create undocumented drift.

If the operator wants to activate the rewritten skill immediately after merge without a full deploy:

```bash
bash deploy/sync-skills.sh --yes
```

### Step 1: Document the activation path in the PR body

When `/ship` opens the PR, the PR body must include:

```
## Activation

This rewrites the seed at `server/skills/cog.md`. To activate on the live
instance after merge:

  bash deploy/sync-skills.sh --yes

The next `/cog` invocation will use the new flow.
```

### Step 2: No commit

This task is operator instruction, not code. The instruction lives in the PR body.

---

## Task 4: Pre-PR sweep

### Step 1: Confirm full gate green

Run: `bash scripts/gate.sh`
Expected: PASS — server tests 158, web tests 158, lint + typecheck clean (unchanged from baseline).

### Step 2: Confirm no scope creep

Run: `git diff --stat main..HEAD`
Expected: only one file touched:
- `server/skills/cog.md`

If any other file is in the diff, investigate before opening the PR.

### Step 3: Verify the rewritten skill references only RPCs that exist on `main`

Run from the worktree:

```bash
git fetch origin main
git log origin/main --oneline | head -10
```

PR-1 must be in `origin/main`. Search PR-1's commit messages for `init_canonical_file` and `skill_write` to confirm the dispatcher wiring is merged. If PR-1 is not yet in `origin/main`, BLOCK this PR's merge.

### Step 4: Verify the drift gate would NOT fail at deploy

Run:

```bash
bash scripts/check-skills-drift.sh server/skills ~/.ytsejam/data/skills 2>&1
```

Expected output: `── cog.md ──` — the gate detects the seed-vs-live drift this PR creates by design. This output is the EXPECTED state for PR review — it tells the operator to run `sync-skills.sh` after merge. The deploy-time gate will then catch any un-synced state, which is the correct safeguard.

(If the gate exits 0 — no drift — that means the live copy was already updated out-of-band, which is unusual but acceptable. Note it in the PR body.)

### Step 5: Check rebase status against origin/main

Run: `git fetch origin main && git log origin/main..HEAD --oneline`
Expected: only the commit from Task 1. If `origin/main` has advanced since the worktree was created, rebase and re-run the gate.

### Step 6: Hand back to `/ship`

The plan ends here. `/ship` handles push + PR open + merge. PR body must include:

- "Closes #200, #201, #206."
- The activation instruction from Task 3 Step 1.
- A note that PR-1 must be merged first (the skill calls RPCs introduced there).

---

## Gate baseline reference

Recorded on this worktree at start: server tests 158 pass, web tests 158 pass, lint + typecheck clean. Final expected: unchanged (158/158/clean). The drift-gate test (`scripts/test/check-skills-drift.test.sh`) continues to pass — the gate logic is unchanged, only the content one specific seed file is changed.

## Out of scope for this PR

- Adding/removing `init_canonical_file` template variants → would require a PR-1 follow-up
- Changing the `cog_rpc` dispatcher → already done in PR-1
- Changing the `cog_write` write-time guards → already done in PR-2
- Updating non-cog skills (`infra`, `personal`, `work`, etc.) — their routing skills are regenerated only by re-running `/cog`; if the user wants their existing routing skills to use any new conventions, they re-run `/cog`
- Migrating existing on-disk `domains.yml` files that contain legacy duplicates → handled at runtime by Phase 0.5; no migration tool needed
