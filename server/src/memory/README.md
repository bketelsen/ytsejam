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

## `recordObservation()` (preferred over `append()` for observations.md)

```ts
import * as memory from "./memory/index.ts";

const result = await memory.recordObservation({
  domainPath: "personal",          // or "projects/ytsejam", etc.
  text: "shipped Bridge 1",
  tags: ["ltm", "bridge"],         // required (cog observation format)
  timestamp: new Date(),           // optional, defaults to now
});
// result.cog  -> { ok: true, ... }   (cog append result)
// result.ltm  -> { ok: true | false, error? }  (LTM mirror result)
```

Two-stage write:
1. Append the formatted line to `<dataDir>/<domainPath>/observations.md`
   (cog SSOT, must succeed).
2. Best-effort mirror to LTM as a `kind: "observation"` record (content-
   addressed by `cog:<domainPath>/observations.md#<sha256(line)[:12]>` so
   replay never duplicates).

The cog half always succeeds independently of LTM. Embedded `\n` / `\r` in
text is rejected (observations are single-line). Tags are mandatory.

`cog_append` to any `observations.md` path is routed through
`recordObservation()` automatically; direct callers in tool handlers use it
explicitly.

## LTM bridge wiring

LTM lives at `~/.ytsejam/data/ltm/` by default; override with `LTM_STORE_DIR`
(empty string falls through to the default).

Boot wires it in `server/src/index.ts` after `scheduler.start()`:

1. Open LTM (`MemorySystem.open({storeDir})`).
2. `memory.attachLtm(ltm)` — makes `recordObservation()` mirror inline.
3. Create + `attachReconciler` — back-fill timer for anything that missed
   the inline path or pre-dates the wire-up.

On boot failure the warning is logged to stderr and the server continues
without the bridge; `recordObservation()` still writes the cog half. SIGTERM
/ SIGINT drain the reconciler and close LTM cleanly.

### LtmReconciler

In-process timer (default 5 min, override with `LTM_RECONCILE_INTERVAL_MS`).
Per tick:

- Walks every domain `observations.md` whose mtime is newer than the last
  successful scan (or every file when `force: true`).
- Skips `glacier/` and any dotdir (matches cog's archival convention).
- Splits on `/\r?\n/` and `.trim()`s each line (CRLF-safe; the parser-then-
  hash dedup MUST see the same bytes the inline path saw).
- Parses each line; computes the same content-addressed origin; calls
  `hasObservation(origin)` to dedup; calls `ltm.recordObservation()` only
  for misses.
- Per-line errors bump `stats.errors` but don't fail the tick.
- Tick-level errors bump `consecutiveFailures` and surface in `health()`.

### CLI

For one-off operations the server exposes argv subcommands intercepted
before the HTTP boot. The server must be STOPPED first because LTM is
single-writer (`systemctl --user stop ytsejam`).

```sh
# direct node invocation (no `bin` shipped this PR)
node server/src/index.ts ltm replay             # one reconcile pass, mtime-respecting
node server/src/index.ts ltm replay --force     # full re-scan, ignore mtime cache (still skips already-mirrored content)
node server/src/index.ts ltm replay --rebuild   # full re-scan AND re-embed current observations (use after embedder cutover)
node server/src/index.ts ltm replay --rebuild --prune  # additionally tombstone orphan cog-origin observations
node server/src/index.ts ltm health             # print last-tick stats (CLI snapshot)

# npm-script ergonomic wrapper from repo root
npm run ltm -- replay
npm run ltm -- replay --force
npm run ltm -- replay --rebuild
npm run ltm -- replay --rebuild --prune
npm run ltm -- health
```

`ltm replay` prints a single JSON stats line to stdout and exits 0 (no
errors) or 1 (one or more per-line parse errors). `--rebuild` re-embeds current observations only. Add `--prune` with `--rebuild` to tombstone orphan records (observations whose source line is no longer in cog memory). Only run `--prune` in normal steady state — **NOT** while files are mid-archive or mid-restore, because temporarily missing source lines will be tombstoned.

`ltm health` prints a stderr WARNING (it's a CLI snapshot of an empty-cache
process, NOT live server health) followed by a single JSON stats line on
stdout; exit code mirrors `ltm replay`.

A live-server health endpoint is now available at `/api/memory/health`.

### Health surface

```ts
import * as memory from "./memory/index.ts";

const h = await memory.health();
// h.git, h.lastCommit, ... (existing fields)
// h.ltm = {
//   reachable: boolean,
//   consecutiveFailures: number,
//   lastError?: { message: string, at: string },
//   lastTickAt?: string,
//   lastTickStats?: { scannedFiles, scannedLines, replayed, rebuilt, pruned, skipped, errors },
// }
```

`h.ltm` is OMITTED (not present, not `undefined`) when no reconciler is
attached. The web UI surfaces this via the Brain health icon (`web/src/components/HealthIcon.tsx`).

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

## `recall(query)` — unified cross-substrate recall

A single async function that queries BOTH cog full-text search and LTM
semantic retrieve, normalizing results into one labeled shape and deduping
by origin.

```ts
import { recall } from "./recall.ts";

const result = await recall("bridge1 substrate validation");
// {
//   hits: [
//     { from: "cog", text: "...", where: "cog-meta/observations.md:14", score: 1.0, tags: [...] },
//     { from: "ltm", text: "...", where: "ltm:obs-abc123", score: 0.87 },
//     ...
//   ],
//   cogCount: 3,      // total cog grep matches (before top-5 truncation)
//   ltmCount: 5,      // LTM items before dedupe
//   dropped: 2,       // LTM hits dropped on origin path match
// }
```

**Ordering:** strict alternation: `cog[0], ltm[0], cog[1], ltm[1], ...`. When
one substrate runs out, the other's remainder follows. Score is
informational (cog=1.0, LTM=native retrieve score), NOT used for ordering.

**Dedupe:** origin-based using path prefix. When an LTM record's
`origin` starts with `cog:<path>` and a cog hit exists at `<path>:<line>`,
the LTM hit drops. Conservative: this can over-drop when cog+LTM hold
different content from the same file. Trade-off accepted — see design doc.

**Filter parameter:** intentionally not in this version. See JSDoc on
`recall.ts` for the deferral rationale.

**Surface:** registered as agent tool `recall` in `createCogTools()`
(`server/src/tools/cog.ts`).
