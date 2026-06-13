# Design — `docs/USAGE.md` and `docs/MEMORY.md`

Date: 2026-06-13
Topic: `usage-and-memory-docs`
Status: approved, ready for plan

## Goal

Write two user-facing reference documents that teach a friend how to actually
use ytsejam day to day. The existing `README.md` covers install and operator
concerns; `docs/agents/*` is for AI agents working in the repo. There is no
doc that answers the question **"I've got it running — now what do I do with
it?"** for the human at the other end.

The 90/10 framing: most of ytsejam's *behavior* — what the agent remembers,
what it consolidates, how it adapts to the user — is mediated by cog memory.
The harness is the bottle; cog is the wine. The two-doc split honors that.

## Audience

**Primary:** a friend Brian hands a fresh install to. They followed the
README, got it running, and now need the operating model.

**Progressive disclosure across four reader profiles:**

1. **Technically savvy, no agent-tooling background** — needs the concept
   layer ("what's a skill, what's a session, why does the agent have
   memory") before the how-to.
2. **Agent-tooling adjacent** — has used Claude/Cursor/coding agents.
   Knows sessions and tool calls. Needs to learn what's different about
   ytsejam.
3. **Power user / fellow builder** — wants the opinionated take. Heavy on
   rationale; light on click-by-click.
4. **Heterogeneous reader** — the same person at different times.

Each section starts with the takeaway, then opens up for depth. Skip
markers (▸ *Skip if you don't care about X*) are honest — the doc still
works if you skip them.

## Non-goals

- **Not the install doc.** README owns prereqs, env vars, deploy, security
  model, troubleshooting.
- **Not for AI agents working in the repo.** `docs/agents/OVERVIEW.md` owns
  that audience.
- **Not the implementer spec.** `docs/memory/FORMAT.md`,
  `docs/memory/RPC-CONSOLIDATION.md`, `docs/memory/WIKI-TIER.md`, and
  `docs/memory/TIERED-PATTERNS.md` own the on-disk format and internals.
- **Not a sales pitch.** README's first paragraph + `docs/agents/OVERVIEW.md`
  cover what ytsejam is for someone landing on the repo.
- **No code touches.** Doc-only PR.

## Shape and placement

Two files at `docs/` root, parallel to each other and to the existing
`docs/agents/` and `docs/memory/` subdirectories:

- **`docs/USAGE.md`** — friend handoff, ytsejam-the-harness, layered
  progressive disclosure. Read once, internalize.
- **`docs/MEMORY.md`** — reference, the cog-shaped 90%, concepts +
  cookbook. Opened when you want depth or need to do a specific thing.

Both files link into each other and into the existing implementer docs
when a reader wants to go deeper than user-facing material.

The existing `docs/memory/` directory is left untouched — it holds the
implementer specs and stays the SSOT for on-disk format.

## Cross-doc SSOT discipline

- **Skill catalog** is SSOT in USAGE §2.5. MEMORY references skills by
  name only and narrates the pipeline cadence; it does not re-document
  each skill.
- **Burst-cadence caveat** ("when burning a lot of tokens, run weekly more
  often") is canonical in MEMORY §1.7 (pipeline narrative) and §2.2
  (cookbook weekly task). USAGE §3.3 carries a one-liner with a pointer.
- **File-edit-pattern table** is canonical in the MEMORY appendix.
  USAGE's "memory in 5 minutes" references it.
- **Pipeline cadence** itself is canonical in MEMORY §1.7. USAGE §3.3 has
  the opinion ("how I actually use it"); MEMORY has the mechanics.

---

## `docs/USAGE.md` — outline

**Spine:** layered tl;dr → tour → opinions. Each section skippable.
**Voice:** friend to friend, opinionated, "here's how I use it."
**Target length:** ≈500-700 lines.

### §0 Frontmatter (≈10 lines)

- One paragraph: what this doc is and isn't. Pointers to README (install),
  MEMORY (memory deep-dive), `docs/agents/` (for AI agents in-repo).
- Reading guide: skip markers are honest.

### §1 tl;dr — ytsejam in 60 seconds (≈30 lines)

- One-paragraph what-it-is.
- The five things that matter: **sessions**, **tools**, **skills**,
  **subagents**, **memory** — one sentence each.
- "Open the UI, sign in with your token, send a message." Everything below
  is depth.

### §2 The tour (≈300-400 lines)

Each subsection: takeaway in 2-3 lines, then ▸ skip marker, then depth.

- **§2.1 Sessions** — what a session is, list, archive (non-destructive),
  auto-titles, JSONL-is-truth. ▸ depth: per-session model, working dir,
  persona override, resuming long sessions.
- **§2.2 Working directories** — per-session cwd; tools resolve relative
  paths against it; AGENTS.md/CLAUDE.md auto-load from cwd ancestors. ▸
  depth: how to set, when to set, `YTSEJAM_CONTEXT_FILES`.
- **§2.3 Models** — picker, default, when to switch (cheap for shuffling,
  smart for design), credentials → models mapping. ▸ depth: subagent model
  knob, picking models for delegate calls.
- **§2.4 Tools the agent has** — short list with one-liner each. Pointer
  to `docs/agents/tools.md` for the full surface. ▸ depth: reading tool
  calls in the UI, message stream conventions.
- **§2.5 Skills — the catalog** ⭐ **SSOT for skill descriptions.** What a
  skill is, how to invoke (`/name` or trigger words). Full catalog table
  grouped by purpose: dev-workflow, code-hygiene, docs, browser, OS,
  memory pipeline, domain-routing. Pointer: memory-pipeline skills are
  *narrated* in MEMORY; this catalog has names + one-liners. ▸ depth:
  writing your own skill, seeded vs user, why user wins.
- **§2.6 Subagents (delegate)** — when to use one, how to invoke,
  concurrency/timeout knobs. ▸ depth: model override per task, transcript,
  cancelling, parallel-task safety.
- **§2.7 Schedules** — one-shot + recurring, server-local time. Writing
  prompts to your future self. Cancel + list. ▸ depth: this-session vs
  new-session target, cron syntax pointer.
- **§2.8 Memory in 5 minutes** — bare minimum to NOT screw it up. The
  agent has persistent memory; organized into domains with hot/warm/glacier
  tiers; opinionated weekly + monthly cadence. Pointer to MEMORY for depth.
- **§2.9 The web UI** — sessions list, message stream, tool-call display,
  compaction pill, schedules tab, tasks tab, archive. ▸ depth: keyboard
  shortcuts, copy-message, timestamps.

### §3 How I actually use it — the opinions (≈100-150 lines)

- **§3.1 The north star: ytsejam is a harness, not a chat app.** Skills
  cheap, server code expensive. As a user: ask whether a skill or memory
  pattern does the job before requesting a feature.
- **§3.2 The harness-check.** Before adding/asking for something new:
  does this generalize? Survives the next agent fad? Link to wiki
  topic.
- **§3.3 The operating cadence.** Weekly: `/housekeeping` then
  `/reflect` in same session. Monthly: `/evolve`. `/foresight` weekly
  or on demand. **Burst caveat:** weekly is the floor, not the ceiling
  — burn a lot of tokens, run it more (pointer to MEMORY §1.7 for the
  why). Anti-pattern: running every skill every day in a *normal week*
  is theatrical.
- **§3.4 What NOT to ask it to do.** Don't ask it to restart itself
  if it's the live process. Don't ask destructive things without
  staging. Don't expect it to remember a single off-hand remark
  forever — surface important facts. Don't run pipeline skills daily
  in steady state.
- **§3.5 Self-modification footnote.** Only if ytsejam is your
  substrate: source edits safe, `systemctl restart` kills the live
  session. Brian's gotcha; flag for friends who fork.

### §4 Glossary + further reading (≈30 lines)

- Definitions: session, tool, skill, subagent (task), schedule, domain,
  observation, hot/warm/glacier, wiki, SSOT, L0.
- Links: MEMORY, README, `docs/agents/OVERVIEW.md`, SECURITY.

---

## `docs/MEMORY.md` — outline

**Spine:** concepts (≈30%) → cookbook (≈70%).
**Voice:** structured, lookup-friendly. Less opinion, more "this is how
it is." Headings discoverable.
**Target length:** ≈600-900 lines.

### Part 1 — Concepts (≈200-300 lines)

#### §1.1 What memory is, in this system (≈20 lines)
- Markdown files in a directory, version-controlled (auto-commit every
  10 writes).
- Grep-able, patch-able, human-readable. No vector DB by design.
- Agent reads/writes via `cog_*` tools; user can also edit directly.
- Location: `~/.ytsejam/data/memory/` (or `$YTSEJAM_MEMORY_DIR`).
- Why this shape: enables L0/L1/L2 retrieval.

#### §1.2 Domains (≈30 lines)
- A domain is a folder under the memory root.
- Each has triggers (keywords) for routing.
- Manifest: `domains.yml`.
- Typical files per domain: hot-memory, observations, action-items,
  entities, INDEX, optional threads/dev-log/architecture.
- Nesting: `projects/` parent, `projects/ytsejam/` child.

#### §1.3 Tiers — hot, warm, glacier (≈30 lines)
- **Hot** — under every conversation, ≤50 lines, rewritten freely.
- **Warm** — read when domain activates.
- **Glacier** — read-only YAML-frontmattered archives.
- Retrieval protocol: L0 → L1 outline → L2 read sections.

#### §1.4 File types (≈50 lines)

Each file type gets a 5-7 line block:
- `hot-memory.md` — purpose, rewrite-freely, 50-line + L0 rules.
- `observations.md` — append-only, format, why append-only.
- `action-items.md` — format, check-off via patch.
- `entities.md` — 3-line max per entity, edit-in-place.
- `INDEX.md` — generated/curated domain index.
- **Thread files** — synthesis raised when topic appears in 3+
  observations across 2+ weeks; spine Current State → Timeline → Insights.
- `cog-meta/patterns.md` — distilled timeless patterns, ≤70 lines.
- **Wiki pages** — YAML frontmatter + narrative.

#### §1.5 Wiki (≈20 lines)
- The narrative tier — what observations grow up into.
- Hierarchy: projects/topics/people/research/tools/ideas.
- Frontmatter + body. Reverse-link index tracks references.
- When wiki vs observation vs hot-memory.

#### §1.6 SSOT and wiki-links (≈20 lines)
- Each fact in exactly ONE file; others link with `[[path/file]]`.
- Why: sweep one file when facts change.
- Temporal hints: `<!-- until: -->`, `<!-- from: -->`.
- User discipline: before duplicating, ask where the fact really lives.

#### §1.7 The pipeline — narrative (≈40 lines)
- **Day-to-day:** agent writes observations, drops action-items.
  You mostly read.
- **Weekly:** `/housekeeping` first, then `/reflect` same session.
  Same-session matters: reflect sees cleaned state.
- **Monthly:** `/evolve` — architecture audit of memory itself.
- **On demand:** `/foresight`, `/history`, `/cog`.
- **Burst caveat (CANONICAL):** "The cadence assumes steady-state
  usage. When you're burning a lot of tokens — a deep multi-day push
  on one project, a research blitz, anything generating observations
  faster than usual — run `/housekeeping` + `/reflect` more often
  (every couple of days, or daily during a real burst). The signal is
  observation volume, not the calendar."
- Anti-pattern: running every skill every day in a *normal week* is
  theatrical.
- Pointer: skill catalog is in USAGE §2.5; this section narrates the
  cadence.

### Part 2 — Cookbook (≈400-600 lines)

Each entry: heading is verb-phrase task; body is steps + rationale +
links to concepts. Target ≈25 tasks across 7 groups.

#### §2.1 Day-to-day (≈8 tasks)
- Surface a fact you want remembered.
- Check off an action item.
- See what's in hot-memory right now.
- Find when something happened.
- See what the agent knows about a person/project/tool.
- Add a note that doesn't fit any domain.
- Recover an archived note.
- Rebuild generated indexes.

#### §2.2 Weekly maintenance (≈3 tasks)
- Run the weekly cadence properly. **Burst reminder:** "If you're in a
  burst, drop the 'weekly' frame and run on volume — any time
  observations.md is filling fast or hot-memory feels stale, run the
  pair."
- Read the reflect output (what gets promoted, what gets dropped, why;
  3 gates).
- Handle a heating topic (≥5 entries in <7 days = thread candidate).

#### §2.3 Monthly + on-demand (≈4 tasks)
- Run `/evolve` and act on the scorecard.
- Run `/foresight` for a nudge.
- Run `/history` for a question.
- Audit memory health (link audit, entity audit, cluster check,
  scenario check).

#### §2.4 Customizing (≈6 tasks)
- Add a new domain (via `/cog`).
- Customize hot-memory for a domain.
- Promote an observation to a pattern.
- Promote a cluster to a thread file.
- Promote a durable fact to a wiki page.
- Refactor a domain (split/merge/rename).

#### §2.5 Wiki-specific (≈3 tasks)
- Create a wiki page.
- Cross-link with wiki-links.
- Rebuild the wiki index.

#### §2.6 Editing memory directly (≈3 tasks)
- Safe direct edits (which file types accept which patterns).
- The auto-commit cadence (every 10 writes, startup flush).
- Resolve a stale fact (the sweep pattern).

#### §2.7 Troubleshooting + recovery (≈3 tasks)
- "The agent doesn't remember X" — diagnostic ladder.
- "hot-memory is over 50 lines" — prune or auto-prune.
- "action-items has 30 done items" — archive via /housekeeping.

### Appendix — Quick reference (≈30 lines)
- File-edit-pattern table (CANONICAL).
- Glacier thresholds (obs >50, action-items >10 done).
- Consolidation gates summary.
- Pipeline cadence one-liner + burst caveat one-liner.
- Pointer to USAGE skill catalog.
- Pointer to `docs/memory/FORMAT.md` for implementer depth.

---

## Acceptance criteria

1. Both files exist at `docs/USAGE.md` and `docs/MEMORY.md`.
2. USAGE includes the full skill catalog (current shipped skills as of
   PR-merge date) grouped by purpose.
3. MEMORY's pipeline narrative (§1.7) contains the burst-cadence
   caveat verbatim or near-verbatim.
4. USAGE §3.3 references the burst caveat with a pointer to MEMORY.
5. README's "Run" section gets a single line pointing to USAGE.
6. AGENTS.md is **not** touched (it's the agent-in-repo pointer, not the
   user pointer).
7. All internal links resolve (markdown link check passes).
8. No code files touched.

## Gate

Doc-only PR. Gate is markdown lint + link check, not `scripts/gate.sh`:

```sh
# proposed gate for this PR (script does not exist yet; plan will add it
# or use an inline command)
npx markdown-link-check docs/USAGE.md docs/MEMORY.md
# (optional) markdownlint docs/USAGE.md docs/MEMORY.md
```

If `markdown-link-check` is not already available, the plan can either
add it as a dev-dep or use a simple grep-and-curl loop. The intent is
"verify links resolve" — implementation can be pragmatic.

## Risks and mitigations

- **Risk:** USAGE skill catalog goes stale as skills are added/removed.
  **Mitigation:** the maintain-docs skill discipline already in place;
  add a single line at the top of §2.5 noting "regenerate this table
  with the skills tool when adding/removing a skill."
- **Risk:** MEMORY cookbook tasks reference cog tool surfaces that
  change. **Mitigation:** reference *concepts* and *skill names*
  preferentially; only include literal tool calls when the user is
  expected to run them themselves; link to `docs/memory/RPC-CONSOLIDATION.md`
  for the implementer surface.
- **Risk:** the two files duplicate content despite the SSOT plan.
  **Mitigation:** the cross-doc SSOT discipline section above is
  explicit; review pass checks that catalog/burst-caveat/file-edit-table
  live where stated and are linked, not copied, from the other doc.
- **Risk:** doc length scares readers off. **Mitigation:** the
  progressive-disclosure spine and skip markers are load-bearing —
  the plan should review each section for whether the takeaway truly
  lands in the first 2-3 lines.

## Open implementation choices (for the plan to decide)

- Whether the gate adds `markdown-link-check` as a real dev-dep, uses
  it via `npx` ad-hoc, or rolls a simple `grep + curl` loop.
- Whether to add a `docs/README.md` index listing all docs/ files (small
  YAGNI risk; the two new files are easy to discover from the repo
  root README).
- Whether the skill catalog table in USAGE §2.5 should be auto-generated
  from `server/skills/` at doc-build time, or hand-maintained for now
  (recommendation: hand-maintained — auto-generation is a separate
  feature, not part of this doc PR).
