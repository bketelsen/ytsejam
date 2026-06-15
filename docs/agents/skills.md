# Skills

> Sub-doc of [`OVERVIEW.md`](OVERVIEW.md). Read this before adding a skill or changing skill
> discovery. Code: `server/src/skills.ts`, `server/src/tools/skills.ts`. Seed skills:
> `server/skills/`.

## What a skill is

A skill is a **markdown playbook** the assistant loads on demand and follows step by step. Skills
encode workflows ("how to run the weekly memory consolidation", "how to create a quality gate") as
prose + checklists, not code. The assistant doesn't improvise these workflows from memory — when a
skill matches, it loads the playbook and executes it.

### The north-star bias: skills are cheap, server code is expensive

Prefer a skill over server code whenever the behavior can be expressed as "call these existing tools
in this order, with this judgement." Skills are plain markdown: no typecheck, no tests, no deploy, no
gate — edit the file and it's live (subject to the seeding rules below). Server code is the opposite:
every change pays the full quality gate and a deploy. The recent dev-workflow skill port
(`docs/plans/2026-06-12-norma-skills-port.md`) is explicit that its output is "markdown skill bundles
… no ytsejam server code." When you're tempted to add a tool or a server feature, first ask whether a
skill over the *existing* tools does the job.

## Discovery: seeded vs user, and precedence

`SkillsStore` (constructed against `<dataDir>/skills`) is the runtime store. Skills come from two
places:

1. **Seeded** — committed in the repo at `server/skills/*.md` (and `<name>/SKILL.md` bundles). On
   boot, `index.ts` calls `skills.seed(<repo>/skills)`, which **copies each seed into the data dir
   only if it does not already exist** (`COPYFILE_EXCL` for flat files; copy-the-whole-dir-if-absent
   for bundles). Seeding never blocks boot — a failure is logged and ignored.
2. **User** — anything the user (or the agent at runtime, e.g. the `/cog` skill generating per-domain
   skills) writes into `<dataDir>/skills/`. In prod that's `~/.ytsejam/data/skills/`.

Because seeding is **copy-if-missing**, the user/data-dir copy *wins*: editing a seed file in the repo
does **not** change a running instance whose data dir already has that skill. To update a live skill
you must edit the copy in the data dir (or remove it so the next boot re-seeds). The seed
`server/skills/UPSTREAM` note spells this out for the cog-pipeline skills, whose canonical source is
the cogmemory repo.

## File layout (two supported shapes)

Both at the top level of the skills dir:

1. **Flat:** `<name>.md` → skill named `<name>`.
2. **Directory bundle:** `<name>/SKILL.md` → skill named `<name>`; sibling files in that directory
   (`reference.md`, scripts, etc.) are bundled assets, **not** skills, and are never listed or loaded
   as skills. This matches the Agent Skills convention pi-coding-agent consumes.

**Collision policy:** if both `<name>.md` and `<name>/SKILL.md` exist, the **flat file wins** and a
`console.warn` is emitted so the operator can clean it up.

Files without a `.md` extension are ignored as skills (that's why the `UPSTREAM` note file has no
extension).

## Skill file structure

A skill is YAML frontmatter + a markdown body:

```markdown
---
name: create-gate
description: Create a gate script for a project — reads CI config, proposes a script, writes it...
triggers: [create gate, gate script, add a gate, set up the gate, gate.sh]
---

# Creating Gate Scripts

## Overview
...
```

Frontmatter parsing lives in `parseSummary` (`skills.ts`) — it is a small hand-rolled parser, **not a
full YAML library**, so keep frontmatter simple:

- `name:` — invocation name. Defaults to the filename stem if omitted. Must be slash-free.
- `description:` — one-line purpose. Supports a folded block scalar (`description: >` with indented
  continuation lines). If omitted, the first non-heading body line (≤120 chars) is used.
- `triggers:` — comma-separated keywords (bracketed `[a, b]` or bare). These populate the "invoke
  when" column of the system-prompt skills table.

## How a skill is invoked at runtime

1. **Routing table in the system prompt.** `SkillsStore.promptSection()` renders a `## Skills`
   markdown table (skill name · purpose · invoke-when) into every session's system prompt
   (`composeSystemPrompt` in `persona.ts`). The "invoke when" cell is built from `triggers`. Empty
   string when no skills exist (the section is omitted). This is how the model *knows* a skill exists
   without loading it.
2. **The model calls `skill("name")`.** The `skill` tool (`tools/skills.ts`) calls
   `SkillsStore.load(name)`, which returns the full playbook text as the tool result. The model then
   follows the playbook.

`load(name)` is hardened against path traversal: it rejects any name containing `/`, `\`, `..`, a
leading `.`, or an absolute path, tries the flat path then the bundle path, and verifies via
`fs.realpath` that the resolved file stays inside the skills dir (so a symlink can't escape).

## Seeded skills (current set, `server/skills/`)

These are the cog memory-pipeline skills plus `create-gate`:

| Skill | Purpose |
| --- | --- |
| `cog` | Bootstrap/reconfigure cog memory domains (first-time setup; adds per-domain generated skills). |
| `reflect` | Mine recent activity for patterns and consolidate memory (3-gate pipeline). |
| `housekeeping` | Memory maintenance — archive, prune, temporal sweep, rebuild indexes. |
| `evolve` | Monthly architecture audit of the memory system. |
| `foresight` | Cross-domain strategic scan → one forward-looking nudge. |
| `history` | Deep memory search / narrative reconstruction across observations + glacier. |
| `create-gate` | Bootstrap a `scripts/gate.sh` for a project and record it in cog hot memory. |
| `cron-pull-weeds` | Cron-driven weed pulling for ytsejam. Files+gates only — never merges. Wraps `/pull-weeds` Phase 1-4 with cron-specific safety rules for unsupervised operation. |

The cog-pipeline skills' canonical source is the cogmemory repo (`docs/llm/skills/`), vendored here
with ytsejam host-adaptations; see `server/skills/UPSTREAM`. User dev-workflow skills (`develop`,
`ship`, `brainstorm`, etc.) are installed as **user** bundles under `~/.ytsejam/data/skills/<name>/`,
not seeded — see `docs/plans/2026-06-12-norma-skills-port.md`.

## Adding a skill — checklist

- **User/personal workflow?** Write `~/.ytsejam/data/skills/<name>.md` (or `<name>/SKILL.md`). It's
  live immediately. No gate, no deploy.
- **Should ship with the product (a ytsejam-own pipeline skill)?** Add it to `server/skills/`. Note
  the copy-if-missing seeding: a running instance with an existing data-dir copy won't pick up your
  edit until that copy is removed. Update the data-dir copy too if iterating on a live instance.
- Always include `name`, `description`, and `triggers`. Keep frontmatter to flat `key: value` lines
  (the parser is minimal).
- Start the body with an "Announce at start" line and a clear step sequence — see `create-gate.md`
  as the model.

## Drift gate (deploy-time)

The COPYFILE_EXCL seeding rule (see [Discovery: seeded vs user, and precedence](#discovery-seeded-vs-user-and-precedence)) means a PR that updates a seeded skill (e.g. `server/skills/reflect.md`) does NOT update the live copy at `~/.ytsejam/data/skills/reflect.md` if the live file already exists. Without a check, the new behavior never reaches the runtime and the release silently "activates" stale code.

`deploy/deploy.sh` runs `scripts/check-skills-drift.sh` between the release build and the symlink swap. If any seeded `<name>.md` differs from its live counterpart, the deploy aborts with a `diff -u` excerpt per drifted file. The check is read-only — an abort throws away only the prepared (un-activated) release dir; the live tree is never touched.

To resolve drift before deploying:

```bash
bash deploy/sync-skills.sh           # dry-run: list what would change
bash deploy/sync-skills.sh --yes     # apply: copy seeds over drifted live files
```

`sync-skills.sh` only touches seeded names. Generated domain-routing skills (written by `/cog setup` to the live dir only) and user dir-bundles (e.g. `brainstorm/SKILL.md`) are never compared and never copied — they have no seed counterpart.

To override the gate without resolving the drift (e.g. when the live divergence is intentional and the operator accepts the risk):

```bash
ALLOW_SKILL_DRIFT=1 bash deploy/deploy.sh
```

This is rare and should be justified in a commit message or follow-up note. The override applies ONLY to content drift; structural errors from the check script (missing dirs, bad args) still abort the deploy.
