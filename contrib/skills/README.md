# Contrib skills

A curated snapshot of the skill playbooks Brian uses with ytsejam, dropped
here as portable examples for others running ytsejam (or any compatible
skill-loading harness).

These are **reference copies**, not the live source — the live skills load
from `~/.ytsejam/data/skills/`. Copy what you want into your own data dir.

## What's in here

General-purpose skill playbooks that aren't already shipped elsewhere in
the repo:

- **Authoring** — `write-a-skill`, `write-plan`, `brainstorm`
- **Dev loop** — `develop`, `review`, `ship`, `lessons`
- **Maintenance** — `find-weeds`, `pull-weeds`, `maintain-docs`
- **Research** — `pkb-research`
- **Browser** — `agent-browser`

## What's intentionally NOT here

- **Already seeded by the server** — `cog`, `reflect`, `housekeeping`,
  `evolve`, `foresight`, `history`, `create-gate` live in
  [`server/skills/`](../../server/skills/) and are vendored from the
  upstream cogmemory repo. See `server/skills/UPSTREAM` for the update
  protocol.
- **Domain-routing skills** (`infra`, `personal`, `pkb`, `projects`,
  `ytsejam`, `truenas-mcp`, `work`) — these are generated per-user by the
  `cog` skill against your own domain manifest. Run `/cog` to produce
  yours; don't copy mine.
- **Brian-specific OS skills** (`snow-nbc`, `snow-updex`) — these only
  make sense on snowloaded Snow Linux workstations.

## Format

Skills are either a single `<name>.md` file or a directory bundle with
`<name>/SKILL.md` plus optional siblings (`REFERENCE.md`, role prompts,
templates). Both forms work; bundles are preferred when a skill needs
helpers.

See `write-a-skill/SKILL.md` for the authoring conventions.
