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
grep -rn "memory_root\|ytsejam/data/memory" server/src | grep -v "^server/src/memory/"
```

That invariant preserves the "extract to npm package on day N+1" property.

## Internal structure (planned)

- `store/` — primitive I/O (`read`, `write`, `append`, `patch`, `outline`,
  `move`, `list`, `search`, `stats`).
- `domain/` — manifest loading and controller path validation.
- `consolidated/` — RPC-equivalent envelopes (`sessionBrief`,
  `housekeepingScan`, audits, indexes, and summaries).
- `git/` — auto-commit cadence and git wrappers.
- `format/` — parsers and serializers for markdown, L0 headers, frontmatter,
  observation lines, and action items.
- `server/test/memory/` — memory module tests.

## File format spec

`docs/memory/FORMAT.md` is the on-disk format spec. This module reads and
writes against that spec.

## Guiding principle

Cog's DNA is bash + grep + LLM, not a service. Port semantics, not Go LOC. If
the equivalent Go was 400 lines for one regex sweep, the TypeScript is 40.
