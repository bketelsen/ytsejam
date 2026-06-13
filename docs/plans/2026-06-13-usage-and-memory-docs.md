# Usage and Memory Docs Implementation Plan

> Execute with the `develop` skill, task-by-task.

**Goal:** Write `docs/USAGE.md` (friend-handoff, ytsejam-the-harness) and `docs/MEMORY.md` (cog memory reference, concepts + cookbook), wire them into the repo README, and verify all internal links resolve.

**Spec:** `docs/plans/2026-06-13-usage-and-memory-docs-design.md`

**Architecture:** Two parallel user-facing markdown files at `docs/` root. USAGE has a layered tl;dr → tour → opinions spine; MEMORY has a concepts → cookbook spine. SSOT discipline between them: skill catalog lives only in USAGE; burst-cadence caveat and file-edit-pattern table live only in MEMORY; each file links into the other. Doc-only PR; no source code touched.

**Tech Stack:** Markdown only. Gate is a custom link-check + heading-anchor-check inline shell loop using `grep` and `awk` — no new npm dev-dep.

**Worktree:** `/tmp/usage-and-memory-docs`

**Branch:** `feature/usage-and-memory-docs`

**Baseline note:** `scripts/gate.sh` on main is RED at typecheck (`server/test/ltm-import.test.ts` can't resolve `ltm` module — `packages/ltm` workspace setup issue, pre-existing, tracked separately). It is unrelated to this PR. The gate for THIS PR is the markdown link/anchor check defined in Task 8, not `scripts/gate.sh`. Per the design doc's acceptance criteria, the only files touched are `docs/USAGE.md`, `docs/MEMORY.md`, and `README.md`.

---

## Task 1: Create USAGE.md skeleton (frontmatter + tl;dr)

**Files:**
- Create: `docs/USAGE.md`

### Step 1: Write `docs/USAGE.md` containing §0 (frontmatter) and §1 (tl;dr) only

Content covers the design doc's USAGE §0 and §1:

- §0 (≈10 lines): one paragraph "what this doc is and isn't" with pointers to README, MEMORY, `docs/agents/`. A short reading guide noting that "▸ *Skip if you don't care about X*" markers are honest — the doc still works if you skip them.
- §1 (≈30 lines): the 60-second tl;dr. One paragraph describing ytsejam (web-based personal AI assistant, runs as a systemd service, persistent cross-session memory, can do real work via tools, can delegate to background subagents, can wake itself on schedules). The five things that matter — **sessions**, **tools**, **skills**, **subagents**, **memory** — one sentence each. Closer: "Open the UI, sign in with your token, send a message. Everything below this is depth."

Include a top-of-file table of contents covering all sections (§0–§4) that will exist when the doc is complete. Use markdown headings `##` for top-level sections and `###` for subsections to match the existing repo doc style (see `docs/agents/OVERVIEW.md`).

### Step 2: Verify the file renders and parses

Run:
```bash
test -f docs/USAGE.md && wc -l docs/USAGE.md
grep -c '^## ' docs/USAGE.md
```
Expected: file exists, ≈40-50 lines, and `grep` finds the §0 and §1 headings.

### Step 3: Commit

```bash
git add docs/USAGE.md
git commit -m "docs(usage): add USAGE.md skeleton with frontmatter and tl;dr"
```

---

## Task 2: USAGE §2 — The tour (sessions through web UI)

**Files:**
- Modify: `docs/USAGE.md` (append §2.1–§2.9)

### Step 1: Append §2 to `docs/USAGE.md`

Nine subsections. Each follows the pattern: 2-3 line takeaway → `▸ *Skip if you don't care about X*` marker → depth.

- **§2.1 Sessions** — what a session is (a JSONL file under `~/.ytsejam/data/sessions/`), the sessions list, archive (non-destructive soft delete), auto-titles, JSONL-is-truth (so you can grep your own history). Depth: per-session model, working directory, persona override, resuming long sessions.
- **§2.2 Working directories** — per-session cwd selector; file/grep/bash tools resolve relative paths against it; `AGENTS.md` and `CLAUDE.md` auto-load from cwd ancestor chain into the system prompt. Depth: how to set in the UI, when to set, `YTSEJAM_CONTEXT_FILES` knob.
- **§2.3 Models** — model picker, the default `YTSEJAM_DEFAULT_MODEL`, when to switch (cheap for shuffling/cleanup, smart for design/debugging), credentials → models mapping. Depth: `YTSEJAM_SUBAGENT_MODEL` for delegated tasks, picking a model per delegate call.
- **§2.4 Tools the agent has** — short list with one-liner each: `bash`, `read`/`write`/`edit`, `ls`/`grep`/`find`, `web_search`, `web_fetch`, `delegate`, `schedule`, and the `cog_*` memory family. Pointer to `docs/agents/tools.md` for the full surface. Depth: how tool calls show up in the message stream, reading tool results.
- **§2.5 Skills — the catalog** ⭐ SSOT. What a skill is (a markdown playbook the agent loads on demand). How to invoke (`/name` or just describe the task and trigger words fire). **The catalog table** with rows grouped by purpose: dev-workflow (brainstorm, write-plan, develop, review, ship, lessons), code-hygiene (find-weeds, pull-weeds), docs (maintain-docs, write-a-skill, create-gate), browser (agent-browser), OS (snow-nbc, snow-updex), memory pipeline (cog, housekeeping, reflect, evolve, foresight, history, pkb-research), domain-routing (personal, work, projects, ytsejam, pkb, infra, truenas-mcp). 28 skills total — verified against the actual installed set in `~/.ytsejam/data/skills/`. Each row: skill name | one-line purpose | invoke-when summary. Below the table, a single italic note: "*Regenerate this table when adding or removing a skill — the source of truth is the skill set installed in `~/.ytsejam/data/skills/`.*" Pointer: "Memory-pipeline skills are *narrated* in [MEMORY.md](MEMORY.md#part-1--concepts) §1.7 — this catalog has their names; MEMORY tells you when and why to run them." Depth: writing your own skill (link to the `write-a-skill` skill name in the catalog), seeded vs user skills, why the user-dir copy wins.

  **Plan history note (2026-06-13):** an earlier draft of this section listed `cog-memory-service` (now retired/archived per [[glacier/projects/cog-memory-service/hot-memory-archived]]) and omitted `pkb-research` (installed since 2026-06-11). The plan has been corrected to match the actual installed skill set as of the implementation date.
- **§2.6 Subagents (delegate)** — when to use one (long research, multi-step work that would block the chat), how to invoke ("delegate this and tell me when done" — the agent calls the `delegate` tool), what happens (background task, you keep chatting, `[Task ...]` message lands when done). The `YTSEJAM_TASK_CONCURRENCY` and `YTSEJAM_TASK_TIMEOUT_MIN` knobs. Depth: model override per task, the task transcript view, cancelling.
- **§2.7 Schedules** — one-shot (`at`) + recurring (`cron`), server-local time. Writing prompts to your future self (the scheduled prompt arrives as a `[Scheduled task ...]` message with no other context — write it as a self-contained instruction). Cancel + list. Depth: `this_session` vs `new_session` target, cron syntax pointer.
- **§2.8 Memory in 5 minutes** — bare minimum to NOT screw it up. The agent has persistent memory across sessions. Organized into **domains** (personal, work, projects/<sub>, etc.). Each domain has hot (under every conversation, ≤50 lines) and warm (loaded on demand) tiers, plus a glacier archive. There's an opinionated weekly cadence (`/housekeeping` then `/reflect` same session) and monthly (`/evolve`). The agent can run these for you. Closer: "Everything below this section about memory is in [MEMORY.md](MEMORY.md) — go there when you want depth."
- **§2.9 The web UI** — sessions list, message stream, tool-call display, the compaction pill (when context fills, the agent compacts; you see it happen), schedules tab, tasks tab, archive. Depth: keyboard shortcuts (if any are wired), copy-message, message timestamps.

### Step 2: Verify the file structure

Run:
```bash
wc -l docs/USAGE.md
grep -cE '^### §2\.' docs/USAGE.md
```
Expected: ≈350-450 lines total. `grep` finds 9 §2.x subsection headings.

### Step 3: Commit

```bash
git add docs/USAGE.md
git commit -m "docs(usage): add §2 tour (sessions, tools, skills, subagents, schedules, memory, UI)"
```

---

## Task 3: USAGE §3 + §4 — Opinions + glossary

**Files:**
- Modify: `docs/USAGE.md` (append §3, §4)

### Step 1: Append §3 and §4 to `docs/USAGE.md`

§3 — How I actually use it (≈100-150 lines):

- **§3.1 The north star: ytsejam is a harness, not a chat app.** Skills are cheap (markdown); server code is expensive and sticky (TypeScript, gate, deploy). As a user this means: before asking for a new feature, ask whether a skill or a memory pattern does the job. Resist (a) adding more to the server and (b) abandoning ytsejam for the next shiny thing — both killed predecessors.
- **§3.2 The harness-check.** Before adding/asking for something new, ask: does this generalize across projects? Does it survive the next agent fad? Does it earn its place vs an existing skill? Link to the harness-check wiki topic if available; otherwise quote the gist.
- **§3.3 The operating cadence.** Weekly: `/housekeeping` then `/reflect` in the same session (cleaned state → reflection sees it). Monthly: `/evolve`. `/foresight` weekly or on demand. **Burst caveat (one-liner with pointer):** acknowledge that heavy work bursts are different — when observation volume rises (multi-day push, research blitz, shipping burst), run the pair more often. Anchor the canonical signal with a pointer to [MEMORY §1.7](MEMORY.md#17-the-pipeline--narrative); do NOT duplicate the canonical "burning a lot of tokens" sentence here. Anti-pattern: running every skill every day during a *normal week* is theatrical.
- **§3.4 What NOT to ask it to do.** Don't ask it to restart itself if it's the live process (self-modification hazard — kills your live session mid-turn). Don't ask it to do destructive things without staging them. Don't expect it to remember a single off-hand remark forever — surface important facts so it captures them properly. Don't run pipeline skills daily in steady state.
- **§3.5 Self-modification footnote.** Only relevant if ytsejam is your substrate (you're running the agent that's editing itself). Source edits to the repo are safe; `systemctl --user restart ytsejam` kills the live session. Normally Brian's gotcha, flagged here for any friend who decides to fork and run as their own substrate.

§4 — Glossary + further reading (≈30 lines):

- Definitions (one-line each): session, tool, skill, subagent (task), schedule, domain, observation, hot/warm/glacier, wiki, SSOT, L0.
- Links: [MEMORY.md](MEMORY.md), [README.md](../README.md), [docs/agents/OVERVIEW.md](agents/OVERVIEW.md), [SECURITY.md](../SECURITY.md).

### Step 2: Verify

Run:
```bash
wc -l docs/USAGE.md
grep -cE '^### §3\.' docs/USAGE.md
grep -cE '^## §' docs/USAGE.md
```
Expected: ≈500-700 total lines. `grep` finds 5 §3.x headings and 5 top-level §0–§4 headings.

### Step 3: Commit

```bash
git add docs/USAGE.md
git commit -m "docs(usage): add §3 opinions and §4 glossary"
```

---

## Task 4: MEMORY.md Part 1 — Concepts (§1.1–§1.7)

**Files:**
- Create: `docs/MEMORY.md`

### Step 1: Write `docs/MEMORY.md` containing the frontmatter, table of contents, and Part 1 (Concepts) only

Frontmatter (≈10 lines): one paragraph describing the doc — "this is the reference for ytsejam's memory system; open it when you need depth or want to do a specific thing. The conceptual scaffold (Part 1) sets up the vocabulary the cookbook (Part 2) uses. Read Part 1 once; then Part 2 is lookup."

Table of contents listing Part 1 §1.1–§1.7 and Part 2 §2.1–§2.7 + Appendix.

Part 1 — Concepts (≈200-300 lines):

- **§1.1 What memory is, in this system** (≈20 lines). Markdown files in a directory, version-controlled (auto-commit every 10 writes via the in-process commit hook). Grep-able, patch-able, human-readable. No vector DB, no embeddings — by design. The agent reads/writes via the `cog_*` tool surface; you can also edit the files directly. Location: `~/.ytsejam/data/memory/` (override with `YTSEJAM_MEMORY_DIR`). Why this shape: enables the L0 → L1 → L2 retrieval protocol described in §1.3.
- **§1.2 Domains** (≈30 lines). A domain is a folder under the memory root: `personal/`, `work/`, `projects/`, `infra/`, `pkb/`, `cog-meta/`, plus nested ones like `projects/ytsejam/`. Each has triggers (keywords) that route conversations to it. Manifest: `domains.yml` at the memory root, declaring id/path/label/triggers. Typical files per domain: `hot-memory.md`, `observations.md`, `action-items.md`, `entities.md`, plus optional `INDEX.md`, thread files, and per-domain artifacts (dev-log, architecture). Nesting: `projects/` parent, `projects/ytsejam/` child — child hot-memory is specific, parent hot-memory is cross-cutting.
- **§1.3 Tiers — hot, warm, glacier** (≈30 lines). Hot (`*/hot-memory.md`) — loaded under every conversation, ≤50 lines, rewritten freely. Warm (domain files — observations, action-items, entities, INDEX, threads) — read when a domain activates via triggers or explicit skill invocation. Glacier (`glacier/`) — read-only YAML-frontmattered archives, cataloged in `glacier/index.md`. Retrieval protocol: L0 scan (one-line summaries) → L1 outline (section headers) → L2 read (sections, not whole files). This is why every file starts with `<!-- L0: ... -->`.
- **§1.4 File types** (≈50 lines). For each: 5-7 line block covering purpose, format, edit-pattern, gotchas.
  - `hot-memory.md` — rewrite freely; ≤50 lines; L0 comment on line 1.
  - `observations.md` — append-only; `- YYYY-MM-DD [tags]: text`; why append-only (audit trail + temporal validity).
  - `action-items.md` — `- [ ] task | due:YYYY-MM-DD | pri:high/med/low | added:YYYY-MM-DD`; check off with patch, not edit.
  - `entities.md` — 3-line max per entity (`### Name (relationship)` / facts / `status: | last:YYYY-MM-DD`); edit in place.
  - `INDEX.md` — generated or curated; whole-file write allowed.
  - Thread files — read-optimized synthesis raised when a topic appears in 3+ observations across 2+ weeks; spine Current State → Timeline → Insights; one file forever.
  - `cog-meta/patterns.md` — distilled timeless operating patterns; ≤70 lines; edit in place.
  - Wiki pages (`wiki/**/index.md`) — YAML frontmatter + narrative body.
- **§1.5 Wiki** (≈20 lines). The narrative tier — what observations grow up into. Hierarchical layout: `wiki/projects/<slug>/`, `wiki/topics/<slug>/`, `wiki/people/<name>/`, `wiki/research/<question>/`, `wiki/tools/<name>/`, `wiki/ideas/<seed>/`. Pages have YAML frontmatter (type, tags, dates) and free-form body. The reverse-link index (`link-index.md`) tracks wiki-link references. When to use a wiki page vs an observation vs hot-memory: observations are timestamped data points; wiki pages are durable cross-cutting synthesis; hot-memory is the working set for a domain.
- **§1.6 SSOT and wiki-links** (≈20 lines). The discipline: each fact lives in exactly ONE file. Others reference it with `[[domain-path/filename]]` wiki-links. Why: when a fact changes, you sweep one file, not five. Stale duplicates are the #1 memory bug. Temporal-validity hints: `<!-- until:YYYY-MM-DD grace:N -->` for time-bounded facts, `<!-- from:YYYY-MM-DD -->` for stable-since. User discipline when editing memory: before duplicating, ask "where does this fact really live?" and link instead.
- **§1.7 The pipeline — narrative** (≈40 lines). CANONICAL HOME for the burst caveat.
  - Day-to-day: agent writes observations as you work, drops action-items, edits entities. You mostly read.
  - Weekly: `/housekeeping` first (archive observations >50 entries, prune done action-items, sweep stale temporal markers, rebuild indexes). Then `/reflect` in the same session (mines patterns from clusters in the cleaned state — 3-gate pipeline: cluster ≥3 entries / coverage check / synthesis with audit trail). Same-session matters: reflect sees cleaned state.
  - Monthly: `/evolve` — architecture audit of the memory system itself.
  - On demand: `/foresight`, `/history`, `/cog`.
  - **Burst caveat (canonical sentence):** "The cadence assumes steady-state usage. When you're burning a lot of tokens — a deep multi-day push on one project, a research blitz, anything that's generating observations faster than usual — run `/housekeeping` + `/reflect` more often (every couple of days, or daily during a real burst). The signal is observation volume, not the calendar."
  - Anti-pattern: running every skill every day in a *normal week* is theatrical.
  - Pointer: skill *catalog* — names + invocation — is in [USAGE.md §2.5](USAGE.md#25-skills--the-catalog). This section narrates the cadence.

### Step 2: Verify

Run:
```bash
wc -l docs/MEMORY.md
grep -cE '^### §1\.' docs/MEMORY.md
grep -c 'burning a lot of tokens' docs/MEMORY.md
```
Expected: ≈300-400 lines so far. `grep` finds 7 §1.x headings. The burst-caveat phrase appears exactly once.

### Step 3: Commit

```bash
git add docs/MEMORY.md
git commit -m "docs(memory): add Part 1 concepts (memory shape, domains, tiers, files, wiki, SSOT, pipeline)"
```

---

## Task 5: MEMORY.md Part 2 — Cookbook §2.1–§2.4

**Files:**
- Modify: `docs/MEMORY.md` (append Part 2 §2.1–§2.4)

### Step 1: Append Part 2 header and the first four task groups

Part 2 — Cookbook header: one paragraph framing — "Each entry below is a verb-phrase task. The body is steps + rationale + links back to the concepts in Part 1. Skim the headings; read the body when you need to do that task."

- **§2.1 Day-to-day tasks** (≈8 tasks, ≈100-130 lines).
  1. **Surface a fact you want remembered.** Just tell the agent: "remember that…" or "log this as an observation in [domain]." The agent picks the domain via triggers; you can override.
  2. **Check off an action item.** Either ask the agent ("check off task N in personal/action-items") or edit `action-items.md` directly — change `- [ ]` to `- [x]` via patch (do not whole-file rewrite the file).
  3. **See what's in hot-memory right now.** Ask the agent ("show me ytsejam hot-memory") or open `~/.ytsejam/data/memory/projects/ytsejam/hot-memory.md` in your editor.
  4. **Find when something happened.** `/history` for narrative reconstruction across observations and glacier, or ask the agent to `cog_search` for a phrase.
  5. **See what the agent knows about a person/project/tool.** `cog_search` or browse `wiki/people/`, `wiki/projects/`, `wiki/tools/` directly.
  6. **Add a note that doesn't fit any domain.** Default: drop it in `personal/observations.md` or `pkb/observations.md`. Better: if you're capturing 3+ similar notes, run `/cog` to create a new domain.
  7. **Recover an archived note.** Glacier is read-only. Read the relevant `glacier/<domain>/...` file, copy the line(s) you want back into the live file. Do not edit glacier in place.
  8. **Rebuild generated indexes.** When (after manual edits to many files) and how — re-run `/housekeeping`, which rebuilds the glacier index, wiki index, and link index. The agent can also call individual RPC methods (`glacier_index_compute`, `wiki_index_compute`, `link_index_compute`) on request.

- **§2.2 Weekly maintenance** (≈3 tasks, ≈60 lines).
  1. **Run the weekly cadence properly.** `/housekeeping` first (in a fresh session, ideally), then `/reflect` in the SAME session — `/reflect` needs to see the cleaned state. **Burst reminder (canonical for cookbook):** "If you're in a burst, drop the 'weekly' frame and run on volume. Any time `observations.md` is filling fast or hot-memory feels stale, run the pair. See [§1.7](#17-the-pipeline--narrative) for the signal."
  2. **Read the reflect output.** What gets promoted (new pattern in `cog-meta/patterns.md`), what gets dropped (didn't pass the cluster/coverage/synthesis gates), why each decision. The 3 gates explained at user-facing level: cluster (≥3 entries, ≥7 day span, ≥3 distinct dates, specific tag), coverage (skip if existing pattern covers it; REPLACE when new subsumes old), synthesis (one actionable line + `<!-- promoted:YYYY-MM-DD theme:tag -->` audit trail).
  3. **Handle a heating topic (spike).** ≥5 entries in <7 days = heating topic / thread candidate (not pattern-ready). What to do: consider raising a thread file with the spine Current State → Timeline → Insights. The agent can do this for you via `/reflect`'s spike-handling, or you can author it manually.

- **§2.3 Monthly + on-demand** (≈4 tasks, ≈60 lines).
  1. **Run `/evolve` and act on the scorecard.** What evolve does (architecture audit of memory itself, threshold-routed actions, structural changes). What the scorecard tells you. When to follow recommendations vs ignore (heuristics).
  2. **Run `/foresight` for a nudge.** When to ask for one (start of a new week, when you feel stuck, after a domain shift). How to interpret. What to do with the nudge — it lands in `cog-meta/foresight-nudge.md`.
  3. **Run `/history` for a question.** How to phrase the query for best reconstruction ("when did I first run X", "what happened with Y in May", "show me the arc of Z").
  4. **Audit memory health.** `cog_rpc` audit methods: `link_audit`, `entity_audit`, `cluster_check`, `scenario_check`. When to run (after large refactors, before major migrations).

- **§2.4 Customizing your memory** (≈6 tasks, ≈100-130 lines).
  1. **Add a new domain.** Run `/cog`. What it does (edits `domains.yml`, creates the domain folder, generates a router skill, optionally seeds starter files). Triggers — how to pick good ones (specific nouns, not generic verbs).
  2. **Customize hot-memory for a domain.** What belongs (cross-session truths, active priorities, things the agent must always know about this domain). What doesn't (transient state — goes in observations; durable facts — go in entities or wiki).
  3. **Promote an observation to a pattern.** Manual path (edit `cog-meta/patterns.md` directly, add `<!-- promoted:YYYY-MM-DD theme:tag -->`) vs let `/reflect` do it. When manual makes sense (you have a clear insight that won't pass the cluster gate yet — say, a one-off but high-confidence rule).
  4. **Promote a cluster to a thread file.** Criteria (≥3 observations across ≥2 weeks, topic feels important enough to consolidate). Spine: Current State (rewrite freely) → Timeline (append) → Insights (curated). One file forever — never delete; supersede.
  5. **Promote a durable fact to a wiki page.** When narrative warrants its own page (recurring cross-cutting topic, person/project/tool that earns its own home). Picking the right `wiki/` subtree. Frontmatter conventions (`type:`, `tags:`, `created:`, `updated:`).
  6. **Refactor a domain.** Splitting (when a child domain earns its own folder — typically when a project graduates from "mentioned in projects/" to "has its own subdomain"). Merging (when two domains collapsed in practice). Renaming (sweep wiki-links repo-wide with `grep -r '\[\['`; update `domains.yml`).

### Step 2: Verify

Run:
```bash
wc -l docs/MEMORY.md
grep -cE '^### §2\.[1-4]\.' docs/MEMORY.md
grep -c 'burst' docs/MEMORY.md
```
Expected: ≈500-650 lines total. The burst-caveat phrase now appears at least twice (one in §1.7, one in §2.2). §2.1–§2.4 each have their numbered sub-tasks as `### §2.x.y` headings (~21 sub-task headings total).

### Step 3: Commit

```bash
git add docs/MEMORY.md
git commit -m "docs(memory): add Part 2 cookbook §2.1–§2.4 (day-to-day, weekly, monthly+on-demand, customizing)"
```

---

## Task 6: MEMORY.md Part 2 — Cookbook §2.5–§2.7 + Appendix

**Files:**
- Modify: `docs/MEMORY.md` (append §2.5–§2.7 and Appendix)

### Step 1: Append the remaining cookbook sections and the appendix

- **§2.5 Wiki-specific** (≈3 tasks, ≈40 lines).
  1. **Create a wiki page.** Path (`wiki/<subtree>/<slug>/index.md`), frontmatter template (type, tags, created, updated), body conventions (lead paragraph, headed sections). When wiki vs observation vs hot-memory.
  2. **Cross-link with wiki-links.** Syntax `[[wiki/topics/harness-check/index]]` or just `[[path/to/file]]` for non-wiki files. What the reverse-link index (`link-index.md`) does for you (lets you find what references a given file).
  3. **Rebuild the wiki index.** When (after creating multiple wiki pages) and how (`cog_rpc wiki_index_compute` or rerun `/housekeeping`).

- **§2.6 Editing memory directly** (≈3 tasks, ≈50 lines).
  1. **Safe direct edits.** Which file types accept which patterns:
     - Rewrite freely: `hot-memory.md`, `INDEX.md`, generated indexes.
     - Append only: `observations.md`.
     - Edit in place: `entities.md`, `cog-meta/patterns.md`.
     - Patch (for checkboxes): `action-items.md`.
     - Read only: `glacier/**`.
  2. **The auto-commit cadence.** Every 10 writes (`auto: 10 memory writes`) plus startup flush. Direct edits ride along with the next commit; nothing is lost. The git repo lives at `~/.ytsejam/data/memory/.git/` — `git log` inside it shows the history.
  3. **Resolve a stale fact.** The sweep pattern: when a fact CHANGES, find every `hot-memory.md` that mentions it (`grep -r 'phrase' ~/.ytsejam/data/memory/`), update or link to SSOT. Why this matters: single-level checks miss tier-2 staleness — the #1 memory bug.

- **§2.7 Troubleshooting + recovery** (≈3 tasks, ≈40 lines).
  1. **"The agent doesn't remember X."** Diagnostic ladder:
     - Was it ever written? `cog_search` for the phrase.
     - Is it in glacier? Check `glacier/<domain>/...` files.
     - Was it in a domain that didn't get triggered? Check `domains.yml` triggers.
     - Did SSOT discipline mean it's linked, not duplicated, from where you looked? Follow the `[[...]]` link.
  2. **"hot-memory is over 50 lines."** What to do: prune via `/housekeeping`, or manually (move stale items to entities/wiki/glacier; collapse multi-line items). What to keep (active priorities, cross-session truths) vs cut (resolved issues, transient state).
  3. **"action-items.md has 30 done items."** `/housekeeping` archives done items when count exceeds 10. Manual route: cut the `- [x]` lines into `glacier/<domain>/action-items-done.md` with YAML frontmatter and update `action-items.md`.

- **Appendix — Quick reference** (≈30 lines).
  - **File-edit-pattern table (CANONICAL):** the same table that's in the system prompt — rewrite/append/edit-in-place/patch/read-only per file type.
  - **Glacier thresholds:** observations >50 → archive oldest; action-items >10 done → archive done.
  - **Consolidation gates summary:** cluster (≥3/≥7d/≥3 dates/specific tag), coverage (skip or REPLACE), synthesis (one actionable line + audit trail).
  - **Pipeline cadence one-liner + burst caveat one-liner.**
  - Pointer to [USAGE §2.5](USAGE.md#25-skills--the-catalog) for the skill catalog.
  - Pointer to [`docs/memory/FORMAT.md`](memory/FORMAT.md) for implementer-level depth (on-disk format spec).

### Step 2: Verify

Run:
```bash
wc -l docs/MEMORY.md
grep -cE '^### §2\.' docs/MEMORY.md
grep -cE '^## Appendix' docs/MEMORY.md
```
Expected: ≈700-900 lines total. ~25 §2.x.y sub-task headings (combined across §2.1–§2.7). Appendix exists.

### Step 3: Commit

```bash
git add docs/MEMORY.md
git commit -m "docs(memory): add cookbook §2.5–§2.7 (wiki, direct edits, troubleshooting) + appendix"
```

---

## Task 7: Wire docs into README

**Files:**
- Modify: `README.md` (add a pointer in the Run section)

### Step 1: Find the right insertion point and add the pointer

Open `README.md` and locate the "## Run" section. Immediately after the existing code block (`npm install` / `npm start` / `open http://localhost:3000`), and before the "If `NODE_ENV=production` is set" paragraph, add a new paragraph:

```markdown
Once it's running, see [`docs/USAGE.md`](docs/USAGE.md) for how to actually use it day to day —
sessions, tools, skills, subagents, schedules, and the memory model. For the cog memory deep dive
(domains, tiers, the weekly/monthly pipeline, customizing), see [`docs/MEMORY.md`](docs/MEMORY.md).
```

This is the only README change. Do not touch security, troubleshooting, or other sections.

### Step 2: Verify

Run:
```bash
grep -c 'docs/USAGE.md' README.md
grep -c 'docs/MEMORY.md' README.md
```
Expected: each phrase appears exactly once in README.

### Step 3: Commit

```bash
git add README.md
git commit -m "docs(readme): point to docs/USAGE.md and docs/MEMORY.md from the Run section"
```

---

## Task 8: Gate — markdown link + anchor check

**Files:**
- None (verification only)

### Step 1: Run the link check across all repo markdown files we touched

The gate for this PR is verifying that every internal link in USAGE.md, MEMORY.md, and the README pointer resolves. We use a small inline shell loop — no new npm dev-dep — that extracts markdown links of the form `](relative/path)` or `](relative/path#anchor)` and verifies the target file exists and (if an anchor is given) that the target heading exists.

Save this as `scripts/check-doc-links.sh` (a new file, dedicated to this gate):

```bash
#!/usr/bin/env bash
# Verify markdown internal links in the given files resolve.
# Checks that:
#   - relative path targets exist
#   - if a #anchor is given, the target file contains a matching heading
# Skips: http(s) URLs, mailto:, plain #anchor (same-file anchors not yet validated).

set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <markdown file> [markdown file ...]" >&2
  exit 2
fi

fail=0

slugify() {
  # GitHub-compatible slug (mirrors Flet/github-slugger):
  # lowercase, strip everything except a-z 0-9 spaces hyphens, then spaces → hyphens
  # (consecutive spaces produce consecutive hyphens — em-dashes/section-marks etc. get
  # stripped but their surrounding spaces remain, e.g. "Foo — bar" → "foo--bar").
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9 -]//g' \
    | sed -E 's/ /-/g'
}

for src in "$@"; do
  src_dir="$(dirname "$src")"
  # Extract every (target) inside ](target) where target doesn't start with http, mailto, or #.
  # grep -oE handles the inline form; we then strip ](  and  ).
  grep -oE '\]\([^)]+\)' "$src" \
    | sed -E 's/^\]\(//; s/\)$//' \
    | grep -vE '^(https?|mailto|#)' \
    | while read -r link; do
        path="${link%%#*}"
        anchor=""
        if [[ "$link" == *"#"* ]]; then
          anchor="${link#*#}"
        fi
        target="$src_dir/$path"
        # Normalize via realpath if available, else best-effort.
        if command -v realpath >/dev/null 2>&1; then
          target="$(realpath -m "$target")"
        fi
        if [ ! -e "$target" ]; then
          echo "BROKEN: $src → $link (no file at $target)" >&2
          fail=1
          continue
        fi
        if [ -n "$anchor" ]; then
          # Build a flattened slug list of every # heading in the target.
          mapfile -t headings < <(grep -E '^#{1,6} ' "$target" | sed -E 's/^#+ //')
          found=0
          for h in "${headings[@]}"; do
            slug="$(slugify "$h")"
            if [ "$slug" = "$anchor" ]; then
              found=1
              break
            fi
          done
          if [ "$found" -eq 0 ]; then
            echo "BROKEN: $src → $link (anchor #$anchor not found in $target)" >&2
            fail=1
          fi
        fi
      done
done

if [ "$fail" -ne 0 ]; then
  echo "FAIL: one or more links are broken." >&2
  exit 1
fi

echo "OK: all internal links resolve."
```

Then make it executable and run it against the three files:

```bash
chmod +x scripts/check-doc-links.sh
bash scripts/check-doc-links.sh docs/USAGE.md docs/MEMORY.md README.md
```

Expected: `OK: all internal links resolve.` If any are broken, fix them in the source doc (USAGE/MEMORY/README) — typically a heading-slug mismatch. The slugify rule matches GitHub: lowercase the heading; strip everything except a-z, 0-9, spaces, and hyphens; convert each space to a single hyphen. Example: `## §2.5 Skills — the catalog` slugifies to `25-skills--the-catalog` (the `§` and `.` are stripped, and the em-dash between two spaces leaves the two surrounding spaces, which both become hyphens — hence `--`).

### Step 2: Verify the new gate script exists and is executable

```bash
test -x scripts/check-doc-links.sh
bash scripts/check-doc-links.sh docs/USAGE.md docs/MEMORY.md README.md
```
Expected: file exists, executable bit set, run succeeds.

### Step 3: Commit the gate script

```bash
git add scripts/check-doc-links.sh
git commit -m "build: add scripts/check-doc-links.sh as the gate for doc-only PRs"
```

---

## Task 9: Final integration check + summary

**Files:**
- None (verification only)

### Step 1: Re-run the doc-link gate on the full set

```bash
bash scripts/check-doc-links.sh docs/USAGE.md docs/MEMORY.md README.md
```
Expected: `OK: all internal links resolve.`

### Step 2: Sanity-check the acceptance criteria from the design doc

```bash
# 1. Both files exist
test -f docs/USAGE.md && test -f docs/MEMORY.md && echo "AC1 ok"

# 2. USAGE includes the skill catalog (look for a few key skill names in a table row)
grep -q '| brainstorm ' docs/USAGE.md && grep -q '| housekeeping ' docs/USAGE.md && echo "AC2 ok"

# 3. MEMORY §1.7 contains the burst caveat
grep -q 'burning a lot of tokens' docs/MEMORY.md && echo "AC3 ok"

# 4. USAGE §3.3 references the burst caveat with a pointer to MEMORY §1.7
# (Final wording diverged from the brainstorm draft "Weekly is the floor" —
# the semantic AC is satisfied by ANY burst caveat + the §1.7 anchor.)
grep -qE 'burst|heavy work' docs/USAGE.md && grep -q 'MEMORY.md#17-the-pipeline--narrative' docs/USAGE.md && echo "AC4 ok"

# 5. README points to USAGE
grep -q 'docs/USAGE.md' README.md && echo "AC5 ok"

# 6. AGENTS.md is NOT touched
git diff --name-only main..HEAD | grep -q '^AGENTS.md$' && echo "AC6 FAIL: AGENTS.md was modified" || echo "AC6 ok"

# 8. No code files touched (only docs, README, gate script)
git diff --name-only main..HEAD | grep -vE '^(docs/|README\.md$|scripts/check-doc-links\.sh$)' && echo "AC8 FAIL: non-doc files touched" || echo "AC8 ok"
```

All six lines should print `ok` (AC7 — links resolve — is covered by Step 1).

### Step 3: Print the commit summary

```bash
git log --oneline main..HEAD
```
Expected: 8 commits (Tasks 1, 2, 3, 4, 5, 6, 7, 8). Task 9 is verify-only and has no commit.

---

## Done criteria

- All 9 tasks complete.
- `bash scripts/check-doc-links.sh docs/USAGE.md docs/MEMORY.md README.md` exits 0.
- All AC checks in Task 9 print `ok`.
- Branch ready to PR.
