# AGENTS.md

This file is auto-loaded into agent context when working in this repo. Keep it short and link
into deeper docs rather than restating them here.

## Agent documentation

AI-facing docs for this repo live in `docs/agents/`. Start with
[`docs/agents/OVERVIEW.md`](docs/agents/OVERVIEW.md) — purpose, architecture, key patterns,
and configuration — and follow its links to subsystem docs. Read the relevant doc before
working in that area.

## Memory

The memory module lives at `server/src/memory/` — see
[`server/src/memory/README.md`](server/src/memory/README.md) for the public-surface
discipline. The on-disk format spec is at
[`docs/memory/FORMAT.md`](docs/memory/FORMAT.md).
- LTM embedder selection is via `YTSEJAM_LTM_EMBEDDER` (`auto`|`copilot`|`ollama`|`hash`). See [`docs/agents/memory-bridge.md`](docs/agents/memory-bridge.md) for the boot-time wiring, dimension-mismatch refusal, and the `ltm replay --rebuild` remediation.

## Skills

Skills are markdown playbooks loaded at runtime. Seeded skills live in `server/skills/`,
but running instances load the copy in `<dataDir>/skills/` (prod:
`~/.ytsejam/data/skills/`). Seeding is copy-if-missing, so editing a seed does **not**
update an existing live copy. Read [`docs/agents/skills.md`](docs/agents/skills.md)
before changing skills, and use the documented drift/sync flow instead of manually
editing live seeded copies.

## Other doc directories

- `docs/plans/` — implementation plans (one per feature, dated). Read the current plan
  before touching code in its scope.
- `docs/superpowers/` — long-form specs and historical plans from the initial build phases.
- `docs/audit/` — third-party model audit reports of the codebase.
- `docs/bugs/` — open bug investigations.

## Quality gate

Before opening any PR run `bash scripts/gate.sh`. It must pass — there is no CI; this script
is the bar.
