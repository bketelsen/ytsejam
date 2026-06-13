# Memory — the reference

This is the reference for ytsejam's memory system. Open it when you need depth or want to do a specific thing. The conceptual scaffold (Part 1) sets up the vocabulary the cookbook (Part 2) uses. Read Part 1 once; then Part 2 is lookup.

*For a friend-style tour, see [USAGE.md](USAGE.md). For implementer-level on-disk format, see [docs/memory/FORMAT.md](memory/FORMAT.md).*

## Contents

- [Part 1 — Concepts](#part-1--concepts)
  - [§1.1 What memory is, in this system](#11-what-memory-is-in-this-system)
  - [§1.2 Domains](#12-domains)
  - [§1.3 Tiers — hot, warm, glacier](#13-tiers--hot-warm-glacier)
  - [§1.4 File types](#14-file-types)
  - [§1.5 Wiki](#15-wiki)
  - [§1.6 SSOT and wiki-links](#16-ssot-and-wiki-links)
  - [§1.7 The pipeline — narrative](#17-the-pipeline--narrative)
- [Part 2 — Cookbook](#part-2--cookbook)
  - [§2.1 Day-to-day tasks](#21-day-to-day-tasks)
  - [§2.2 Weekly maintenance](#22-weekly-maintenance)
  - [§2.3 Monthly + on-demand](#23-monthly--on-demand)
  - [§2.4 Customizing your memory](#24-customizing-your-memory)
  - [§2.5 Wiki-specific](#25-wiki-specific)
  - [§2.6 Editing memory directly](#26-editing-memory-directly)
  - [§2.7 Troubleshooting + recovery](#27-troubleshooting--recovery)
- [Appendix — Quick reference](#appendix--quick-reference)

## Part 1 — Concepts

Part 1 defines the nouns the memory system uses.

The short version: ytsejam memory is a git-backed markdown tree with a few file shapes, a domain router, and a maintenance pipeline. The value is not in a hidden database. The value is in conventions that make memory cheap to read, cheap to patch, and hard to silently corrupt.

### §1.1 What memory is, in this system

Memory is markdown files in a directory.

Those files are intentionally:

- **human-readable** — open them in an editor and the structure is visible;
- **grep-able** — literal search works because the store is plain text;
- **patch-able** — small exact replacements are the normal edit operation;
- **version-controlled** — the memory root is a git repo;
- **tool-addressable** — the agent reads and writes it through `cog_*` tools.

Default location:

```text
~/.ytsejam/data/memory/
```

Override it with `YTSEJAM_MEMORY_DIR`. If that is unset, ytsejam resolves the store from the normal data-dir rules.

The memory module is in-process under `server/src/memory/`. Its public surface is exported through `server/src/memory/index.ts`; callers should not do ad hoc file I/O against the memory store.

Agent-facing tools:

- file operations: `cog_read`, `cog_write`, `cog_append`, `cog_patch`, `cog_move`;
- discovery: `cog_outline`, `cog_search`, `cog_list`;
- envelopes: `cog_rpc` for `session_brief`, `housekeeping_scan`, `domain_summary`, `l0index`, `link_audit`, indexes, audits, and other consolidated reads.

The store auto-commits after every 10 successful memory mutations via the in-process commit hook. A startup flush also commits previously tracked dirty files when the server starts and the memory repo is in a safe git state.

There is no vector database here. There are no embeddings in the core memory path. That is by design.

The design enables a plain-text retrieval protocol:

1. L0 summaries identify relevant files.
2. L1 outlines identify relevant sections.
3. L2 reads pull sections or line ranges, not whole files, when possible.

That L0 → L1 → L2 protocol is the reason the file shapes below are strict.

### §1.2 Domains

A domain is a folder under the memory root.

Examples:

```text
personal/
work/
projects/
projects/ytsejam/
infra/
pkb/
cog-meta/
```

Domains are the routing layer. They let the agent decide which warm memory files matter for a conversation without reading the whole tree.

The domain manifest is `domains.yml` at the memory root. It declares domain `id`, storage `path`, `type`, `label`, `triggers`, `files`, and nested `subdomains`.

A typical entry is shaped like this:

```yaml
- id: ytsejam
  path: projects/ytsejam
  type: domain
  label: ytsejam
  triggers: [ytsejam, harness]
  files: [hot-memory, observations, action-items, entities]
```

Domain ids are globally unique, but **paths are the write targets**. If a domain id differs from its path, use the path in `cog_*` file operations.

Triggers are keywords that route conversation toward a domain. Good triggers are specific nouns and project names. Bad triggers are generic verbs that fire on half the user's life.

Typical files in a domain:

- `hot-memory.md` — active working set for that domain;
- `observations.md` — timestamped facts and events;
- `action-items.md` — open and recently completed tasks;
- `entities.md` — compact registry of durable nouns;
- `INDEX.md` — generated or curated map of what is in the domain.

Optional domain files include thread files, project artifacts such as `dev-log.md` or `architecture.md`, and domain-specific registries when the generic files are too blunt.

Nesting matters.

`projects/` is the parent domain. It holds cross-project context: comparative priorities, portfolio-level reminders, and facts that apply to multiple projects.

`projects/ytsejam/` is a child domain. It holds ytsejam-specific current state, implementation notes, design decisions, and project-local entities.

The child hot-memory should be specific. The parent hot-memory should be cross-cutting. If a fact belongs in the child, do not duplicate it in the parent; link to it.

### §1.3 Tiers — hot, warm, glacier

Memory has three retrieval tiers. They are context-budget controls.

**Hot** memory is the always-nearby working set.

- Path shape: `*/hot-memory.md`.
- Size target: at most 50 lines.
- Edit pattern: rewrite freely.
- Contents: active priorities, stable constraints, current state the agent must not miss.
- Anti-content: old audit history, resolved detail, anything better kept as an observation or wiki page.

Hot memory is not the archive.

**Warm** memory is the domain file layer.

Warm files include `observations.md`, `action-items.md`, `entities.md`, `INDEX.md`, thread files, and domain-specific artifacts.

Warm memory is read when a domain activates through triggers, when the user asks for it explicitly, or when a skill invokes it. It can be larger than hot memory because it is not injected into every conversation by default.

**Glacier** memory is the archive layer.

- Path root: `glacier/`.
- Files are read-only in normal use.
- Files use YAML frontmatter.
- The generated catalog is `glacier/index.md`.
- The catalog header is `# Glacier Index`, followed by table-style entries.

Glacier is where old observations, completed action slabs, historical decisions, and other audit material go when they stop belonging in the live working set.

The retrieval protocol is:

1. **L0 scan** — read one-line summaries to choose candidate files.
2. **L1 outline** — read headings from the candidate file.
3. **L2 read** — read a section or line range, not the whole file, when possible.

That is why ordinary domain markdown files start with:

```md
<!-- L0: one-line summary -->
```

The L0 comment is line 1 for canonical domain files. It is short enough to act as an index row. Wiki pages are the main exception: they use YAML frontmatter as their primary metadata.

### §1.4 File types

This section is the conceptual map of the file shapes. The exact allow-list and validation rules live in [docs/memory/FORMAT.md](memory/FORMAT.md).

#### `hot-memory.md`

Purpose: hold the always-nearby working set for a domain.

Format: line 1 is an L0 comment, followed by short markdown bullets or sections. Keep the whole file at or below 50 lines.

Edit pattern: rewrite freely. It is supposed to be current, compact, and shaped for the next conversation.

Gotcha: hot-memory is not a log. If you are preserving history, move the detail to `observations.md`, a thread file, a wiki page, or glacier.

#### `observations.md`

Purpose: append timestamped data points that may matter later.

Format: `- YYYY-MM-DD [tags]: text`.

Edit pattern: append only. Use `cog_append`, not whole-file rewrite.

Why append-only: observations are an audit trail. They retain temporal validity, including facts that were true when written but later became stale.

Gotcha: do not clean up old observations by editing them in place. Archive them through housekeeping or copy them into glacier as a historical slab.

#### `action-items.md`

Purpose: track open loops that the agent or user should not drop.

Format: `- [ ] task | due:YYYY-MM-DD | pri:high/med/low | added:YYYY-MM-DD`.

Completed items use `- [x]` or `- [X]`. A `done:YYYY-MM-DD` field may appear when useful.

Edit pattern: append new tasks, patch checkboxes when done. Do not rewrite the whole file to check off one item.

Gotcha: done items should not pile up forever. Housekeeping archives completed items when the done count crosses the cap.

#### `entities.md`

Purpose: keep compact registries of durable nouns: people, projects, tools, organizations, recurring systems, and relationships.

Format: at most three non-blank, non-comment lines per entity: `### Name (relationship)` / `fact one | fact two | [[wiki/optional-detail/index]]` / `status: active | last:YYYY-MM-DD`.

Edit pattern: edit in place. The registry should represent the current compact truth, not every historical detail.

Gotcha: if an entity needs more than three lines, move the narrative detail to a wiki page and link to it.

#### `INDEX.md`

Purpose: provide a map of a domain or generated collection.

Format: markdown headings, bullet lists, and links. Some indexes are generated; others are curated by hand.

Edit pattern: whole-file write is allowed for `*/INDEX.md` by the primitive store allow-list.

Gotcha: know whether an index is generated before polishing prose by hand. A generated index may be overwritten by housekeeping or an explicit index rebuild.

#### Thread files

Purpose: consolidate a recurring topic that has outgrown scattered observations but is not necessarily a wiki page yet.

Raise a thread when a topic appears in at least 3 observations across at least 2 weeks and the topic is likely to stay useful.

Format: a read-optimized spine such as Current State → Timeline → Insights. Current State can be rewritten. Timeline is append-oriented. Insights are curated.

Edit pattern: one file forever. Update and supersede inside the file rather than creating a new thread every time the topic changes.

Gotcha: a thread is synthesis, not a dumping ground. If it becomes long-form reference prose, promote the durable narrative to wiki and link back.

#### `cog-meta/patterns.md`

Purpose: store distilled, timeless operating patterns that should influence many future sessions.

Format: compact markdown, normally with an L0 header and promotion audit comments such as `<!-- promoted:YYYY-MM-DD theme:tag -->`.

Size target: at most 70 lines. This file is expensive because it is broadly loaded; it should stay ruthlessly small.

Edit pattern: edit in place or append/patch, depending on the change. Avoid whole-file churn unless the file is being deliberately curated.

Gotcha: project-specific rules do not belong here if they only matter inside one project. Put them in that project domain or a domain-specific pattern file if the memory system grows that tier.

#### Wiki pages (`wiki/**/index.md`)

Purpose: hold durable narrative synthesis: project pages, topic pages, people pages, research notes, tool evaluations, and ideas.

Format: YAML frontmatter followed by markdown body. Frontmatter carries metadata such as type/category, tags, status, dates, summary, and related pages.

Edit pattern: edit prose in place. Wiki pages are meant to evolve as the durable understanding improves.

Gotcha: a wiki page should have one canonical home. Do not fork the same concept into multiple pages because it is convenient in the moment.

### §1.5 Wiki

The wiki is the narrative tier: what observations grow up into after they stop being isolated data points and start being durable synthesis.

The layout is hierarchical:

```text
wiki/projects/<slug>/
wiki/topics/<slug>/
wiki/people/<name>/
wiki/research/<question>/
wiki/tools/<name>/
wiki/ideas/<seed>/
```

A normal page is `wiki/**/index.md`.

Each page has YAML frontmatter and a free-form markdown body. The frontmatter is for routing, indexing, and audit. The body is for narrative.

The generated wiki catalog is `wiki/index.md`. The reverse-link index is `link-index.md`, which tracks wiki-link references across memory so the agent can answer "what points here?" without scanning manually every time.

Use the tiers this way:

- **Observation** — a timestamped data point: something happened, was decided, was noticed, or was said.
- **Wiki page** — durable cross-cutting synthesis: the thing that remains useful after many observations are compressed.
- **Hot-memory** — current working set: what the agent must have near the front of mind for a domain right now.

A wiki page can cite observations, thread files, entities, or glacier entries. It should not copy every underlying line. Link to the source of truth when the detail belongs elsewhere.

### §1.6 SSOT and wiki-links

SSOT means Single Source of Truth.

The discipline is simple: each fact lives in exactly one file.

Other files reference that fact with wiki-links:

```md
[[domain-path/filename]]
[[projects/ytsejam/architecture]]
[[wiki/topics/harness-check/index]]
```

The purpose is maintenance. When a fact changes, you update one file and sweep references. You do not hunt five stale copies across hot memory, entities, threads, wiki, and glacier.

Stale duplicates are the number one memory bug. They are worse than missing facts because they create false confidence.

Temporal-validity comments help the agent and human reviewer know which facts are intentionally time-bound:

```md
<!-- until:YYYY-MM-DD grace:N -->
<!-- from:YYYY-MM-DD -->
```

Use `until` for facts that should be reviewed or removed after a date. Use `from` for facts that become active or stable from a date onward. Put the marker next to the line or section it qualifies.

When editing memory directly, ask this before duplicating anything: "where does this fact really live?"

If the answer is another file, link to that file. If no canonical home exists, create or choose one deliberately.

### §1.7 The pipeline — narrative

The pipeline is the operating cadence for keeping memory useful.

It is not a ritual. It is a way to keep the working set small, the audit trail intact, and the synthesis layer current.

**Day to day:** the agent writes memory as you work.

Typical day-to-day writes:

- append observations when something worth remembering happens;
- add action items when there is an open loop;
- check off action items when done;
- edit entity registries when compact facts change;
- update hot-memory when a domain's working set shifts.

The user's role day to day is mostly to read, correct, and surface important facts clearly. If a fact matters, say so. The agent can decide the file shape.

**Weekly:** run `/housekeeping` first.

Housekeeping cleans the substrate:

- archives observation logs that cross the live-entry threshold;
- prunes or archives completed action items;
- checks hot-memory files against the 50-line cap;
- sweeps stale temporal markers;
- rebuilds generated indexes such as glacier, wiki, and link indexes;
- surfaces dormant domains, stale action items, and format issues.

Then run `/reflect` in the same session.

Reflect mines patterns from the cleaned state. The same-session ordering matters: reflect should see the state housekeeping just produced, not a pre-cleanup view from another context.

The reflection pipeline has three gates:

1. **Cluster gate** — there must be enough signal, typically a cluster of at least 3 entries with enough date spread and specificity.
2. **Coverage gate** — skip the candidate if an existing pattern already covers it; replace only when the new synthesis clearly subsumes the old one.
3. **Synthesis gate** — promote one actionable line with an audit trail, not a vague essay.

**Monthly:** run `/evolve`.

Evolve audits the architecture of the memory system itself. It asks whether the current domains, tiers, caps, skills, and conventions still fit the way memory is being used. Treat it as architecture review, not normal cleanup.

**On demand:** use the focused skills.

- `/foresight` asks memory for a nudge about what deserves attention next.
- `/history` reconstructs a narrative from observations, wiki, and glacier.
- `/cog` creates or reshapes domains and related routing conventions.

**Burst caveat:** "The cadence assumes steady-state usage. When you're burning a lot of tokens — a deep multi-day push on one project, a research blitz, anything that's generating observations faster than usual — run `/housekeeping` + `/reflect` more often (every couple of days, or daily during a real burst). The signal is observation volume, not the calendar."

The anti-pattern is running every skill every day in a *normal week*. That is theatrical. It burns attention and creates churn without adding much signal.

The skill catalog — names, purposes, and invocation patterns — lives in [USAGE.md §2.5](USAGE.md#25-skills--the-catalog). This section narrates the cadence; the catalog names the tools.
