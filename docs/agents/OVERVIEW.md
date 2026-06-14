# ytsejam — Agent Overview

> Entry point for AI agents working in this repo. Read this first, then follow the links into the
> subsystem docs for whatever you're touching. This is architecture + rationale, not a user manual.
> **Doc rule:** these are living docs grounded in the code — when you change behavior, update the
> relevant doc in the same change.

## Purpose

**ytsejam** is Brian Ketelsen's single-user, web-based personal AI assistant, built on the
open-source **pi agent harness** from [earendil-works](https://github.com/earendil-works/pi)
(`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`) — it consumes the published packages, it
does not fork them. It runs as **one Node process** that serves an HTTP + WebSocket API and the built
React/Vite UI, hosting every agent loop (chat sessions *and* background subagents) in-process.

**JSONL files on disk are the single source of truth;** the sqlite database (`index.db`) is a derived,
rebuildable query index — never authoritative. In production it runs as a **systemd `--user` service
on port 9873**; for development, `deploy/dev.sh` runs a fully isolated instance on **port 3000**.

This is the substrate the calling assistant itself runs on. Be careful and precise.

## Repo shape

npm workspaces, TypeScript end to end, Node ≥ 22 (uses the built-in `node:sqlite`).

```
server/    Hono + WebSocket API, agent hosting, indexer, task/schedule managers, tools, cog client
web/       React 19 + Vite + Tailwind/shadcn UI, built to static assets served by the server
packages/  vendored workspaces — currently `packages/ltm/` (long-term memory engine, ingested via
           `npm workspace`, opened in-process by the server alongside cog memory)
scripts/   the quality gate
deploy/    systemd unit + install/deploy/rollback/dev/migrate scripts
patches/   patch-package patches against node_modules
contrib/   reference copies of skill playbooks (not the live source — live skills load from the
           user's data dir)
docs/      plans, specs, audits, bugs, the user-facing USAGE.md/MEMORY.md, and these agent docs
```

Root npm scripts (`package.json`): `start` (build web + run server), `dev:server`, `dev:web`,
`build` (web), `test` (server + web + ltm), `check` (server + ltm typecheck), `ltm` (one-shot
wrapper for the `node server/src/index.ts ltm …` CLI). `postinstall` runs `patch-package`.

## Architecture

### `server/src/` — the process

Read these to understand the runtime; the boot wiring in `index.ts` is the map.

- **`index.ts`** — composition root. Loads config, constructs every store/service, wires tools into
  the `AgentManager`, rebuilds the sqlite index from JSONL, recovers interrupted tasks, catches up
  schedules, opens LTM + starts the cog→LTM bridge, then starts the Hono server + WebSocket. Also
  intercepts CLI argv via `runCli()` **before** any of that boot work, so `node server/src/index.ts
  ltm replay` exits without ever opening the HTTP listener.
- **`cli/`** — argv subcommands that share the server's modules but never boot it. `dispatch.ts`
  owns the `ltm` namespace; `ltm-commands.ts` implements `ltm replay [--force]` and `ltm health`
  by opening LTM directly + running one reconcile tick. Used for one-off back-fill from the shell
  (`npm run ltm -- replay`); requires the server stopped because LTM is single-writer. See
  [`memory-bridge.md`](memory-bridge.md) § CLI.
- **`config.ts`** — `loadConfig()` reads env into a typed `Config`. The only required var is
  `YTSEJAM_AUTH_TOKEN`. Clamps task concurrency/timeout.
- **`server.ts`** — `createApp()` builds the Hono app: bearer-token auth on `/api/*`, the REST routes
  (sessions, messages, tasks, schedules, persona, models, cwd, archive, **memory health**), the
  `/api/ws` WebSocket (per-client session subscription + lightweight global liveness events), and
  static serving of `web/dist` with SPA fallback.
- **`manager.ts`** — `AgentManager` owns chat sessions: opens/caches a pi `AgentHarness` per session,
  composes the system prompt each turn, forwards harness events to the bus, mirrors metadata into the
  index, generates titles, drives compaction (idle, inner-loop via the `context` event hook, and the
  reactive backstop), and handles rename/archive/workdir/model changes. JSONL stays SSOT (e.g.
  a rename mid-run updates the index immediately but flushes to JSONL on `agent_end`).
- **`indexer.ts`** — `Indexer`, the **only** sqlite writer. Schema-versioned; drops+rebuilds on
  version mismatch (safe because derived). Tables: `sessions`, `tasks`, `schedules`, `meta`.
  Periodic `wal_checkpoint(TRUNCATE)` keeps the WAL bounded.
- **`task-manager.ts` / `tasks.ts`** — background subagent delegation. `TaskManager` runs subagents
  in-process with their own JSONL sessions and the same three-entry-point compaction wiring as the
  chat session; `TaskStore` is the append-only per-task event log folded into a row. See
  [`delegation.md`](delegation.md).
- **`scheduler.ts` / `schedules.ts`** — one-shot + cron reminders that inject a prompt into a session
  at fire time. `ScheduleStore` is the append-only event log; `SchedulerService` ticks every 30s,
  records the fire event *before* injecting (crash-safe, no double-fire), and on boot fires overdue
  one-shots / reschedules overdue crons (`catchUp`). Cron is **server-local time**.
- **`persona.ts`** — `PersonaStore` (loads/saves `persona/persona.md`) plus `composeSystemPrompt`
  (chat) and `composeWorkerPrompt` (subagent), which assemble persona + environment + tool guidance +
  optional cog/skills/context-file sections.
- **`skills.ts`** — `SkillsStore`: discovers, seeds (copy-if-missing), lists, and loads markdown skill
  playbooks; renders the `## Skills` routing table into the prompt. See [`skills.md`](skills.md).
- **`workdirs.ts` / `archive-store.ts`** — per-session sidecar JSONL logs (latest-wins) for the
  agent working directory and the archive (soft-delete) flag. Both are SSOT the index is rebuilt
  from. See [`storage.md`](storage.md).
- **`compaction.ts`** — model-aware context-window compaction. Three entry points wired by the
  manager/task-manager: **idle** (between turns of an autonomous run), **inner_loop** (inside the
  next turn via pi's `context` event hook, bypassing the harness's idle-only guard), and the
  **reactive_path** backstop after a context-overflow stop reason. Emergency-disable via
  `YTSEJAM_COMPACTION_ENABLED=false`. Each compaction emits `compaction_start`/`compaction_end` bus
  events, a one-line cog dev-log entry, and a `.compactions.jsonl` sidecar record with the
  `entry_point` field. See [`observability.md`](observability.md).
- **`context-files.ts`** — faithful port of pi-coding-agent's "context files": loads `AGENTS.md`/
  `CLAUDE.md` from `~/.pi/agent` and the workdir's ancestor chain into the system prompt
  (`YTSEJAM_CONTEXT_FILES=false` disables).
- **`models.ts` / `pi-auth.ts`** — `resolveModel` validates a `provider/modelId` against the pi-ai
  catalog and applies OAuth model overrides; `listAvailableModels` powers the model picker.
  `PiAuthStore` is a read-mostly view over the pi CLI's `~/.pi/agent/auth.json` OAuth credentials
  (refreshing + writing back expired tokens at mode 0600). Env API keys win over OAuth.
- **`events.ts`** — `EventBus`, a synchronous in-memory pub/sub. `ServerEvent` is the union the
  WebSocket relays (agent stream events, session/task/schedule metadata, compaction lifecycle).
  See [`observability.md`](observability.md) for the full event list.

#### Model catalog (live Copilot merge)

Model resolution flows through [`resolveModel(ref, oauth?, opts?)`](../../server/src/models.ts),
not directly through pi-ai. At boot, [`loadLiveCopilotModels(authStore)`](../../server/src/copilot-live-catalog.ts)
fetches GitHub Copilot's live `/models` endpoint and returns a `MergeResult`: `overlay` for live
Copilot models absent from pi-ai's static catalog, plus `prunedIds` for static pi-ai Copilot models
the user's account is not entitled to. [`index.ts`](../../server/src/index.ts) threads that same
merge into both [`AgentManager`](../../server/src/manager.ts) and
[`TaskManager`](../../server/src/task-manager.ts), so chat sessions and delegated subagents honor
the same resolver behavior.

Overlay records are inferred, not persisted: [`inferModelTemplate`](../../server/src/copilot-live-catalog.ts)
clones the closest static sibling by prefix, preserving sibling metadata; unknown `claude-*` ids
default to `anthropic-messages`, and other ids default to `openai-completions`. `prunedIds` are
checked before static lookup, so ghost models listed by pi-ai but absent from the live entitlement
throw `Model X is in pi-ai's catalog but not in your Copilot entitlement...` instead of surfacing
Copilot's later `400 not supported`.

Failure is graceful: auth/fetch/parse errors log a WARN and return an empty `MergeResult`, leaving
boot on the static catalog. The live catalog is startup-only; restart ytsejam to pick up entitlement
changes. Set `YTSEJAM_DISABLE_COPILOT_LIVE_CATALOG=1` to skip the boot fetch and use pi-ai's static
catalog only.

### `server/src/tools/` — the agent's tool surface

Tools are `AgentTool` factories wired explicitly at boot (no auto-registry). Split into
**cwd-independent** globals (`web_search`, `web_fetch`) built once, and **cwd-bearing** tools
(`bash`, `read`, `write`, `edit`, `ls`, `grep`, `find`) built per session/per task against a working
directory. Plus per-session `delegate`/`schedule` tools, the global `skill` tool, the `cog_*`
memory tools, and `recall` (unified cog + LTM retrieval). Files: `index.ts` (assembly), `shell.ts`,
`files.ts`, `search.ts`, `web.ts`, `delegation.ts`, `scheduling.ts`, `skills.ts`, `cog.ts`. See
[`tools.md`](tools.md).

### `server/src/memory/` + `server/src/cog/` — persistent memory

Persistent memory is served in-process by `server/src/memory/`; there is no separate process,
socket, or JSON-RPC hop. `server/src/cog/brief.ts` (`CogBriefProvider`) fetches a `session_brief`
through the memory module and renders the `## Memory (cog)` system-prompt section (cached with a
short TTL, never throws — sessions degrade gracefully if a memory read fails). The model-facing
`cog_*` tool vocabulary is retained for skill compatibility.

The memory module also drives the **cog→LTM bridge**: cog observation writes are mirrored into
the long-term-memory substrate at `packages/ltm/` (opened against `<dataDir>/ltm/`), with a
back-fill reconciler for anything that missed the inline path. The `recall` tool queries both
substrates and interleaves results. See [`storage.md`](storage.md), [`memory-bridge.md`](memory-bridge.md),
and `server/src/memory/README.md`.

### `server/skills/` — seeded skill playbooks

Markdown skills shipped in the repo (cog-pipeline skills + `create-gate`). On boot they're copied
into `<dataDir>/skills/` **only if absent**; the user/data-dir copy wins. See [`skills.md`](skills.md).

### `web/src/` — the UI

React 19 SPA, Vite build, Tailwind v4 + shadcn/ui. The server serves the built `web/dist`; in dev,
`npm run dev:web` runs Vite on :5173 proxying `/api` (incl. WebSocket) to :3000.

- **`App.tsx`** — top-level layout (sidebar + chat + settings/tasks dialogs); gates on login.
  Renders the WebSocket + LTM **health icons** in the chat header (`Plug` for WS, `Brain` for LTM,
  gray/green/red outline by state).
- **`useApp.ts`** — the app state hook: holds sessions/messages/streaming/tasks plus the WS and LTM
  health states, opens the WebSocket, routes `ServerEvent`s into React state (streaming assistant
  tokens, session metadata incl. live `compacting` flag, task updates, archive/unarchive,
  `compaction_start`/`compaction_end` lifecycle), polls `/api/memory/health` for the brain-icon
  state, and exposes `send`/`selectSession`/`newSession`.
- **`components/`** — `Sidebar` (session list + new/archived/settings/tasks; per-row compaction
  indicator), `Chat` (transcript + composer + per-session cwd editor + task-transcript dialog +
  in-flight compaction pill), `Message` (renders a transcript message, incl. tool calls/results,
  markdown), `TaskCard`/`TasksDialog` (delegated-task status + transcript), `Settings` (persona
  editor, model picker, schedules), `Login`, `HealthIcon` (the WS + LTM status indicators), and
  generated shadcn primitives in `components/ui/`.
- **`lib/`** — `api.ts` (typed REST client + bearer token in `localStorage`, plus
  `getMemoryHealth`), `ws.ts` (auto-reconnecting WebSocket with per-session subscribe + connect
  watchdog), `types.ts` (shared row/event types mirroring the server, incl. `HealthState` SSOT and
  the compaction-lifecycle events), `time.ts`, `utils.ts`.

UI styling rule (`web/CLAUDE.md`): **only shadcn semantic theme tokens**, never raw Tailwind palette
classes — enforced by `web/test/theme.test.mjs` in the gate.

### `scripts/`, `deploy/`, `patches/`

- **`scripts/gate.sh`** — the quality gate (the only CI-equivalent). See [`quality-gate.md`](quality-gate.md).
- **`deploy/`** — systemd `--user` unit + install/deploy/rollback/dev/migrate scripts. See
  [`deployment.md`](deployment.md).
- **`patches/`** — currently one patch: `@earendil-works+pi-ai+0.79.1.patch` makes the Anthropic
  provider surface the **raw provider `stop_reason`** in its error message (instead of "An unknown
  error occurred"), so the mid-stream-interruption retry path in `task-manager.ts` is diagnosable.
  `patch-package` applies it on `postinstall` and `deploy.sh` applies it explicitly per release.

### Data flow (request → response)

1. Browser sends `POST /api/sessions/:id/messages` (bearer token) or the user opens a session.
2. `server.ts` authenticates, routes to `AgentManager.sendMessage`, which opens/reuses the session's
   `AgentHarness` and prompts (or steers, if a run is in flight).
3. The harness runs the agent loop: it composes the system prompt (persona + memory brief + skills table
   + context files), streams model output, and **dispatches tool calls** to the wired tools — file/
   shell tools resolve against the session's workdir; `delegate` spawns a background subagent; `cog_*`
   tools call the in-process memory module.
4. State changes are written **JSONL-first** (the pi session tree, or a store's event log), then
   mirrored into the sqlite index, then emitted on the `EventBus`.
5. The WebSocket relays harness/metadata events to subscribed clients; the UI streams the assistant's
   tokens live and updates the sidebar/task cards. The REST response to the POST is a `202` ack — the
   real output arrives over the WebSocket.

## Key patterns (what an agent must know)

- **JSONL is canonical; sqlite is rebuildable.** Every durable write goes to JSONL first, then the
  index. The index is dropped+rebuilt from JSONL on boot (and on schema-version bump). If deleting
  `index.db` would lose data, that's a bug. → [`storage.md`](storage.md)
- **Tools are explicit factories, split by cwd-dependence.** No auto-registry; wire new tools in
  `index.ts`. cwd-bearing tools are rebuilt per session/task. Tool authors must keep **absolute paths**
  in mind — a subagent's relative paths resolve against the *parent* workdir. → [`tools.md`](tools.md)
- **Skills are markdown, discovered from two dirs with the user dir winning.** Seeded skills
  (`server/skills/`) are copied into `~/.ytsejam/data/skills/` only if absent. North-star bias:
  **skills are cheap, server code is expensive** — prefer a skill over the existing tools to a new
  server feature. → [`skills.md`](skills.md)
- **Delegation runs in-process background subagents** with concurrency cap `YTSEJAM_TASK_CONCURRENCY`
  and per-task timeout `YTSEJAM_TASK_TIMEOUT_MIN`. **Subagents cannot delegate further** (the tools
  aren't wired into the worker toolset). → [`delegation.md`](delegation.md)
- **The quality gate is `scripts/gate.sh`** — server typecheck + server tests + ltm tests + web
  build/typecheck + web tests, in that order. **There is no CI; the gate is the bar.** →
  [`quality-gate.md`](quality-gate.md)
- **Subagent worktree gotcha:** the harness shell inherits `NODE_ENV=production`, so a bare
  `npm install` skips devDeps the gate needs. Symlink `node_modules` from a good checkout, or install
  with `env -u NODE_ENV npm ci --include=dev`; the gate clears `NODE_ENV` itself. → [`delegation.md`](delegation.md)
- **Memory is in-process, with two substrates.** Cog memory (markdown SSOT under `<dataDir>/memory/`)
  is the human-readable one the `cog_*` tools talk to. LTM (`packages/ltm`, opened against
  `<dataDir>/ltm/`) is a derived episodic+semantic index that cog observation writes mirror into via
  the **cog→LTM bridge**. Prod and dev isolate both by data dir. The assistant degrades gracefully
  if either substrate fails (LTM is wrapped in a try/catch at boot; bridge failures don't fail the
  cog write). → [`storage.md`](storage.md), [`memory-bridge.md`](memory-bridge.md),
  `server/src/memory/README.md`.
- **Crash-safety via event-sourcing:** tasks and schedules record their state-changing event *before*
  the side effect (a cancel before abort; a schedule fire before inject), so a crash never
  double-fires and recovery is a fold over the log.
- **Compaction has three entry points and explicit telemetry.** `idle`, `inner_loop`, and
  `reactive_path` all flow through the same pure `buildCompactionEvent()` and emit
  `compaction_start`/`compaction_end` bus events plus a `.compactions.jsonl` sidecar with the
  `entry_point` label. A "successful" compaction is gated on `tokensAfterEstimated < budget`, not
  just on the trim running to completion. → [`observability.md`](observability.md)

## Configuration

`loadConfig()` in `server/src/config.ts` is authoritative. Key env vars:

| Var | Default | Purpose |
| --- | --- | --- |
| `YTSEJAM_AUTH_TOKEN` | **required** | shared bearer login token (checked on every `/api/*` request and at WS connect) |
| `YTSEJAM_PORT` | `3000` (prod unit sets `9873`) | HTTP port |
| `YTSEJAM_DATA_DIR` | `./data` (prod unit sets `~/.ytsejam/data`) | JSONL SSOT + `index.db` + cog `memory/` + `ltm/` |
| `YTSEJAM_WEB_DIST` | `../web/dist` (prod unit sets the release's) | built web assets to serve |
| `YTSEJAM_DEFAULT_MODEL` | `anthropic/claude-sonnet-4-6` | `provider/modelId`, must exist in the pi-ai catalog |
| `YTSEJAM_SUBAGENT_MODEL` | = default model | model for delegated subagents |
| `YTSEJAM_DISABLE_COPILOT_LIVE_CATALOG` | unset | set `1` to skip the Copilot `/models` boot fetch and use pi-ai's static catalog only |
| `YTSEJAM_TASK_CONCURRENCY` | `4` (clamped ≥1) | max concurrent subagent tasks |
| `YTSEJAM_TASK_TIMEOUT_MIN` | `15` (clamped ≥1) | per-task timeout in minutes |
| `YTSEJAM_GENERATE_TITLES` | `true` | LLM-generated session titles |
| `YTSEJAM_CONTEXT_FILES` | `true` | auto-load `AGENTS.md`/`CLAUDE.md` into the prompt |
| `YTSEJAM_COMPACTION_ENABLED` | `true` | emergency kill-switch for all compaction (idle/inner-loop/reactive) |
| `YTSEJAM_PI_AUTH` | `~/.pi/agent/auth.json` | pi CLI OAuth credentials (Copilot/Codex subscriptions) |
| `LTM_STORE_DIR` | `<dataDir>/ltm` | LTM substrate directory (single-writer). Empty-string falls through to default. |
| `LTM_RECONCILE_INTERVAL_MS` | `300000` (5 min) | cog→LTM back-fill reconciler tick interval |
| `BRAVE_API_KEY` | — | enables the `web_search` tool |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, … | — | enabling a provider's key adds its models to the picker |

Config files:

- **Prod env file:** `~/.ytsejam/ytsejam.env`, mode **0600**, not in git. Seeded by `deploy/install.sh`
  from `deploy/ytsejam.env.example`. Read by the systemd unit *after* its own `Environment=` defaults,
  so a key set there wins — except the pinned ones (`NODE_ENV=production`). Path defaults live in the
  unit (via `%h`), because systemd doesn't expand `${HOME}`/`~` in an `EnvironmentFile`; override a
  path there only with an **absolute** path.
- **Dev:** `deploy/dev.sh` sets every isolation-critical var inline (port 3000, throwaway data dir,
  this checkout's `web/dist`) and clears `NODE_ENV`.

## Subsystem docs

- [`storage.md`](storage.md) — JSONL layout (sessions, tasks, schedules, persona, skills, workdirs,
  archive, memory, ltm), the sqlite index schema/role, rebuild semantics, memory-module internal
  shape, auto-commit cadence, and where each kind of data lives.
- [`tools.md`](tools.md) — how tools are registered/called, the cwd-binding split, the full tool
  surface (including `recall` and the `cog_rpc` allow-list), and the absolute-path rule for
  subagent file tools.
- [`skills.md`](skills.md) — seeded vs user skill discovery + precedence, runtime invocation, skill
  file structure, and the "skills are cheap, server code is expensive" bias.
- [`delegation.md`](delegation.md) — how `delegate` works, the background-task lifecycle, concurrency/
  timeout config, the no-nested-delegation rule, subagent absolute-path requirement, and the
  `NODE_ENV=production` install workaround.
- [`memory-bridge.md`](memory-bridge.md) — the cog→LTM bridge: two write paths (inline +
  reconciler), public surface (`attachLtm`/`attachReconciler`/`recordObservation`/`getLtm`),
  `recall()` semantics, the `server/src/cli/` LTM subcommands, and the health surface that drives
  the web brain icon.
- [`observability.md`](observability.md) — the `EventBus`/`ServerEvent` union, compaction
  telemetry (three entry points, `compaction_start`/`compaction_end`, the `entry_point` field, the
  per-session `.compactions.jsonl` sidecar), health icons in the chat header, and
  `/api/memory/health`.
- [`deployment.md`](deployment.md) — systemd `--user` unit, `current`→release symlink, `deploy.sh`
  flow with auto-rollback, `dev.sh` isolation, and `migrate-data.sh` semantics.
- [`quality-gate.md`](quality-gate.md) — what `scripts/gate.sh` runs, in what order, how to read a
  failure, and when to run it.

The themed lessons files — `architecture.md`, `documentation.md`, `planning.md`, `quality-gate.md`,
`release-workflow.md`, `security.md`, `testing.md`, `tooling.md` — are append-only logs of
fix-cycle lessons captured by the `lessons` skill (see `contrib/skills/lessons/SKILL.md`). They
read as a sequence of `## <Title>` paragraphs and are best skimmed when working in the relevant
area.
