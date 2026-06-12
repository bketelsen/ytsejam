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

## Other doc directories

- `docs/plans/` — implementation plans (one per feature, dated). Read the current plan
  before touching code in its scope.
- `docs/superpowers/` — long-form specs and historical plans from the initial build phases.
- `docs/audit/` — third-party model audit reports of the codebase.
- `docs/bugs/` — open bug investigations.

## Quality gate

Before opening any PR run `bash scripts/gate.sh`. It must pass — there is no CI; this script
is the bar.
