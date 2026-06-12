# Storage

> Sub-doc of [`OVERVIEW.md`](OVERVIEW.md). Read this before touching any persistence code
> (`indexer.ts`, `manager.ts`, `tasks.ts`, `schedules.ts`, `workdirs.ts`, `archive-store.ts`,
> `persona.ts`, `skills.ts`).

## The one rule

**JSONL on disk is the single source of truth (SSOT). `index.db` (sqlite) is a derived cache,
rebuilt from JSONL on every boot.** Any code that changes durable state must append to the JSONL
*first*, then update the index. Never write the index without writing JSONL — a restart rebuilds
the index from JSONL and would silently lose your change.

This contract is enforced by the boot sequence in `server/src/index.ts`:

```
await manager.rebuildIndex();      // sessions: replay JSONL → sqlite
await taskManager.rebuildIndex();  // tasks: fold per-task JSONL → sqlite
await taskManager.recoverInterrupted();
await scheduler.rebuildIndex();    // schedules: fold JSONL → sqlite
await scheduler.catchUp();         // fire/skip overdue schedules
scheduler.start();
```

If you can delete `index.db` and lose nothing but query speed, the contract holds. If deleting it
loses data, something wrote the index without writing JSONL — that's a bug.

## On-disk layout (`YTSEJAM_DATA_DIR`)

Default `./data` in dev; `~/.ytsejam/data` in prod (set by the systemd unit). Everything below is
relative to that directory.

| Path | SSOT? | Owner | Contents |
| --- | --- | --- | --- |
| `sessions/<id>.jsonl` | **SSOT** | `JsonlSessionRepo` (pi-agent-core) | pi v3 append-only session trees. **Both** chat sessions (repo cwd `"chat"`) and subagent sessions (repo cwd `"subagent"`) live here; the repo cwd field segregates them. |
| `tasks/<task-id>.jsonl` | **SSOT** | `TaskStore` (`tasks.ts`) | One file per delegated task; append-only lifecycle events (`created`/`started`/`completed`/`failed`/`cancelled`/`interrupted`). |
| `schedules/schedules.jsonl` | **SSOT** | `ScheduleStore` (`schedules.ts`) | One shared file; append-only schedule lifecycle events (`created`/`fired`/`rescheduled`/`cancelled`). |
| `persona/persona.md` | **SSOT** | `PersonaStore` (`persona.ts`) | The persona markdown. Seeded with `DEFAULT_PERSONA` if absent. |
| `skills/<name>.md` or `skills/<name>/SKILL.md` | **SSOT** | `SkillsStore` (`skills.ts`) | User/seeded skill playbooks. See [`skills.md`](skills.md). |
| `workdirs/<sessionId>.jsonl` | **SSOT** | `WorkdirStore` (`workdirs.ts`) | Per-session working-directory events (latest-wins). |
| `archived/<sessionId>.jsonl` | **SSOT** | `ArchiveStore` (`archive-store.ts`) | Per-session archive (soft-delete) flag events (latest-wins). |
| `index.db`, `index.db-wal`, `index.db-shm` | **derived** | `Indexer` (`indexer.ts`) | sqlite query cache. Safe to delete; rebuilt on boot. WAL journal mode. |

Anything else under the data dir is an agent-created working directory (the `bash`/file tools
default their cwd here when a session has no explicit workdir set). `deploy/migrate-data.sh` treats
those as "extras" (copied only with `EXTRAS=1`).

## sqlite index (`indexer.ts`)

`Indexer` owns *all* sqlite access. It is a thin, synchronous wrapper over `node:sqlite`
(`DatabaseSync`) — no ORM, no migrations framework. Schema is a single `recreateSchema()` DDL
string guarded by a `SCHEMA_VERSION` constant (currently **4**).

### Schema-version handling

On construction the indexer reads `meta.schema_version`. If it differs from the compiled
`SCHEMA_VERSION` (or the meta table is missing/corrupt), it **drops and recreates every table** and
sets `wasReset = true`. Because the tables are derived, a wipe is harmless — the boot `rebuild*`
calls repopulate them from JSONL.

**Bumping the schema:** when you change any table's columns, increment `SCHEMA_VERSION`. That's the
entire migration story — old DBs get dropped and rebuilt. There is no in-place ALTER path and none
is wanted; the JSONL SSOT makes the rebuild authoritative.

### Tables

- `meta(key, value)` — holds `schema_version`.
- `sessions(id, path, title, created_at, updated_at, preview, unread, archived)` — index `sessions_updated` on `updated_at DESC`. `archived` is rebuilt from the `ArchiveStore` sidecar on boot (see below).
- `tasks(id, parent_session_id, subagent_session_id, label, status, model, created_at, started_at, finished_at, result_summary)` — indexes on `parent_session_id` and `created_at DESC`.
- `schedules(id, label, prompt, spec_json, target_session_id, enabled, cancelled, created_at, last_fired_at, next_fire_at, fired_count)` — index on `created_at DESC`. `spec_json` is the JSON-serialized `ScheduleSpec`.

Row-mapper helpers (`toRow`, `toTaskRow`, `toScheduleRow`) convert sqlite integers to booleans and
parse `spec_json`. The DB↔TS row shapes are typed (`SessionDbRow`, `TaskDbRow`, `ScheduleDbRow`).

## Sessions (`manager.ts`)

`AgentManager` wraps pi-agent-core's `JsonlSessionRepo`. The repo writes the append-only session
tree; the manager keeps a cache of *open* sessions (each with a live `AgentHarness`) and mirrors
metadata into the index.

Key write paths and their SSOT discipline:

- **New session:** `repo.create({ cwd: "chat" })` → `appendModelChange` (JSONL) → `indexer.upsertSession` (index).
- **Rename:** if the session is idle, `session.appendSessionName(title)` writes JSONL immediately, then `indexer.setTitle`. If a run is **in flight**, the title is held in `OpenSession.pendingTitle`, the index/UI update immediately for snappiness, and the JSONL write is flushed on `agent_end`. (JSONL is still SSOT — the index just leads it by one turn.)
- **Preview / unread / updatedAt:** updated from the harness `message_end` event via `touchSession`/`setUnread`. These are pure index fields recomputed by `rebuildIndex` from the JSONL transcript, so they are allowed to live only in the index between boots.
- **Title generation:** when `YTSEJAM_GENERATE_TITLES` is on (default), an idle session with no title gets an LLM-generated one (`completeSimple`, max 6 words) after the first exchange; the generated title is appended to JSONL and the index.

`rebuildIndex()` resets the sqlite tables and replays every chat-cwd session's JSONL to recompute
`title`, `preview`, `updatedAt`, and the `archived` flag.

## Archive (soft delete) — `archive-store.ts`

Archiving is **non-destructive**: the session JSONL stays on disk, a running turn keeps running,
and the session is merely hidden from the default sidebar list (`listSessions({ includeArchived })`
filters on `archived=0`). There is **no delete endpoint**; archive replaced delete.

The archived flag cannot live only in the index — `rebuildIndex` would reset it to `false` on every
boot and silently un-archive everything. So the SSOT is a per-session sidecar JSONL
(`archived/<sessionId>.jsonl`, latest-wins). `manager.archiveSession`/`unarchiveSession` call the
injected `markArchived` hook (which appends to the sidecar) *and* `indexer.setArchived`; `rebuildIndex`
reads the flag back from `isArchived`. Unarchive is just an append of `{archived:false}`.

## Working directory — `workdirs.ts`

Each session has an effective working directory the `bash`/`read`/`write`/`edit`/`ls`/`grep`/`find`
tools resolve relative paths against. It is **separate** from the pi session's `cwd` metadata field
(which ytsejam pins to a constant for repo segregation). The workdir is stored as a per-session
sidecar JSONL (latest-wins, mirrors archive) and resolved by `resolveWorkdir`:

1. latest `dir` event for the session, else
2. `defaultDir` (the data dir) when unset or when the stored dir no longer exists / isn't a directory.

`POST /api/sessions/:id/cwd` validates the path is absolute and an existing directory, appends the
event, then calls `manager.applyWorkdirChange` to rebuild the session's cwd-bearing tools live. The
system prompt re-resolves the workdir each turn, so a mid-session change also refreshes the
`AGENTS.md` context-file ancestry without reopening the session.

## Tasks & schedules folds

Both `TaskStore` and `ScheduleStore` are append-only logs folded into a current `*Row` via pure
reducers (`foldTaskEvents`, `foldScheduleEvents`). The fold result is what gets written to the
index and emitted on the bus. This event-sourced shape is why the index is always rebuildable and
why a crash mid-operation is safe: see [`delegation.md`](delegation.md) (tasks) and the scheduler
notes in [`OVERVIEW.md`](OVERVIEW.md) (schedules record the fire event *before* injecting, so a
crash can't double-fire).

## cog memory is NOT in this data dir

Persistent cross-session "memory" (hot memory, domains, observations, etc.) is **not** stored under
`YTSEJAM_DATA_DIR`. It lives in a separate cogmemory Go daemon reached over a unix socket. ytsejam
holds no copy. See [`OVERVIEW.md`](OVERVIEW.md) → cog memory and `server/src/cog/`.
