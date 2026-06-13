# Memory module

## Purpose

`server/src/memory/` is the in-process memory module for ytsejam. It replaces
the cogmemory daemon, folded into ytsejam on 2026-06-12 per
`docs/plans/2026-06-12-fold-cogmemory.md`.

## Public surface

Every memory operation flows through `server/src/memory/index.ts`. Nothing
outside `server/src/memory/` does direct file I/O against the memory store.
Callers use the public functions and types exported from `index.ts`; internal
subdirectories stay private implementation detail.

## The discipline grep

This command must return zero lines:

```sh
grep -rn "memory_root\|ytsejam/data/memory\|chapterhouse/memory" server/src | grep -v "^server/src/memory/"
```

That invariant preserves the "extract to npm package on day N+1" property.

## Internal structure

- `index.ts` — public surface. Re-exports every callable.
- `types.ts` — shared types (`OkResult`, `WriteResult`, manifest types, etc.).
- `store/` — primitive I/O (`read`, `write`, `append`, `patch`, `move`, `list`,
  `search`, `stats`, `outline`, `walk`, `health`, `git`) plus the
  auto-commit hook (`auto-commit.ts`). Path validation and the whole-file
  write allow-list live in `store/paths.ts`.
- `domain/` — manifest loading, controller path validation, domain-id rejection.
- `consolidated/` — RPC-equivalent envelopes (`sessionBrief`,
  `housekeepingScan`, audits, indexes, and summaries).
- `bridge/` — cog↔LTM bridge helpers (`ltm-observer.ts`: observation-line
  parser + content-addressed origin + best-effort `mirrorToLtm`). Used by
  `recordObservation()` / `attachLtm()` on the public surface to mirror
  cog observation writes into LTM as `kind: "observation"` records.
- `server/test/memory/` — memory module tests.

## Auto-commit cadence

The memory store auto-commits its git repo every 10 writes
(`store/auto-commit.ts`, constant `AUTO_COMMIT_EVERY`). The cadence counter
is in-process and resets to zero on every process restart — it survives
nothing. Each successful call to `write` / `append` / `patch` / `move`
invokes `maybeAutoCommit()` AFTER the on-disk mutation, so a rejected
mutation never bumps the counter.

Commit messages are prefixed `auto:`:

- `auto: 10 memory writes` — normal cadence commit
- `auto: startup flush (uncommitted from previous session)` — the first
  commit after a process restart that finds a TRACKED dirty file in the
  memory repo. Untracked-only dirt does NOT trigger a startup flush; those
  files ride along with the next normal cadence commit. The startup flush
  is skipped (with a warning) when an in-progress merge / rebase /
  cherry-pick / revert / bisect is detected, to avoid clobbering it.

Commit failures (e.g. memory dir is not a git repo) log a
`ytsejam memory auto-commit:` warning to stderr and do NOT fail the
underlying write. The mutex inside `maybeAutoCommit` coalesces concurrent
bursts so N concurrent writes produce ⌈N/10⌉ commits, not N race-induced
attempts.

## File format spec

`docs/memory/FORMAT.md` is the on-disk format spec. This module reads and
writes against that spec.

## Guiding principle

Cog's DNA is bash + grep + LLM, not a service. Port semantics, not Go LOC. If
the equivalent Go was 400 lines for one regex sweep, the TypeScript is 40.
