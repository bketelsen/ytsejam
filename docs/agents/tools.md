# Tools

> Sub-doc of [`OVERVIEW.md`](OVERVIEW.md). Read this before adding or changing a tool. Tool code
> lives in `server/src/tools/`.

A "tool" is a function the LLM can call mid-turn. ytsejam tools are plain objects implementing
pi-agent-core's `AgentTool<TParams>` interface; the harness exposes them to the model and runs
`execute` when the model calls them.

## The registration pattern

There is no decorator/auto-discovery registry. A tool is a factory function returning an
`AgentTool`, and tools are wired explicitly at boot in `server/src/index.ts`. The shape (from
`server/src/tools/files.ts`, `read` tool):

```ts
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const readParams = Type.Object({ path: Type.String() });

export function createReadTool(cwd: string): AgentTool<typeof readParams> {
  return {
    name: "read",                              // the name the model calls
    label: "Read file",                        // human label for the UI
    description: "Read a text file. ...",       // model-facing doc
    parameters: readParams,                     // typebox schema (validated by the harness)
    execute: async (_id, params) => {
      const text = await fs.readFile(resolve(cwd, params.path), "utf8");
      return { content: [{ type: "text", text: truncate(text) }], details: {} };
    },
  };
}
```

Conventions every tool follows:

- **Schema via `Type.*`** (typebox, re-exported from `@earendil-works/pi-ai`). The harness validates
  args against it before calling `execute`, so `params` is typed.
- **Return `{ content: [{ type: "text", text }], details }`.** `content` is what the model sees;
  `details` is structured metadata surfaced in the transcript UI (e.g. `{ exitCode }` from `bash`).
- **Throw to signal a tool error** — the harness turns a thrown error into a `toolResult` with
  `isError`. Don't return error strings as success.
- **Cap output.** Shared `truncate()` (`shell.ts`) clamps at `MAX_TOOL_OUTPUT = 50_000` chars (web
  fetch uses 30k). grep/find additionally cap at 200 lines.

## cwd binding — the rule that matters for subagents

Tools split into two groups, assembled by `server/src/tools/index.ts`:

- **`createGlobalTools()`** — cwd-*independent* tools, built once at boot and shared by every
  session and subagent: `web_search`, `web_fetch`. Safe to share because they never touch the
  filesystem.
- **`createSessionCwdTools(cwd)`** — cwd-*bearing* tools, built **per session/per task** against a
  specific working directory: `bash`, `read`, `write`, `edit`, `ls`, `grep`, `find`. Relative paths
  and `bash` invocations resolve against that `cwd`.

`AgentManager.wire()` builds the cwd tools against the session's resolved workdir; `TaskManager.run()`
builds them against the **parent session's** workdir so a subagent's files land in the same repo the
user is talking about. `applyWorkdirChange()` rebuilds them live when the workdir changes mid-session.

**Tool-author rule: never assume the cwd a tool will be bound to.** The file tools `resolve(cwd, p)`
so an *absolute* path always wins and a *relative* path lands in whatever cwd the harness bound. This
matters most for subagent file tools: a subagent (and any agent writing the subagent's `task` prompt)
must use **absolute paths** for anything outside the parent workdir, because the subagent's relative
paths resolve against the parent workdir, not the data dir. The worker system prompt
(`composeWorkerPrompt` in `persona.ts`) states the bound workdir explicitly for this reason. See
[`delegation.md`](delegation.md).

## Tool surface (what the model can call)

Built at boot in `index.ts`. Global + cog + skill tools are added to every session; cwd tools are
per-session; delegation/scheduling tools are per-session (they close over the session id).

### Filesystem / shell — `files.ts`, `shell.ts`, `search.ts` (cwd-bearing)

| Tool | File | Notes |
| --- | --- | --- |
| `bash` | `shell.ts` | `bash -c <command>` in the bound cwd; combined stdout+stderr + exit code; default 120s timeout (param `timeoutSeconds`), SIGKILL on timeout. |
| `read` | `files.ts` | read a text file; relative → bound cwd. |
| `write` | `files.ts` | write a file, creating parent dirs; overwrites. |
| `edit` | `files.ts` | replace an **exact, unique** substring (errors if 0 or >1 matches). |
| `ls` | `files.ts` | list a directory (default `.`). |
| `grep` | `search.ts` | `grep -rnE` recursive regex; capped at 200 lines. |
| `find` | `search.ts` | `find <path> -name <glob>`; capped at 200 lines. |

### Web — `web.ts` (global)

| Tool | Notes |
| --- | --- |
| `web_search` | Brave Search API. **Requires `BRAVE_API_KEY`** or the tool throws a configuration error. Returns titles/URLs/snippets; `count` default 8, max 20. |
| `web_fetch` | Fetch a URL, convert HTML→text via `html-to-text` (scripts/style/nav stripped); 30k cap. |

### Delegation — `delegation.ts` (per-session)

| Tool | Notes |
| --- | --- |
| `delegate` | Start a background subagent. Params: `task` (self-contained instructions), `label`, optional `context`, optional `model`. Returns immediately with a task id. **Description tells the model: subagents cannot delegate further.** |
| `check_task` | Status of a task by id (status + elapsed + result summary). |
| `cancel_task` | Cancel a pending/running task by id. |

The `TaskManager` is late-bound through a `() => taskManager` getter because it's constructed after
the `AgentManager` at boot. See [`delegation.md`](delegation.md).

### Scheduling — `scheduling.ts` (per-session)

| Tool | Notes |
| --- | --- |
| `schedule` | One-shot (`at`, ISO 8601) **or** recurring (`cron`, 5-field, **server local time**) — exactly one. `target` is `this_session` (default) or `new_session`. The scheduled `prompt` arrives later as a `[Scheduled task ...]` injected message. |
| `list_schedules` | List schedules with status + next fire. |
| `cancel_schedule` | Cancel an active schedule by id. |

The `SchedulerService` is late-bound the same way the `TaskManager` is.

### Skills — `skills.ts` (global)

| Tool | Notes |
| --- | --- |
| `skill` | Load a skill playbook by name and follow it. The model calls this when the user types `/<name>` or the conversation matches a skill's "invoke when" row. See [`skills.md`](skills.md). |

### cog memory — `cog.ts` (global)

Tools over the in-process memory module.

File-style ops: `cog_read`, `cog_write`, `cog_append`, `cog_patch`, `cog_outline`, `cog_search`,
`cog_list`, `cog_move`. Plus `recall`, the unified cog-+-LTM retrieval tool (see below), and
`cog_rpc`, a single tool that fans out to a fixed allow-list of consolidated methods
(`session_brief`, `domain_summary`, `housekeeping_scan`, `open_actions`, `recent_observations`,
audits, index computations, `domains.list/get`, `stats`, `git`, `health`, `reconcile_now`, …).
The method list is the `RPC_METHODS` const in `cog.ts`; file operations are deliberately excluded
from `cog_rpc` so they go through their dedicated tools. These names mirror the cog skill
vocabulary so skill playbooks port verbatim.

**`cog_append` to a `*/observations.md` path** is intercepted: each line is parsed, then
`memory.recordObservation()` is called per line, which writes the cog SSOT line **and** best-
effort mirrors it to LTM as a `kind: "observation"` record. All lines are validated before any
write so a malformed line in the middle of a batch aborts before partial cog/LTM divergence.
See [`memory-bridge.md`](memory-bridge.md).

**`cog_rpc({method:"reconcile_now"})`** force-ticks the LTM reconciler. Useful right after a bulk
external edit to `observations.md` files (so the back-fill doesn't wait the full
`LTM_RECONCILE_INTERVAL_MS` window).

| Tool | Notes |
| --- | --- |
| `recall` | **Unified recall across cog full-text search and LTM semantic retrieval.** Single `query` arg; returns interleaved hits from both substrates (top 5 each, alternating `cog[0], ltm[0], cog[1], ltm[1], …`), deduped by origin (cog wins on collision). Each hit is labeled `from: "cog" \| "ltm"`. Use this rather than `cog_search` when looking up "what do I know about X" — past conversations consolidated into LTM only surface here. See [`memory-bridge.md`](memory-bridge.md) § Recall. |

## Adding a tool — checklist

1. Write a `createXTool(...)` factory in a file under `server/src/tools/` (group with a peer if it
   fits). Decide: is it cwd-independent (global) or cwd-bearing (per-session)?
2. Define a typebox `Type.Object({...})` params schema with `description`s — the descriptions are the
   model's only doc.
3. Return `{ content, details }`; throw on error; cap large output with `truncate()`.
4. Wire it in `server/src/index.ts`: add to `createGlobalTools()`/`createSessionCwdTools()` (in
   `tools/index.ts`) for the all-sessions/cwd sets, or to the `tools`/`sessionTools` arrays passed to
   `AgentManager`. If subagents should also get it, add it to `workerTools` in the `TaskManager`
   construction (cwd-independent) or `createSessionCwdTools` (cwd-bearing).
5. If it has runtime config (an API key, a socket), read it in `config.ts` and thread it through —
   don't read `process.env` deep inside `execute` unless the tool is genuinely env-only (the way
   `web_search` reads `BRAVE_API_KEY`).
6. Run the gate (`bash scripts/gate.sh`) — server typecheck + tests must pass. See
   [`quality-gate.md`](quality-gate.md).
