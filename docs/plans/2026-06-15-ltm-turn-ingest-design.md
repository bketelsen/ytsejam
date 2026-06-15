# Design: LTM turn ingest + housekeeping consolidation + history backfill

**Date:** 2026-06-15
**Status:** Approved (this design)
**Branch (intended):** `feat/ltm-turn-ingest`
**Related:**
- `packages/ltm/ARCHITECTURE.md:220-232` — original integration sketch (4 bullets, only bullet 1 shipped)
- `packages/ltm/COG-LTM-COMBINATION.md` — Option C bridge framing
- `docs/plans/2026-06-13-cog-ltm-bridge-design.md` — bridges 1/2/3 plan

## Summary

Ship bullets 2 + 4 of the original LTM integration sketch — turn ingestion
on `agent_end` and `consolidate()` on the housekeeping cadence. Backfill 30
days of existing chat sessions via a rate-limited, server-side admin
endpoint driven by a thin CLI. **Defer** bullet 3 (`composeContext` in the
system prompt) until we have a week of real turn-ingested data to make the
read-side shape decision against evidence.

## Background

LTM as shipped is structurally a loop: cog observations are the only input
(`memory.recordObservation` mirrors cog → LTM; the planned Bridge 2 would
promote LTM facts → cog observations). The "experiential" framing in the
design memos assumed turn ingestion was on. It isn't. `MemorySystem`'s
`ingestSessionFile` / `ingestSessionDir` / `composeContext` /
`consolidate()` all exist publicly, are ytsejam-shaped (the session reader
opens with "Reader for ytsejam session JSONL files (pi v3 format)"), and
have zero server-side callers.

The original `ARCHITECTURE.md` integration sketch named four bullets:

1. Drop `src/` under `server/src/ltm/` — **shipped** (workspace package via subtree)
2. Ingest on `agent_end` via `ingestSessionFile` — **NOT shipped**
3. Call `composeContext(latestUserText)` in the system-prompt builder — **NOT shipped**
4. Run `consolidate()` on the existing housekeeping cadence — **NOT shipped**

The bridge plan (2026-06-13) drifted from this sketch by reframing around
bridges, then shipped Bridge 1 + Bridge 3 (recall tool), then parked Bridge 2.
The four-bullet sketch was never explicitly rescoped — bullets 2-4 just got
orphaned in the shuffle.

This design ships bullets 2 + 4 and defers bullet 3 with a hot-memory pin
and a scheduled review.

## Goals

1. LTM's input is no longer "only cog observations." Turn-extracted facts
   become the dominant signal, which is what makes Bridge 2 honest (and
   what populates the today-empty profile block).
2. `recall()` becomes sharper for free as the underlying corpus grows from
   507 episodic records to ~5,000–10,000.
3. Existing 699 chat session JSONL files (30 days of history, 185 MB) get
   ingested incrementally at a rate that won't trip Copilot embed rate
   limits.
4. The read-side shape decision (`composeContext` in system prompt: yes,
   how, with what query) is made against real data a week from now, not
   speculation today.

## Non-goals

- **No `composeContext` in system prompt.** Deferred to Friday 2026-06-19
  review against real data. Four options preserved in hot-memory:
  - C1 — profile always-on; episodic injected on turn 1 only, frozen for session
  - C2 — profile always-on; episodic pinned at auto-title generation (~turn 3)
  - C3 — profile always-on; no episodic in system prompt; `recall()` is the only path
  - defer — keep `recall()` as the only read surface indefinitely
- **No Bridge 2.** Parked at #104, target 2026-06-27.
- **No `recall()` changes.** It gets better for free.
- **No task JSONL ingest.** Task event metadata (`type:"created"`,
  `type:"started"`, etc.) is dispatch bookkeeping, not conversation. The
  subagent's actual conversation lives in its own session file at
  `subagentSessionId` and gets caught by the existing `sessions/` walk.

## Architecture

### Live ingest — bullet 2

Two new fire-and-forget hooks, one in `server/src/manager.ts`, one in
`server/src/task-manager.ts`, both in the existing `agent_end` handler:

```ts
// after the existing pendingTitle flush + emitMeta + maybeGenerateTitle:
const ltm = this.opts.ltm;
if (ltm) {
  const sessionPath = this.opts.resolveSessionPath?.(opened.id);
  if (sessionPath) {
    setTimeout(() => {
      ltm.ingestSessionFile(sessionPath).catch((err) => {
        console.error(`ltm ingest failed for ${opened.id}`, err);
      });
    }, 0);
  }
}
```

Mirrors the existing `maybeGenerateTitle` and pending-title flush patterns
30 lines above in the same handler — same async-fire-outside-listener
shape. Failure logs to console and is swallowed; ingest is best-effort.

**Self-modification posture unchanged.** `agent_end` fires after the turn
settles and pi has written the JSONL. Ingest reads what's on disk. Same
hazard model as JSONL-as-SSOT.

### Housekeeping consolidation — bullet 4

New method `memory.consolidateLtm()` in `server/src/memory/index.ts`:

```ts
export async function consolidateLtm(): Promise<{ created: number; folded: number } | null> {
  if (!attachedLtm) return null;
  return attachedLtm.consolidate();
}
```

Wire-in: the `/housekeeping` skill already calls `cog_rpc("housekeeping_scan")`.
Add `consolidateLtm` to the same dispatched RPC list (via `cog_rpc`) or as
a sibling RPC. Single call, no flags. Existing observation exemption
(`kind === "observation"` skip in LTM's consolidate path) remains
untouched — only turn-records get folded.

### Backfill — server-side admin endpoint + CLI driver

Three HTTP routes under the same Bearer auth pattern PR #189 established
for `/api/regenerate-title`:

- `POST /api/admin/ltm-backfill` — body `{dir, ratePerSec, batchSize, pauseMs}` → `{jobId}`
- `GET /api/admin/ltm-backfill/:jobId` → `{processed, total, lastSessionId, status, warnings[]}`
- `DELETE /api/admin/ltm-backfill/:jobId` → cancels

Server-side machinery:
- `BackfillJob` class manages a single in-flight job (concurrency = 1; a
  second `POST` while one is running returns 409). Lives in a new
  `server/src/memory/bridge/backfill-job.ts` next to `ltm-reconciler.ts`.
- Iterates files via the existing `listSessionFiles(dir)` helper.
- Per-turn pacing: after each `await ltm.ingestSessionFile(file)`, sleep
  `1000 / ratePerSec * report.turnsIngested` ms (proportional to the
  burst we just emitted).
- Per-batch pacing: after every `batchSize` files, sleep `pauseMs`.
- Progress: append a `[ltm backfill] N/total turns, file <basename>` log
  line every 100 turns.
- Cancellation token check before each file (cooperative — won't interrupt
  a single file's in-flight embeds).
- State persists naturally via LTM's own `ingest-state.json` — resume on
  re-run is automatic and incremental.

CLI: extend `server/src/cli/ltm-commands.ts` with a `backfill` subcommand:

```
ytsejam ltm backfill <dir> [--rate=2] [--batch=10] [--pause-ms=2000]
```

- Reads `YTSEJAM_API_TOKEN` (same env var as `scripts/backfill-null-titles.sh`)
- POSTs to local `:9873` (configurable via existing `YTSEJAM_API_URL` if
  present)
- Polls `GET` every 5s; prints `[N/total] last: <session-basename> (W warnings)`
- SIGINT → `DELETE` → exit clean
- Default rate=2 turns/sec → ~5 hours wall clock for ~35K turns

**Why server-side, not standalone CLI:** the LTM store is single-writer
(`MemorySystem.openDirs` guard). A separate CLI process can't open the
same store dir the live server holds. Going through the server respects
the invariant cleanly; the same `LtmReconciler`-style "background work off
the main thread" pattern applies.

## Data flow

```
agent_end event in chat or subagent session
  → setTimeout(0)
    → ltm.ingestSessionFile(sessionJsonlPath)
      → reads new entries past ingest-state.json's last cursor
      → embeds each turn (Copilot text-embedding-3-small)
      → upserts episodic records + extracts entities/facts
      → updates ingest-state.json cursor

/housekeeping skill (manual)
  → cog_rpc(housekeeping_scan) + new consolidateLtm RPC
    → LTM folds old non-observation turns into per-session summaries

ytsejam ltm backfill ~/.ytsejam/data/sessions
  → POST /api/admin/ltm-backfill
    → BackfillJob iterates listSessionFiles
      → same ingestSessionFile path as live, just paced
    → CLI polls GET, prints progress, handles SIGINT
```

## Error handling

| failure | response |
|---|---|
| Single-file ingest throws | warning logged, next file proceeds (matches existing `ingestDir` behavior) |
| Copilot embed 429 | embedder's existing exponential backoff (PR #143); rate limit makes unlikely |
| Server restart mid-backfill | `ingest-state.json` persists; re-running `ytsejam ltm backfill` resumes from last cursor |
| LTM bridge not attached (env disabled, init failed) | live hooks no-op cleanly (`if (!ltm)`); backfill endpoint returns 503 |
| Admin endpoint without auth | 401 (same middleware as `/api/regenerate-title`) |
| Concurrent backfill POST | 409 (job singleton; cancel the existing one first) |

## Testing

- Unit: `BackfillJob` with a fake embedder + small fixture dir, asserts
  pacing (turn count × delay budget within tolerance), cancellation
  semantics, resume from partial state.
- Integration: end-to-end test pumps 3 fake session files through the
  admin endpoint, asserts progress polling sees monotonic `processed`,
  cancellation mid-flight produces `status: "cancelled"`, second POST
  while one runs returns 409.
- Smoke: dispatch a real `/api/admin/ltm-backfill` against a 5-file
  fixture, verify episodic record count grows by the expected delta.

## Rollback

- Live hooks: delete the two `setTimeout` blocks. Live ingest stops; no
  data corruption (LTM stores stay valid; cog mirror keeps working).
- Backfill data: `ytsejam ltm replay --rebuild --prune` (PR #146 shipped
  this exactly for orphan cleanup). Or delete `~/.ytsejam/data/ltm/` and
  let the next boot rebuild from cog observations only (the pre-this-PR
  state).
- Whole feature: `git revert <merge-sha>` + restart. The LTM bridge
  reverts to mirror-only mode.

## Open question parked for Friday 2026-06-19

Does `composeContext` belong in the system prompt? Four options
preserved (see Non-goals). Reviewing against:

- Episodic record count (before: 507; expected after: 5k–10k)
- Profile contents (identity, preferences, directives, attributes — all
  empty today)
- Top entities post-ingest (today: PR(134), Brian(103), Task(75)...)
- Three sample `composeContext` outputs against deliberately different
  queries (project name, user utterance shape, abstract question)
- Recall-call rate change over the week — does the agent reach for it
  more now that LTM has real content?

Reminder scheduled via `schedule` tool; hot-memory pin in
`projects/ytsejam/hot-memory.md` carries the question + four options
forward.
