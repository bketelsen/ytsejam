# Bridge 1 Design — cog observation → LTM `recordObservation`

> **Scope:** PR 1 of the cog-LTM bridge roadmap
> (`docs/plans/2026-06-13-cog-ltm-bridge.md`). Sibling design memo for
> the whole roadmap: `docs/plans/2026-06-13-cog-ltm-bridge-design.md`.
> This doc is the canonical spec the develop reviewers check against.

**Branch:** `feat/cog-ltm-bridge-1-observer`
**Worktree:** `/tmp/cog-ltm-bridge-1`
**Status when shipped:** PR 0 (phase 0.0) done via PR #90; this is the
first bridge.

---

## Goal

Every cog observation also lands in LTM as `kind: "observation"`. LTM
gains a semantic search surface over Brian's deliberate writes, with
decay shaping retrieval over time (per-kind half-life `730d` for
observations from SEAM 2). 100% additive: cog's storage layout doesn't
change; observations.md remains the SSOT; LTM is a mirror that fades.

## Non-goals

- **No** LTM → cog promotion (that's Bridge 2, PR 2 of the roadmap).
- **No** unified-recall surface (that's Bridge 3, PR 3 of the roadmap).
- **No** web-UI surfacing of bridge health — deferred to issue #92.
- **No** auto-seed on first startup — the reconciler handles cold-start
  naturally.

## Architectural decisions (from brainstorm)

| # | decision | rationale |
|---|----------|-----------|
| 1 | First-class `recordObservation()` API in `server/src/memory/`, bridge lives inside it; `append()` stays substrate-agnostic | Type-safe: bridge can't fire on hot-memory.md edits; explicit at call site; symmetric with LTM's API |
| 2 | In-process timer inside ytsejam server, default 5 min, configurable via `LTM_RECONCILE_INTERVAL_MS` | Time-bounded drift (max 5 min behind); one concept; in-process is the natural shape now that cog+LTM share a Node process |
| 3 | CLI command `npx ytsejam ltm replay [--force]` wraps the reconciler; no auto-seed | First reconciler tick on empty LTM IS the seed; CLI exists as an escape hatch / debug tool; no "magic" startup behavior |
| 4 | LTM store at `~/.ytsejam/data/ltm/` by default, override via `LTM_STORE_DIR` | Matches `~/.ytsejam/data/memory/` colocation; matches LTM standalone's existing env var |
| 5 | Server stderr WARNING + `memory.health()` accessor; web UI surfacing deferred (issue #92) | A+D combined: no failure is silent; nothing pushed into a surface it doesn't belong in |

## System view

```
                  ┌───────────────────────────────────────────────┐
                  │  server/src/memory/index.ts                   │
                  │                                               │
  caller ─────►   │  recordObservation({                          │
                  │    domain, text, tags,                        │
                  │    timestamp                                  │
  observation     │  }) → {                                       │
  write path      │    cog: append observations.md   ─── SSOT     │
  (cog skill,     │    ltm: best-effort mirror via   ─── mirror   │
  /reflect,       │         bridge/ltm-observer.ts                │
  user write)     │  }                                            │
                  │                                               │
                  │  health() → {ltm: {...}}                      │
                  └───────────────────────────────────────────────┘
                                 │                ▲
                                 ▼                │ ticks
                  ┌──────────────────────┐   ┌────┴────────────────┐
                  │ LTM packages/ltm     │   │  LtmReconciler       │
                  │ (single Node process)│   │  setInterval 5min    │
                  └──────────────────────┘   │  mtime-bounded scan  │
                                             │  replays misses      │
                                             └──────────────────────┘
                                                       ▲
                                                       │ --force
                                  ┌────────────────────┴────────┐
                                  │ bin/ytsejam ltm replay      │
                                  │ (CLI escape hatch)          │
                                  └─────────────────────────────┘
```

## Components

### 1. `server/src/memory/bridge/ltm-observer.ts` (NEW, ~80 LOC)

Pure, testable. No I/O. Exports:

```ts
export type ParsedObservation = {
  text: string;          // body after "<date> [tags]: "
  timestamp: string;     // ISO at T00:00:00.000Z
  tags: string[];        // [] if untagged
};

/** Parse one observation line. Returns null on malformed input. */
export function parseObservationLine(line: string): ParsedObservation | null;

/** Compute the content-addressed origin string. */
export function computeOrigin(
  domainPath: string,    // e.g. "personal" or "projects/ytsejam"
  filename: string,      // e.g. "observations.md"
  rawLine: string,       // exact line text including dash prefix
): string;               // "cog:<domainPath>/<filename>#<sha256(line)[:12]>"

/** Best-effort record into LTM. Returns ok|error; NEVER throws. */
export async function mirrorToLtm(
  ltm: MemorySystem,
  parsed: ParsedObservation,
  origin: string,
): Promise<{ ok: true } | { ok: false; error: Error }>;
```

Salience hardcoded `0.85` for cog observations (deliberate writes get
the high bucket; matches the design memo's cross-bridge contract).

### 2. `recordObservation()` in `server/src/memory/index.ts` (NEW method)

```ts
export async function recordObservation(args: {
  domainPath: string;       // e.g. "personal", "projects/ytsejam"
  text: string;             // body; the function adds the date+tags prefix
  tags?: string[];          // optional
  timestamp?: Date;         // defaults to now
}): Promise<{
  cog: { ok: true; line: string };
  ltm: { ok: true } | { ok: false; error: Error };
}>;
```

Internally:

1. Format the canonical line: `- <YYYY-MM-DD> [<tag1,tag2>]: <text>` (or
   without `[...]` if no tags). This matches the existing
   `cog_append observations.md` convention exactly.
2. Append to `<domainPath>/observations.md` via the existing store —
   this is the SSOT, MUST succeed or the whole call rejects.
3. Parse the formatted line (round-trip via `parseObservationLine`).
4. Compute origin.
5. Call `mirrorToLtm` — best-effort, log on failure.
6. Return both results; caller can choose to log the LTM half but the
   cog half always reflects truth.

### 3. `LtmReconciler` in `server/src/memory/bridge/ltm-reconciler.ts` (NEW, ~120 LOC)

```ts
export class LtmReconciler {
  constructor(opts: {
    ltm: MemorySystem;
    dataDir: string;              // ~/.ytsejam/data
    intervalMs?: number;          // default 5 * 60 * 1000
    logger?: (level: "warn" | "info", msg: string, meta?: object) => void;
  });

  start(): void;                  // registers setInterval; idempotent
  stop(): Promise<void>;          // clears interval; awaits in-flight tick

  /** Run one reconciliation pass. Public for CLI + tests. */
  async reconcile(opts?: { force?: boolean }): Promise<{
    scannedFiles: number;
    scannedLines: number;
    replayed: number;
    skipped: number;
    errors: number;
  }>;

  health(): {
    reachable: boolean;
    lastError?: { message: string; at: string };
    consecutiveFailures: number;
    recentFailureCount: number;   // resets on every successful tick
    lastTickAt?: string;
    lastTickStats?: { scannedFiles; scannedLines; replayed; skipped; errors };
  };
}
```

Reconcile loop:

1. Walk `<dataDir>/**/observations.md`. (Glob via existing helper; cog
   already knows the layout.)
2. For each file: if `force === false` and `mtimeMs <= lastSeenMtime`,
   skip. Otherwise read line-by-line.
3. For each line: parse → compute origin → ask LTM `hasObservation(origin)`.
4. If absent: parse → mirror to LTM → bump `replayed`. If present: bump
   `skipped`.
5. On any per-line throw: bump `errors`, log WARNING with line content
   hash + origin (NOT raw text — observations may contain personal
   data; the hash + path is enough to investigate).
6. After the walk: update mtime cache, record tick stats, update health.
7. On tick-level throw (e.g. dataDir unreadable): catch, log WARNING,
   bump `consecutiveFailures`, set `lastError`, do NOT throw out of the
   timer.

mtime cache: in-memory `Map<filepath, number>`. Lost on restart — the
first post-restart tick does a full scan, which is correct behavior (we
don't trust cache across restarts). Cheap: full scan of all
observations.md files is bounded (Brian writes them; counted in
hundreds, not millions).

`hasObservation(origin)` on LTM side: SEAM 5b makes re-record idempotent
via content-addressed `obs-id`, but we still want the cheaper lookup to
avoid the parse+re-record work for already-present lines. **Smallest
viable addition to LTM:** `MemorySystem.hasObservation(origin: string):
boolean` — synchronous map lookup over the in-memory facts index.

This is the only LTM-side change in PR 1. If the team prefers to avoid
even that and let SEAM 5b absorb the dupes, we drop the `hasObservation`
check and always re-record. Simpler bridge code, more LTM work per
tick. Recommend keeping the check; it's a 5-line addition to LTM.

### 4. CLI command `bin/ytsejam` (or extending whatever the existing CLI surface is)

```sh
npx ytsejam ltm replay         # mtime-respecting reconcile, prints stats
npx ytsejam ltm replay --force # full scan ignoring mtime cache
npx ytsejam ltm health         # prints reconciler.health() as JSON
```

Implementation: thin wrapper that opens the same `MemorySystem` the
server would, calls `reconciler.reconcile({force})`, prints stats, exits.

**Lock coordination:** LTM is single-writer (advisory lock). If the
server is running, the CLI can't open LTM at the same time. The CLI
must either (i) detect and refuse with a clear message ("ytsejam server
holds the LTM lock; use the in-process reconciler"), or (ii) talk to
the running server via its HTTP/WS surface and ask IT to reconcile.

**Pick (i)** for v1. Simpler. The whole point of the in-process
reconciler is that you rarely need the CLI; when you do (debugging,
rebuild from scratch), the server isn't usually running anyway. If
this turns out painful later, add a `POST /memory/ltm/reconcile`
endpoint and have the CLI POST to it.

### 5. Lifecycle wiring (`server/src/index.ts` or equivalent boot path)

```ts
const memory = await openMemory({ dataDir: "~/.ytsejam/data" });
const ltm = await MemorySystem.open({
  storeDir: process.env.LTM_STORE_DIR ?? "~/.ytsejam/data/ltm",
});
const reconciler = new LtmReconciler({
  ltm,
  dataDir: "~/.ytsejam/data",
  intervalMs: Number(process.env.LTM_RECONCILE_INTERVAL_MS) || undefined,
});
memory.attachLtm(ltm, reconciler);  // makes recordObservation() wire the bridge
reconciler.start();

// shutdown handler
on("SIGTERM", async () => {
  await reconciler.stop();
  await memory.close();
  ltm.close();
});
```

Single-instance guard inside `LtmReconciler.start()`: if already running,
return. Idempotent. Protects against dev hot-reload stacking timers.

## Data flow

### Inline write (steady state)

```
agent/skill calls memory.recordObservation({...})
    ├─► cog write: append observations.md           [SSOT, must succeed]
    └─► parse + origin + ltm.recordObservation(...) [mirror, best-effort]
        │
        on throw: log WARNING, bump health.recentFailureCount, return {ok:false,error}
```

### Reconciler tick (every 5 min)

```
timer fires → reconciler.reconcile({force: false})
    ├─► glob observations.md files
    ├─► for each file with mtime > lastSeen:
    │     for each line:
    │       parse + origin
    │       if !ltm.hasObservation(origin): mirror
    └─► update mtime cache + health
```

### CLI replay (manual)

```
npx ytsejam ltm replay --force
    ├─► open MemorySystem (errors if server has lock — clear message)
    ├─► new LtmReconciler({...})
    ├─► reconciler.reconcile({force: true})
    └─► print stats as JSON, exit 0 (or 1 if errors > 0)
```

## Error model

| failure | what happens | who sees it |
|---------|-------------|-------------|
| Parser hits malformed line | line skipped, WARNING with file+line# | server stderr |
| LTM `recordObservation` throws on inline call | cog write still succeeds; return `{ok:false,error}` to caller; WARNING | server stderr; `recordObservation` return value |
| Reconciler tick throws (dataDir unreadable, etc.) | tick aborts; consecutiveFailures bumps; WARNING | server stderr; `memory.health()` |
| LTM store corrupted / can't open | server boot fails (LTM is now part of the agent's substrate) | startup logs, systemd journal |
| CLI runs while server holds lock | CLI exits non-zero with clear message | terminal |
| LTM throws on `hasObservation` (shouldn't happen) | treated as "absent" → mirror attempt → if mirror also throws, error bookkeeping above | server stderr |

## Test surface (vitest)

| test | what it asserts |
|------|----------------|
| `parseObservationLine` shape variants | tagged / untagged / multi-tag / weird whitespace / malformed → null |
| `computeOrigin` collision distinguishability | same line text in two different files → distinct origins |
| `recordObservation` cog-side correctness | line written to correct file with correct format; tags + timestamp round-trip |
| `recordObservation` LTM-throw resilience | inject LTM that throws on `recordObservation` → cog write still succeeds, return value reflects truth |
| `LtmReconciler.reconcile` catches missed lines | drop a line via direct file write (bypassing the inline path) → tick catches it; LTM has it after |
| `LtmReconciler.reconcile` mtime cache | untouched files not re-walked on second tick; `--force` ignores cache |
| `LtmReconciler.reconcile` per-line error isolation | malformed line N doesn't stop processing of line N+1 |
| `LtmReconciler` lifecycle | `start` is idempotent; `stop` clears interval and awaits in-flight tick; double-start doesn't stack timers |
| `LtmReconciler.health` accounting | thrown tick → consecutiveFailures climbs; recovery tick → recentFailureCount resets, consecutiveFailures returns to 0 |
| CLI lock collision | CLI run while a held-lock LTM exists → exits non-zero with clear message |
| Manual smoke (documented in PR, not automated) | write fresh observation via `recordObservation()` → `npx ltm retrieve "<related question>"` returns it within 5s |

## What changes outside the bridge files

- **`server/src/memory/index.ts`**: adds `recordObservation()` method + `health()` method + `attachLtm()` plumbing.
- **`server/src/index.ts`** (boot): opens LTM, constructs reconciler, wires, registers shutdown hook.
- **`packages/ltm/src/api/memory-system.ts`**: adds `hasObservation(origin)` synchronous lookup (~5 LOC).
- **Call sites currently using `cog_append observations.md`**: migrate to `memory.recordObservation(...)`. Discoverable via `grep -rE "observations\.md" server/src/`. Expected: a handful, mostly in skill-loader and /reflect-side code. Each migration is mechanical.
- **`bin/` (or wherever the CLI surface lives)**: add `ltm replay [--force]` + `ltm health` subcommands.
- **`scripts/gate.sh`**: no change (new tests get picked up by the existing `server tests` step).

## What stays untouched

- `packages/ltm/` aside from the 5-LOC `hasObservation` addition.
- cog observations.md storage layout / format / append semantics.
- All non-observation cog writes (hot-memory, action-items, entities, threads, dev-log, etc.).
- The web UI (deferred to issue #92).

## Risks + mitigations

| risk | mitigation |
|------|-----------|
| Migrating call sites misses one, that site bypasses the bridge | Reconciler tick within 5 min catches it. Acceptable — the bridge has a self-healing pair by design |
| LTM-throw rate is non-trivial and stderr fills with WARNING noise | health() distinguishes transient from persistent; if it becomes a problem, add per-error-kind dedup later (not now) |
| mtime-cache miss in some FS scenario (clock skew, NFS) | `--force` always available; first tick after restart is full scan; cost of a full scan is low |
| LTM `recordObservation` is slow → bridge adds noticeable latency to cog writes | LTM `recordObservation` is in-memory + JSONL append, microseconds; not a realistic concern at observation cadence |
| Personal data ends up in WARNING logs | Log line origin hash + file path + line number, NOT raw text. Already in error model above |

## Estimate

~250 LOC across 3 new files + 1 LTM method + ~5 call-site migrations.
Test surface ~150 LOC. **~1-2 days** of develop-skill execution.

## Done when

- One PR opened against ytsejam main, `scripts/gate.sh` green.
- `recordObservation()` API documented in `server/src/memory/README.md`.
- Fresh server start with empty LTM: first reconciler tick seeds LTM
  from existing observations (replaces what would have been an
  auto-seed); `npx ytsejam ltm health` shows reachable + zero failures.
- A new observation written via `recordObservation()` appears in
  `npx ltm retrieve` for a related query within 5s.
- Issue #92 (web UI surfacing) linked from PR description.

---

**Next:** `/write-plan` produces the task breakdown from this design.
