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

Format: at most three non-blank, non-comment lines per entity: `### Name (relationship)` / `fact one | fact two | [[wiki/optional-detail]]` / `status: active | last:YYYY-MM-DD`.

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
[[wiki/topics/harness-check]]
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


## Part 2 — Cookbook

Each entry below is a verb-phrase task. The body is steps + rationale + links back to the concepts in Part 1. Skim the headings; read the body when you need to do that task.

### §2.1 Day-to-day tasks

Use these for ordinary memory interaction: capture, patch, look up, recover, and refresh. The common path is conversational; direct file edits are for precision.

#### §2.1.1 Surface a fact you want remembered

Tell the agent plainly: "remember that..." or "log this as an observation in [domain]." The agent picks the domain from `domains.yml` triggers; you can override with a path when you know the canonical home.

How:
1. Give the fact, and optionally the domain and file type.
2. Use observations for dated events, entities/wiki for durable nouns, and hot-memory for current working-set truths.
3. Let the agent write through `cog_append` or `cog_patch`.

Example: "log in personal/observations: kid's piano recital moved to June 21" should append `- 2026-06-13 [kids piano]: piano recital moved to June 21` to `personal/observations.md`. That preserves date, tags, and audit shape; see [§1.4](#14-file-types).

#### §2.1.2 Check off an action item

Ask the agent to check off the item, or patch the checkbox yourself. The edit is exactly `- [ ]` → `- [x]`, optionally adding `done:YYYY-MM-DD` if that convention is already present.

How:
1. Say: "check off task N in personal/action-items."
2. Or patch the exact line in `action-items.md`.
3. Do not rewrite the whole file to complete one item.

Why: `action-items.md` relies on line stability for `cog_patch`. Whole-file rewrites create churn and can race with other edits; `/housekeeping` will archive completed slabs later.

#### §2.1.3 See what's in hot-memory right now

Hot-memory is the current working set for a domain. Ask the agent to show it, or open the file directly.

How:
1. Ask: "show me ytsejam hot-memory."
2. Or open `~/.ytsejam/data/memory/projects/ytsejam/hot-memory.md`.
3. Refresh your read after `/housekeeping` or a reflect pass that rewrote hot-memory.

Why: hot-memory is capped around 50 lines and should hold current priorities, constraints, and must-know cross-session facts. It is not a log; old material belongs in observations, threads, wiki, or glacier.

#### §2.1.4 Find when something happened

Use `/history` for narrative reconstruction; use `cog_search` for remembered wording. Pick the tool by query shape.

How:
1. Ask `/history`: "what happened with Y in May?" or "show me the arc of Z."
2. Ask for `cog_search` when you remember a phrase but not the date.
3. Follow the ranked hits and file paths into observations, entities, action items, hot-memory, or glacier.

Why: `/history` reads across observations and glacier to reconstruct a timeline. `cog_search` is faster for phrase lookup because it returns ranked snippets plus source paths.

#### §2.1.5 See what the agent knows about a person/project/tool

Look in the wiki tier for consolidated knowledge. That is the right lookup target for "what do we know about X?"

How:
1. Ask the agent to `cog_search` the name.
2. Or browse `wiki/people/`, `wiki/projects/`, and `wiki/tools/` directly.
3. Follow compact entity links such as `[[wiki/people/liam]]` when they exist.

Why: `entities.md` is a small registry; wiki pages are the narrative home for durable knowledge. If only observations exist, the topic may not yet have earned a page.

#### §2.1.6 Add a note that doesn't fit any domain

Capture first; refine routing later. A misc note is better than a lost fact.

How:
1. Default personal-life miscellany to `personal/observations.md`.
2. Default knowledge-base miscellany to `pkb/observations.md`.
3. If you capture 3+ similar notes, run `/cog` and make the topic a domain or subdomain.

Why: one stray note does not justify structure. Repeated notes are evidence that the topic has become a real routing path, as described in [§1.2](#12-domains).

#### §2.1.7 Recover an archived note

Glacier is read-only in normal use. Recover by copying from glacier back into live memory.

How:
1. Read `glacier/index.md` to find the relevant slab.
2. Read the matching `glacier/<domain>/...` file.
3. Copy the line or synthesis you need into a live file: observations, thread, entity, hot-memory, or wiki.

Why: glacier frontmatter carries `date_range`, `entries`, tags, and summary. Editing the slab in place makes the metadata false and breaks the audit trail.

#### §2.1.8 Rebuild generated indexes

Rebuild indexes after manual edits to many files, wiki import work, glacier recovery, or link refactors. The normal path is `/housekeeping`.

How:
1. Run `/housekeeping` for the full pass.
2. For targeted rebuilds, ask the agent to call `cog_rpc("glacier_index_compute")`, `cog_rpc("wiki_index_compute")`, or `cog_rpc("link_index_compute")`.
3. Let the generated `glacier/index.md`, `wiki/index.md`, and `link-index.md` reflect source files.

Why: generated indexes are navigation surfaces. Hand-polishing them creates drift unless you are deliberately editing a curated, non-generated index.

### §2.2 Weekly maintenance

The weekly pair is cleanup followed by synthesis. Run it in one session so the agent carries housekeeping findings into reflect.

#### §2.2.1 Run the weekly cadence properly

Run `/housekeeping` first, ideally in a fresh session. Then run `/reflect` in the same session; reflect needs to see the cleaned state.

How:
1. Start a focused memory-maintenance session.
2. Invoke `/housekeeping` and let it archive, prune, sweep temporal markers, and rebuild indexes.
3. Invoke `/reflect` before leaving the session.

Why: housekeeping cleans substrate; reflect mines patterns, spikes, and thread candidates from that substrate. If you're in a heavy work burst, drop the "weekly" frame and run on volume — see [§1.7](#17-the-pipeline--narrative) for the full caveat and the canonical signal.

#### §2.2.2 Read the reflect output

Reflect output is the review surface for what entered, skipped, or changed in memory. Read the debrief before trusting the new state.

What to check:
1. Promoted patterns in `cog-meta/patterns.md` or a domain `patterns.md`.
2. Dropped candidates that failed the gates.
3. Replacements where a new line subsumed an older pattern.
4. Thread candidates and hot-memory changes.

The three gates: cluster (≥3 entries, ≥7 day span, ≥3 distinct dates, specific tag); coverage (skip if an existing pattern covers it, replace when the new one subsumes old); synthesis (one actionable line plus `<!-- promoted:YYYY-MM-DD theme:tag -->`). Weak patterns bias future sessions, so skipped candidates are often correct.

#### §2.2.3 Handle a heating topic (spike)

A spike is a hot topic, not a pattern. The threshold is ≥5 entries in <7 days: enough to notice, too compressed to pass the date-span gate.

How:
1. Treat it as a thread candidate.
2. Check whether a thread or wiki page already exists.
3. If not, raise a thread with Current State → Timeline → Insights.
4. Let `/reflect` propose this through spike-handling, or author it manually.

Why: threads can hold fast-moving synthesis without pretending the lesson is timeless. If the topic becomes durable, promote the stable narrative to wiki later.

### §2.3 Monthly + on-demand

Use these when you need architecture review, a nudge, a history reconstruction, or structured audit data. They are focused tools, not daily rituals.

#### §2.3.1 Run `/evolve` and act on the scorecard

Run `/evolve` monthly after enough housekeeping and reflect history exists. It audits the memory system itself: domains, tiers, caps, indexes, patterns, routing, and process drift.

How:
1. Invoke `/evolve`.
2. Read `cog-meta/scorecard.md` and any `[evolve]` action items.
3. Follow recommendations when metrics are well above threshold and the fix is structural.
4. Defer cosmetic flags during a heavy work week when retrieval still works.

Why: evolve is architecture review. Its value is turning threshold breaches into routed actions, such as compressing entities, pruning pattern files, rebuilding stale indexes, or splitting a bloated domain.

#### §2.3.2 Run `/foresight` for a nudge

Run `/foresight` when you want one forward-looking prompt from memory. It writes a single nudge, not a backlog.

When:
1. Start of a new week.
2. When you feel stuck.
3. After a domain shift or a project becoming active again.

How to use it: read `cog-meta/foresight-nudge.md`, then act, discard, or convert the suggested action into an action item. The nudge should have Signal → Insight → Suggested Action and cite sources.

#### §2.3.3 Run `/history` for a question

Use `/history` for questions that need past-facing reconstruction across files. Phrase the question as the timeline you want.

Good prompts:
- "when did I first run X?"
- "what happened with Y in May?"
- "show me the arc of Z."
- "what did we decide about the migration?"

The skill searches observations and glacier, with entity, action-item, hot-memory, and `cog_search` support when useful. It is read-only; if it finds a gap, it flags the gap rather than writing.

#### §2.3.4 Audit memory health

Use `cog_rpc` audit methods after large refactors, before migrations, or when you want structured evidence before editing.

Useful calls:
- `cog_rpc("link_audit")` returns missing-link candidates and cross-reference opportunities.
- `cog_rpc("entity_audit")` returns entity format violations, stale temporal markers, glacier candidates, and missing metadata.
- `cog_rpc("cluster_check")` returns recurring observation clusters and thread candidates.
- `cog_rpc("scenario_check")` returns scenario files that are due, overdue, or active.

Each returns a structured envelope you can read directly or ask the agent to summarize. The envelope finds candidates; you still decide which edits are correct.

### §2.4 Customizing your memory

Customize memory when the current shape no longer matches how you talk or work. Add structure when repetition proves it, promote synthesis when it becomes durable, and refactor when routing itself causes drift.

#### §2.4.1 Add a new domain

Run `/cog` when a recurring topic deserves its own routing path. It edits `domains.yml`, creates the domain folder, generates a router skill, and can seed starter files.

How:
1. Tell the agent the topic and what kind of memory it needs.
2. Let `/cog` preserve existing manifest entries while adding the new one.
3. Confirm the folder path, starter files, and generated skill.

Pick triggers that are specific nouns you actually say: project names, people, organizations, tools, or topic names. Avoid generic verbs such as "write", "fix", "plan", or "think"; they route too broadly.

#### §2.4.2 Customize hot-memory for a domain

Edit hot-memory when the domain's always-nearby context changes. Keep it under 50 lines or it gets pruned.

Belongs:
- Cross-session truths.
- Active priorities and constraints.
- Things the agent must always know about this domain.

Does not belong:
- Transient events; put those in observations.
- Durable facts about specific entities; put those in entities or wiki.
- Resolved audit history; put that in observations, threads, wiki, or glacier.

Why: hot-memory is orientation, not storage. Link to canonical sources instead of duplicating full detail.

#### §2.4.3 Promote an observation to a pattern

Normally `/reflect` promotes patterns through the three gates. Manual promotion is for a clear, high-confidence rule that would not pass the cluster gate yet.

How:
1. Edit `cog-meta/patterns.md` or a domain `patterns.md`.
2. Add one actionable, timeless line.
3. Include `<!-- promoted:YYYY-MM-DD theme:tag -->`.
4. Replace any older pattern the new line subsumes.

Use this sparingly: pattern files shape many future sessions. A one-off user preference or proven operational rule may qualify; ordinary event notes do not.

#### §2.4.4 Promote a cluster to a thread file

Raise a thread when a topic has ≥3 observations across ≥2 weeks and feels important enough to consolidate. Threads are synthesis between observations and wiki.

How:
1. Create one canonical file in the relevant domain.
2. Use Current State → Timeline → Insights.
3. Rewrite Current State freely, append to Timeline, curate Insights.
4. Link to source observations, entities, wiki pages, or glacier slabs.

Rule: one file forever. Never delete the thread because the state changed; supersede inside the file.

#### §2.4.5 Promote a durable fact to a wiki page

Create or update a wiki page when a recurring person, project, tool, topic, idea, or research question earns its own narrative home.

How:
1. Pick `wiki/people/`, `wiki/projects/`, `wiki/tools/`, `wiki/topics/`, `wiki/research/`, or `wiki/ideas/`.
2. Create `wiki/<subtree>/<slug>/index.md`.
3. Link to it as `[[wiki/<subtree>/<slug>]]`, without `/index` in the link text.
4. Use frontmatter such as `title:`, `entity_type:` (matches the subtree — `person`, `project`, `tool`, `topic`, `research`, `ideas`), `status:`, `tags:`, and `updated:` (the only date field — see [docs/memory/WIKI-TIER.md](memory/WIKI-TIER.md) for the full schema).

Why: observations are dated facts; wiki pages are editable synthesis. The page becomes the canonical home other files point at.

#### §2.4.6 Refactor a domain

Refactor when routing no longer matches reality. Move the canonical home, update the manifest, then sweep links.

Splitting: create a child domain when a project graduates from "mentioned in `projects/`" to "has its own subdomain," such as `projects/myapp/`. Keep child facts in the child and portfolio context in the parent.

Merging: merge when two domains collapsed in practice. Pick the surviving path, preserve historical observations, and avoid rewriting old dates to fit the new structure.

Renaming:
1. Update `domains.yml` for id, path, label, and triggers.
2. Move files carefully with `cog_move` or an explicit migration.
3. Sweep wiki-links repo-wide with `grep -r '\[\['` and patch references.
4. Rebuild indexes with `/housekeeping` or targeted index RPCs.

Why: domains drive routing. A stale domain shape means the agent loads stale or irrelevant memory, and a rename is incomplete until links point to the new canonical home.

### §2.5 Wiki-specific

Use the wiki tier when a noun needs durable narrative: a person, project, tool, topic, idea, organization, or research question with more than a compact registry can hold. Wiki pages are edited synthesis, not logs.

#### §2.5.1 Create a wiki page

Create a page when the noun has become a canonical reference point. The page path is always `wiki/<subtree>/<slug>/index.md`.

How:
1. Choose the subtree that names the kind of noun, such as `people`, `projects`, `tools`, `topics`, `research`, or `ideas`.
2. Create `wiki/<subtree>/<slug>/index.md`.
3. Use the frontmatter template and validation vocabulary in [docs/memory/WIKI-TIER.md](memory/WIKI-TIER.md); that document is the schema source of truth.
4. Start the body with a lead paragraph that says what this page is and why it exists.
5. Add stable sections such as `## Background`, `## Status`, `## Related`, `## Open questions`, or domain-specific equivalents.

Boundary rule: observations are timestamped data points. Wiki pages are durable narrative for a single noun. Hot-memory is the active working set for a domain. If a sentence is a dated event, append an observation; if it is a compact current fact, update an entity; if it is the story of the noun, write the wiki page.

#### §2.5.2 Cross-link with wiki-links

Use wiki-links to make the canonical home discoverable without duplicating the fact. Link to the page, not to its filesystem implementation detail.

Syntax:
- Wiki pages: `[[wiki/<subtree>/<slug>]]`
- Non-wiki memory files: `[[domain-path/filename]]`
- Do not include `/index` in wiki link text.

The reverse-link index at `link-index.md` tells you what references a given file. It is generated from `[[...]]` links, so the work you do once becomes navigable from both directions after the index rebuilds.

Useful pattern: after writing a new wiki page, run `grep -r '<noun-phrase>' ~/.ytsejam/data/memory/` and patch the important mentions to link to it. Prioritize current hot-memory, entity registries, thread files, and recent observations; leave historical append-only lines alone unless the missing link creates real retrieval confusion.

#### §2.5.3 Rebuild the wiki index

Rebuild the wiki index after creating or importing multiple wiki pages, after changing frontmatter across pages, or after a wiki refactor. Single-page edits can usually wait for housekeeping.

How:
1. Run `cog_rpc("wiki_index_compute")` for the deterministic page catalog.
2. Render or let the tool render the generated table.
3. Write the result to `wiki/index.md`.
4. Or run `/housekeeping`, which handles index rebuilds as part of maintenance.

Why: `wiki/index.md` is the L0 catalog for the narrative tier. It lets agents decide whether a page is relevant before reading long prose, and it prevents the old failure mode where a wiki exists but no one can route to it.

### §2.6 Editing memory directly

Direct edits are allowed because memory is plain markdown, but each file shape has a different safety rule. When in doubt, preserve audit trails and patch the smallest stable text that proves the edit.

#### §2.6.1 Match the edit to the file shape

Use the file's edit pattern, not your preferred editor habit. The Appendix has the canonical bare table; this table adds the reason for in-flow lookup.

| File | Pattern | Why |
| --- | --- | --- |
| `hot-memory.md` | rewrite freely | ≤50 lines, no historical preservation needed |
| `INDEX.md` (generated) | rewrite freely | regenerated by tools anyway |
| `observations.md` | append only | audit trail + temporal validity |
| `entities.md` | edit in place | compact registry, 3-line max per entity |
| `cog-meta/patterns.md` | edit in place | distilled timeless rules; ≤70 lines |
| `action-items.md` | patch checkboxes | line stability matters for `cog_patch` |
| `glacier/**` | read only | YAML frontmatter + archival audit trail |

Safe defaults:
1. For current state, edit the current-state file.
2. For dated facts, append a new dated line.
3. For done work, patch the checkbox and add `done:` if useful.
4. For archive files, create a new glacier slab through housekeeping-style archival instead of rewriting old slabs.

Why: the tools depend on stable shapes. A whole-file rewrite of observations destroys temporal discipline; a tiny patch to action-items preserves line identity; a hot-memory rewrite is fine because hot-memory is supposed to be the current working set.

#### §2.6.2 Trust the auto-commit cadence

Memory commits itself. The cadence is `auto: 10 memory writes`, plus a startup flush that commits tracked dirty files when the server starts in a safe git state.

Direct edits ride along with the next memory commit if they are in the memory repo. Nothing special is required after a normal edit; the cadence is designed to make markdown editing safe without turning every small patch into a manual git ritual.

The git repo lives at:

```text
~/.ytsejam/data/memory/.git/
```

To inspect history, run git inside the memory root:

```bash
cd ~/.ytsejam/data/memory
git log --oneline --stat
```

Manual commits are safe when you are doing a deliberate migration, but they are usually unnecessary. Let the cadence handle ordinary memory writes.

#### §2.6.3 Resolve a stale fact

When a fact changes, do not only update the file you happened to notice. Staleness often survives one tier away from the obvious source.

Sweep pattern:
1. Pick the phrase or noun that changed.
2. Run `grep -r 'phrase' ~/.ytsejam/data/memory/`.
3. Find every `hot-memory.md` that mentions it.
4. Update the hot line, remove it, or replace it with a link to the source of truth.
5. Check entity registries, thread files, action items, and wiki pages for the same stale wording.

Why: single-level checks miss tier-2 staleness. That is the common memory bug captured in `cog-meta/patterns.md`: a fact is corrected in the obvious file but remains wrong in a parent domain, child domain, or compact registry.

General rule: a fact changing in domain X is a search opportunity in domain X, its parents, its children, and the entity registries that name the same noun. Prefer one corrected source of truth plus links over multiple rewritten copies.

### §2.7 Troubleshooting + recovery

Most memory failures are routing, tiering, or stale-source failures. Diagnose from the outside in: search first, then check archives, then check routing, then check whether the fact was ever written.

#### §2.7.1 Diagnose "The agent doesn't remember X"

Use a ladder rather than guessing. The question is first whether the fact exists, then whether the agent loaded the right path.

Diagnostic ladder:
1. Was it ever written? Run `cog_search` for the exact phrase and a nearby synonym.
2. Is it in glacier? Check `glacier/<domain>/...` files and `glacier/index.md`.
3. Was it in a domain that did not trigger? Check `domains.yml` triggers and consider widening specific nouns.
4. Would an explicit skill load it? Run the domain skill directly, such as `/personal`, `/work`, or the project-specific skill.
5. Did SSOT discipline mean it is linked, not duplicated, from where you looked? Follow the `[[...]]` link.
6. If nothing turns up, it was probably never written.

Recovery: surface the missing fact plainly and ask the agent to log it in the right place. Do not invent a memory record from vibes; write the new fact with its current date and appropriate tier.

#### §2.7.2 Trim hot-memory over 50 lines

A hot-memory file over 50 lines is not a bigger brain; it is a routing tax. It makes every triggered session carry stale or low-signal context.

What to do:
1. Run `/housekeeping` and let the scan identify `hot-memory.md` files over cap.
2. Or manually rewrite the file to fit under 50 lines.
3. Move stale durable material to entities or wiki.
4. Move old dated events to observations or glacier.
5. Collapse multi-line items into one decisive line with a link.

Keep active priorities, cross-session truths, currently relevant constraints, and facts the agent must see before it reads warm memory. Cut resolved issues, temporary status, stale focus notes, and anything whose only value is historical.

Anti-pattern: keeping a "current focus" item that has not been current for two weeks. If it matters as history, append an observation; if it does not, remove it.

#### §2.7.3 Archive done action items

A long tail of completed checkboxes makes action-items harder to scan and harder to patch. Done items still matter as audit history, so archive them rather than deleting them.

Automatic route: `/housekeeping` archives completed action items when a file has more than 10 done items. It moves the done lines into `glacier/<domain>/action-items-done.md` and patches the live file.

Manual route:
1. Cut the `- [x]` lines from `action-items.md`.
2. Create or append `glacier/<domain>/action-items-done.md`.
3. Include YAML frontmatter with `date_range`, `entries`, and `summary`, plus the other glacier fields described in [docs/memory/FORMAT.md](memory/FORMAT.md).
4. Patch `action-items.md` so only open and recent relevant items remain.
5. Rebuild the glacier index with `/housekeeping` or `cog_rpc("glacier_index_compute")`.

Why: audit-trail discipline matters even for completed work. The live file stays useful, and the historical proof remains searchable through glacier.

## Appendix — Quick reference

### File edit patterns

| File | Pattern |
| --- | --- |
| `hot-memory.md` | rewrite freely |
| `observations.md` | append only |
| `action-items.md` | patch (check off done items) |
| `entities.md` | edit in place (3-line max) |
| `cog-meta/patterns.md` | edit in place (≤70 lines) |
| Thread files | Current State: rewrite / Timeline: append |
| `glacier/**` | read only |

### Glacier thresholds

- Observations >50 → archive oldest to `glacier/{domain-path}/observations-{tag}.md`.
- Action-items >10 done → archive to `glacier/{domain-path}/action-items-done.md`.

### Consolidation gates

- Cluster: ≥3 entries / ≥7d / ≥3 distinct dates / specific tag.
- Coverage: skip or REPLACE.
- Synthesis: one actionable line + `<!-- promoted:YYYY-MM-DD theme:tag -->` audit trail.

### Pipeline cadence

- Weekly: `/housekeeping` then `/reflect` same session.
- Monthly: `/evolve`.
- On demand: `/foresight`, `/history`.
- Burst: signal = observation volume, not the calendar; drop the weekly frame and run on volume — see [§1.7](#17-the-pipeline--narrative).

### Pointers

- Skill catalog → [USAGE.md §2.5](USAGE.md#25-skills--the-catalog).
- Implementer-level format → [docs/memory/FORMAT.md](memory/FORMAT.md).
- Wiki tier schema → [docs/memory/WIKI-TIER.md](memory/WIKI-TIER.md).
