# Design: Per-session working directory + repo context files + composer button row

**Status:** SHIPPED 2026-06-11 — merged to `main` (commits `d0d774d` per-session cwd, `e8a3ab5` subagent inheritance, `9f6198e` context-files, `14a519d` cwd API, `e14d598` web composer); live in prod release `20260611-110817`. Verified at runtime (agent `pwd` returned the set dir).
**Project:** ytsejam
**Touches server/src:** YES — `Justify-server-change:` cited at commit.
**Related:** [[wiki/topics/harness-check/index]], cog `projects/ytsejam/observations.md` 2026-06-11 context-files finding

**As built (deviations from draft):**
- **SSOT mechanism = ytsejam-side sidecar** (`server/src/workdirs.ts`), per-session JSONL events folded latest-wins, default = data dir — NOT an in-session harness marker (pi-agent-core's `JsonlSessionMetadata.cwd` is create-only and is the session home, confirmed; don't touch it). **The archive feature reuses this `workdirs.ts` pattern.**
- Per-session cwd-bearing tools (bash/read/write/edit/ls/grep/find) moved to a per-session build resolved against the session's workdir; web/search tools stayed global.
- Web v1 = absolute-path text **Dialog** (no directory browser), using the existing `Dialog`/`Input` primitives; the dialog POSTs via raw `fetch` (not the `api()` helper) so it can read the 400 error body. Working-dir button disabled until a session exists.
- Built via delegated subagents; the first timed out at the old 15-min cap mid-step-4 → recovered (steps 1–3 + step-4 server were committed-green; a scoped follow-up subagent finished the web composer).

---

## Problem

Three coupled gaps, one feature:

1. **No per-session working directory.** Tool cwd is baked once at boot — `index.ts` calls `createTools(config.dataDir)` and every file/shell tool closes over that single `dataDir`. So "we're working on cogmemory" requires absolute paths or `cd` in every `bash` call. omnius had a per-session cwd selector and it removed exactly this friction.

2. **Subagents are pinned to `dataDir/subagent`.** `task-manager.ts` hardcodes `SUBAGENT_CWD = "subagent"` and roots `NodeExecutionEnv` at `dataDir`. Even with a chat-session cwd, delegated work lands in the wrong place.

3. **No repo context-file loading.** ytsejam is built on `pi-agent-core` (bare harness), not `pi-coding-agent` (the CLI). The CLI auto-loads `AGENTS.md`/`CLAUDE.md`; ytsejam re-implements the prompt layer in `persona.ts` and does none of it. So project conventions are invisible to both the chat agent and subagents.

All three resolve against the same value: **a per-session working directory.** Set it once per thread; tools resolve there, subagents inherit it, and context files are loaded from it.

## Non-goals

- A file picker / directory browser UI. v1 is a text input of an absolute path (+ recent list). A browser can come later.
- Sandboxing or path jails. The bash tool already runs with the server user's full rights; scoping cwd is ergonomics, not a security boundary.
- Changing `YTSEJAM_DATA_DIR`. That stays ytsejam's own state dir. Working dir is orthogonal and per-session.

---

## Design

### Source of truth: ytsejam-side per-session state (NOT the harness session cwd)

**Verified in `pi-agent-core` types:** `JsonlSessionMetadata` has a `cwd: string`, but it is fixed at `repo.create({ cwd })` and `SessionRepo` exposes **no cwd mutator** (only create/open/list/delete/fork). In pi's model that `cwd` is the *session's home directory* — `list({ cwd })` filters by it and sessions are organized under it. ytsejam passes the constant `SESSIONS_CWD` there. **Do not repurpose or try to mutate the harness `cwd`** — that fights the framework (cf. patterns.md "don't fight a framework that owns the process").

Instead, the **agent working directory is ytsejam's own per-session state**, distinct from the harness session home. Persist it in the session JSONL as a typed event ytsejam writes/folds itself — `{ type: "workdir_set", dir, timestamp }`, latest wins — exactly the `schedules.ts` pattern (JSONL events are SSOT, sqlite/UI derived). Default = `YTSEJAM_DATA_DIR` when unset (preserves today's behavior). It survives restart and applies on the next run.

(If appending custom typed entries to the harness's JSONL is awkward, fall back to a tiny ytsejam-owned sidecar keyed by session id, e.g. a `workdirs` table in the derived index seeded from a `workdir/` JSONL — but prefer in-session events so the working dir travels with the session on fork/clone.)

### Server: move cwd-bearing tools from global to per-session

Today (`manager.ts:143`):
```
tools: [...this.opts.tools, ...(this.opts.sessionTools?.(id) ?? [])]
```
`this.opts.tools` includes the cwd-bearing file/shell tools, built once. **Change:** the file/shell tools (`createBashTool`, `read/write/edit/ls/grep/find`) move into the per-session `sessionTools(sessionId)` factory, built against *that session's* resolved cwd. The cog tools and skill tool stay global (cwd-independent).

- `createTools(cwd)` already takes a cwd arg — call it per session instead of once at boot.
- `sessionTools(sessionId)` already exists as the injection seam (delegation/scheduling use it). The file/shell tools join it.
- `wire()` resolves the session's stored cwd before building its tool set.

### Server: subagent inherits parent cwd

`task-manager.ts` `delegate()` already receives `parentSessionId`. Resolve the parent session's cwd and:
- root the subagent `NodeExecutionEnv` at it (instead of `dataDir`), and
- run the context-file walk against it (below).
Keep the `subagent/` sessions-root for the subagent's *own* JSONL transcript (that's storage, separate from its working cwd).

### Server: repo context-file loading (mirror pi-coding-agent)

Faithful port of pi-coding-agent's documented "Context Files" behavior:
1. Walk: `~/.pi/agent/AGENTS.md` (global) → up the parent chain from the resolved cwd → cwd itself.
2. Match `AGENTS.md` **or** `CLAUDE.md` at each level.
3. Concatenate all matches (global first, then nearest-last or document the order).
4. Inject into the system prompt (`composeSystemPrompt`) for the chat agent and into the subagent's context (`composeWorkerPrompt`).
5. Opt-out: env `YTSEJAM_CONTEXT_FILES=false` (mirrors `--no-context-files`).

New module `server/src/context-files.ts`: `loadContextFiles(cwd: string, opts): string`. Pure, testable (point at a temp tree). Cap total injected size (e.g. 32 KB) to avoid a giant AGENTS.md blowing the prompt.

### Web: composer button row (the UI anchor)

**Now:** one flex row — `Textarea` and `Send`/`Stop` side by side (`Chat.tsx` ~line 73).

**After:** two stacked regions inside the composer container:
```
┌─────────────────────────────────────────────┐
│ Textarea (full width)                         │
├─────────────────────────────────────────────┤
│ [📁 ~/projects/cogmemory]          [ Send ]  │   ← button row
│  left-aligned                    right-aligned │
└─────────────────────────────────────────────┘
```
- Outer container becomes `flex-col gap-2`.
- Textarea: full width (drop `flex-1` side-by-side; it's now the top block).
- Button row: `flex items-center justify-between`. **Left:** working-directory button (shows current dir basename, or "set working dir" when default). **Right:** `Send` (or `Stop` when running). This row is the future home of attachment / other buttons — left cluster grows left-to-right, Send stays pinned right.
- Working-dir button opens a small popover/dialog: text input for an absolute path + a list of recent dirs for this install; on submit, calls a new API.
- Mobile: row already fits; basename-only label keeps it short. Touch target ≥44px (we have the `@media (pointer:coarse)` rule from the audit).

### API

- `POST /api/sessions/:id/cwd  { cwd: string }` → validates the path exists + is a dir, persists the cwd event, returns the resolved cwd. Rejects non-existent/non-dir with 400.
- Session GET payload gains `cwd` (resolved, for the UI to render the button label).
- Recent-dirs list: derive from distinct cwds across sessions (indexer can expose it) or keep a small `~/.ytsejam/recent-dirs` — decide at build (lean: derive from sessions, no new file).

---

## Implementation order (each step independently shippable + dogfooded)

1. **Server cwd plumbing (no UI):** persist + fold a per-session cwd (default = dataDir), move file/shell tools into `sessionTools` built against it. Test: open session, set cwd via a temp API or direct JSONL, confirm `bash pwd` reflects it; confirm a second session is unaffected. **Ship + dogfood before UI.**
2. **Subagent cwd inheritance:** subagent roots at parent cwd. Test: delegate from a session with cwd=X, confirm subagent `bash pwd` = X, transcript still under `sessions/subagent/`.
3. **Context-file loading:** `context-files.ts` + injection into both prompts + opt-out env. Test: temp tree with AGENTS.md at two levels, assert concatenation + cap + opt-out.
4. **API + web button row:** the composer relayout + working-dir popover + `POST .../cwd`. Browser smoke at desktop + 375/390/430 mobile widths.

Dogfood: give the implementation its own plan file (this one) and set this repo's session cwd to `~/projects/ytsejam` as the first real use of step 1.

## Justification (harness-not-tools gate)

This crosses into `server/src`, so it must clear the bar. It does:
- It does NOT re-implement a tool — it makes the EXISTING tool surface (bash/read/write/edit + delegate) resolve against the repo, which is the "context lives in the repo" principle. A skill cannot do this: cwd resolution and prompt assembly are harness-internal.
- Context-file loading is a faithful port of a DOCUMENTED upstream convention (pi-coding-agent), not an invention.
- It deletes friction (no `cd` per command; conventions auto-loaded) rather than adding surface. Net ergonomics up, tool count unchanged.
`Justify-server-change:` trailer at commit should cite this section.

## Open questions

- ~~Does `pi-agent-core`'s `JsonlSessionMetadata` allow a writable cwd?~~ **RESOLVED:** it has `cwd` but it's create-only, no mutator, and it's the session's *home* dir (filters `list`). Don't touch it — track the agent working dir as ytsejam-side per-session state (see Source of truth §).
- `NodeExecutionEnv` cwd: it's set at construction (`new NodeExecutionEnv({ cwd })`). The bash/file tools take their own `cwd` arg (`createBashTool(cwd)`, `resolve(cwd, p)` in files.ts) independent of the env — so per-session tool cwd is achievable by passing the resolved working dir into the per-session `createTools(cwd)` call WITHOUT needing a new env per session. Confirm the bash tool's spawn cwd is the tool arg (it is: `shell.ts` `spawn(file, args, { cwd })`), not the env.
- Context-file concatenation order + whether to surface which files loaded (pi-coding-agent shows them in its startup header). Defer surfacing; load silently in v1.
- Recent-dirs: derive from distinct ytsejam-side workdirs vs. a small state file. Lean toward derive.
