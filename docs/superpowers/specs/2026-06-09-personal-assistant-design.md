# ytsejam — Web-Based Personal AI Assistant

**Date:** 2026-06-09
**Status:** Approved design

## Summary

A single-user, web-only personal AI assistant built on the pi agent harness
(`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`). It has a
customizable persona, strong asynchronous delegation (the assistant spawns
subagents that work in the background and notify it on completion), JSONL
files as the single source of truth for all state, and sqlite as a derived
operational index. The UI is a ChatGPT-style multi-session chat app.

Non-goals: CLI or chat-platform transports (no Telegram/Slack), multi-user
support, public-internet hardening, mobile push services.

## Foundation

`earendil-works/pi` is an agent harness, not an assistant. We build on its
published packages rather than forking:

- **`@earendil-works/pi-agent-core`** — agent loop, typed event stream, tool
  system (typebox schemas, streaming updates, parallel execution),
  steering/follow-up message queues, JSONL v3 append-only session trees,
  compaction, turn snapshots.
- **`@earendil-works/pi-ai`** — unified streaming LLM API across providers
  (Anthropic, OpenAI, Google, Mistral, Bedrock, OpenRouter, …) with a
  generated model catalog, OAuth flows, and injectable `streamFn` (used for
  test stubs).

We do **not** depend on `pi-coding-agent` (the CLI); we reuse its ideas
(system-prompt composition, built-in tool set) in our own server.

## Architecture

**Approach: single Node process, in-process agents.** One server process
hosts the HTTP/WebSocket API, serves the built web app, and runs every agent
loop (main sessions and subagents) in-process. Rationale: single-user home
deployment; simplest event streaming (in-memory bus); one deployable. The
TaskManager abstraction isolates delegation so subagents could later move to
worker processes without touching the rest of the system.

**Stack:** TypeScript end to end. Node >= 22. npm workspaces:

```
server/   Hono + WebSocket server, agent hosting, indexer, task manager
web/      React + Vite + shadcn/ui, built to static assets served by server/
```

Key dependencies: `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`,
`hono`, `better-sqlite3`, `react`, `vitest`, `biome`.

**Deployment:** Docker container (or systemd service) on a home server,
reached over LAN/Tailscale. Auth is a single shared bearer token from an env
var, checked on every REST request and at WebSocket connect; the browser
stores it after a one-time login page. HTTPS is the reverse proxy's job.

## Storage

One configurable data directory (default `./data`, env `YTSEJAM_DATA_DIR`):

```
data/
  sessions/<id>.jsonl     SSOT: pi v3 append-only session trees (chat AND subagent sessions)
  tasks/<task-id>.jsonl   SSOT: delegation lifecycle events
  persona/persona.md      persona definition (name + personality + standing instructions)
  memory/memories.jsonl   SSOT: append-only memory events (add/update/delete)
  schedules/schedules.jsonl  SSOT: schedule definitions + firing events
  index.db                sqlite, derived, safe to delete
```

### The JSONL/sqlite contract

Every fact is appended to a JSONL file **first**; sqlite holds only derived
data needed for fast queries. A single `Indexer` module owns all sqlite
writes, fed by the same in-process events that trigger JSONL appends. On
startup, if `index.db` is missing or its schema version is stale, the Indexer
rebuilds it by replaying all JSONL files. Rebuild-from-JSONL must always
produce equivalent index state — this is the system's key invariant and is
covered by tests.

sqlite schema (WAL mode):

- `sessions` — id, kind (`chat`|`subagent`), title, created/updated
  timestamps, last-message preview, unread flag, running-task count,
  parent_session_id (for subagents), model.
- `messages_fts` — FTS5 over message text (session id, entry id, role, text).
- `tasks` — id, parent_session_id, subagent_session_id, label, status
  (`pending`|`running`|`completed`|`failed`|`cancelled`|`interrupted`),
  created/started/finished timestamps, model, result summary.
- `memories` + `memories_fts` — id, text, tags, created/updated; FTS5 over text.
- `schedules` — id, spec (one-shot timestamp or cron), target session,
  prompt, enabled, last/next fire times.
- `meta` — schema version.

## Providers and models

Providers are enabled by the presence of their API keys in the environment
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …). The pi-ai model
catalog drives a model picker in the UI, filtered to enabled providers.
Model selection is per-session and persisted in the session JSONL (pi already
records model changes as session entries). Two configurable defaults: one for
new chat sessions, one for subagents (so delegation can run on a cheaper
model).

## Persona

`persona/persona.md` holds the assistant's name, personality, and standing
instructions. It is editable from the Settings page in the UI (REST
read/write of the file). The system prompt for every main-session agent is
composed as: persona content, then a fixed harness section (environment
facts, tool guidance, delegation etiquette, memory guidance). Edits take
effect on the next turn of any session. Subagents do **not** get the full
persona; they get a focused worker prompt that names the parent persona.

## Tools

Main assistant toolset:

- **Web:** `web_search`, `web_fetch`.
- **System:** `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`
  (pi-style coding tools; acceptable on a private single-user box).
- **Delegation:** `delegate`, `check_task`, `cancel_task` (phase 2).
- **Memory:** `save_memory`, `recall_memory`, `forget_memory` (phase 3).
- **History:** `search_history` — FTS query over past conversations (phase 3).
- **Scheduling:** `schedule`, `list_schedules`, `cancel_schedule` (phase 4).

Subagent toolset: web + system tools + `recall_memory`. Subagents cannot
delegate (no recursion in v1) and cannot write memories or schedules.

## Delegation

### delegate tool

`delegate({ task, context?, model?, label })`:

1. Creates a task record (JSONL event + sqlite row).
2. Spawns a new in-process pi agent loop with its own JSONL session
   (kind `subagent`, linked to parent session and task id), the worker system
   prompt, the subagent toolset, and the requested or default subagent model.
3. Returns immediately with the task id — the parent's turn continues.

Concurrency cap (default 4, configurable); excess delegations queue as
`pending`. Per-task timeout (default 15 minutes, configurable); timeout or
crash produces a `failed` event — never a silent hang. `check_task` returns
status plus a tail of the subagent's progress; `cancel_task` aborts the loop.

### Completion and notification flow

1. Subagent finishes → TaskManager appends `completed` (with the final
   report) or `failed` (with the error) to the task JSONL.
2. TaskManager injects a follow-up message into the parent agent:
   `[Task "<label>" completed] <report>` — via pi's follow-up queue. If the
   parent is mid-turn it processes the message right after the current turn;
   if idle, a new turn starts immediately. **The assistant always takes a
   turn on completion**, even when the user is away.
3. The assistant's resulting turn streams over WebSocket like any other turn.
   If the user is not viewing that session, the Indexer marks it unread.
4. UI: sidebar unread badge plus a browser Notification (if permission
   granted), e.g. "<persona> finished: <label>". No external push service:
   with the tab closed, results are waiting on next visit.

Failures notify through the identical path, with the error in the injected
message, so the assistant can react (retry, re-delegate, tell the user).

## Scheduler (phase 4)

`schedule` supports one-shot (`at` timestamp) and recurring (cron expression)
jobs. Definitions and firing events live in `schedules.jsonl`. An in-process
loop checks due jobs every ~30 seconds; on startup, missed one-shot jobs fire
once (catch-up) and missed recurring jobs fire at their next occurrence.
Firing injects a message into the target session via the same follow-up
mechanism as task completion — the assistant wakes up and acts. Jobs can
target the originating session or a dedicated session.

## Memory (phase 3)

Append-only `memories.jsonl` (add/update/delete events) with sqlite + FTS5 as
the queryable view. Tools: `save_memory(text, tags?)`,
`recall_memory(query)`, `forget_memory(id)`. In addition to on-demand recall,
a compact relevant-memories block (FTS match against recent conversation) is
included in the system prompt context each turn. Settings includes a memory
browser (list, edit, delete).

## Web UI

ChatGPT-style layout, React + Vite + shadcn/ui:

- **Sidebar:** session list from sqlite (title, relative time, preview),
  unread badges, spinner on sessions with running tasks, new-session button,
  search box (FTS across all history; selecting a result opens that session
  at the matching message).
- **Chat pane:** streamed markdown rendering, tool calls as collapsible
  cards. Delegations render as live **task cards** (label, status, elapsed);
  clicking opens the subagent's transcript read-only in a drawer.
- **Tasks view:** all tasks across sessions with status — the "what is it
  doing right now" page.
- **Settings:** persona editor, default models (chat + subagent), memory
  browser, schedules list, token/login.

Session titles are auto-generated after the first exchange (small cheap model
call), editable inline.

## API

REST (bearer-token auth):

```
POST   /api/login                     validates token; client stores it in local storage
GET    /api/sessions                  list (from sqlite)
POST   /api/sessions                  create
GET    /api/sessions/:id              full transcript (from JSONL)
POST   /api/sessions/:id/messages     send user message (starts a turn)
POST   /api/sessions/:id/abort        stop current turn
PATCH  /api/sessions/:id              rename, mark read
DELETE /api/sessions/:id
GET    /api/tasks                     list tasks
POST   /api/tasks/:id/cancel
GET    /api/search?q=                 FTS results
GET/PUT /api/persona
GET    /api/models                    enabled providers/models
GET/POST/PATCH/DELETE /api/memories
GET/POST/PATCH/DELETE /api/schedules
```

One WebSocket (`/api/ws`) multiplexes all live events as
`{ sessionId, event }`: agent stream deltas, tool execution updates, task
status changes, unread/notification events. The client subscribes to the
currently visible session for full deltas and always receives lightweight
status events for all sessions (badges and task cards stay live everywhere).
Reconnect strategy: re-fetch state via REST, resubscribe; no WS event is
load-bearing because JSONL + sqlite hold all durable state.

## Error handling

- **Provider/LLM errors:** surfaced as an error block in the chat with a
  retry action, on top of pi's retry/turn-snapshot machinery.
- **Subagent failure/timeout:** `failed` task event → same notification path
  as success, error text included.
- **Server restart mid-turn:** JSONL append-only trees mean at most the
  in-flight turn is lost. On startup, tasks left in `running` are marked
  `interrupted` and the parent assistant is notified via message injection.
- **sqlite corruption or schema drift:** delete and rebuild from JSONL.
- **WS disconnects:** UI shows reconnecting state; REST re-fetch on
  reconnect.

## Testing

vitest, with pi-ai's injectable `streamFn` providing a scripted fake LLM (no
network, deterministic).

- **Indexer:** replaying JSONL from a temp data dir produces index state
  equivalent to incrementally built state (the core invariant).
- **TaskManager:** lifecycle transitions, completion injection into an idle
  and a mid-turn parent, concurrency cap and queueing, timeout → failed,
  cancel, interrupted-on-restart.
- **Memory/schedule stores:** event append + replay correctness; scheduler
  due-job and catch-up logic with injected clock.
- **Integration:** one end-to-end test driving REST + WS against a running
  server with the fake model: create session → send message → stream reply →
  delegate → task completes → parent notified → unread set.
- UI is manually tested in v1.

## Phases

Each phase ships a usable increment:

1. **Core chat** — server skeleton, auth, JSONL sessions, sqlite session
   index + Indexer, WS streaming, React chat UI with sidebar, persona file +
   settings editor, multi-provider model picker, web + system tools.
2. **Delegation** — TaskManager, delegate/check/cancel tools, completion
   injection, task cards, tasks view, unread badges, browser notifications.
3. **Memory + search** — memory store/tools/browser, FTS history search
   (UI search box + `search_history` tool).
4. **Scheduler** — schedule tools, scheduler loop, schedules UI.

## Decisions log

- Build on pi npm packages (not fork, not reimplement).
- Subagents are full in-process agents with own JSONL sessions.
- Assistant proactively takes a turn on task completion.
- Home server / private network; bearer-token auth only.
- Multi-provider from day one via pi-ai.
- Single global persona, UI-editable.
- sqlite scope: session metadata, FTS search, task registry, memory index.
- Tools include shell/filesystem (trusted single-user box).
- Frontend: React + Vite + shadcn/ui.
- Architecture: single process, in-process agents (approach A).
