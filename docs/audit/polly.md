# ytsejam Capability Audit (polly)

> Date: 2026-06-22
> Method: two independent read-only investigations dispatched by polly
> (claude_code = current-state inventory, codex = prioritized gap analysis).
> No code was changed during the audit.

## TL;DR

`ytsejam` is a strong **generalist assistant** (mature memory system,
delegation, scheduling, approvals, skills, compaction) but a **weak coding
agent**: the execution tooling is thin. The highest-impact fixes, in order:

1. A real **patch/diff edit tool** (atomic, multi-hunk).
2. **Git tooling** for the user's working directory.
3. A **test/build runner** tool.
4. A **persisted plan/todo state** for multi-step tasks.
5. A **workspace sandbox** + read-only/escalation approval mode.

---

## Report A — Current-State Inventory (claude_code)

**What it is:** A web-based, multi-session personal AI assistant built on the
**pi agent harness** (`@earendil-works/pi-agent-core` + `pi-ai`, v0.79.1).
Node >=22 monorepo (`server`, `web`, `packages/ltm`). JSONL session transcripts
are the source of truth; SQLite is a derived, rebuilt-on-boot index. It is a
**generalist agent** with *some* coding-agent affordances — not a dedicated
coding agent.

### 1. High-level architecture
- Server boot: `server/src/index.ts` (config → indexer → EventBus → manager →
  tasks/scheduler → LTM bridge; graceful drain at `index.ts:454-562`). CLI
  short-circuit at `index.ts:56`.
- CLI namespace `ytsejam ltm …`: `server/src/cli/dispatch.ts:49-145`.
- Web UI: `web/src/main.tsx` (React + Vite, PWA).
- Transport (`server/src/server.ts`): Hono + node-ws, default `127.0.0.1:3000`;
  single shared bearer token; `/api/ws` event stream + `/api/terminal/ws` pty.
- Session/turn lifecycle (`server/src/manager.ts`): per-session `AgentHarness`
  at `manager.ts:393`; `sendMessage()` → `harness.prompt()` at `:858`.
- Data: JSONL SSOT + derived SQLite `index.db` rebuilt on boot.

### 2. LLM integration — Copilot-first
- Provider abstraction from pi-ai (`server/src/models.ts`); auth via
  `~/.pi/agent/auth.json` (`pi-auth.ts`), env keys override OAuth.
- Live Copilot catalog merged at boot (`copilot-live-catalog.ts`); default
  model `anthropic/claude-sonnet-4-6` (`config.ts:34`).
- Auxiliary LLM work also via Copilot: embeddings
  (`packages/ltm/src/embedding/copilot-embedder.ts`, `text-embedding-3-small`),
  fact extraction (`server/src/memory/fact-extractor.ts`, `claude-haiku-4.5`).
- Streaming is event-level (not token-level). Retries owned by
  pi-agent-core + dangling-tool-call recovery / reactive compaction.

### 3. Agent capabilities that exist today
- Tool-use via harness; tools assembled in `tools/index.ts:20`.
- File ops (`tools/files.ts`): `read` (50KB cap), `write` (overwrite), `edit`
  (exact unique-text replace), `ls`.
- Shell (`tools/shell.ts`): `bash -c`, 120s timeout, 50KB output cap; plus
  interactive PTY (`terminal.ts`).
- Search (`tools/search.ts`): `grep -rnE` / `find`, capped 200 / 30s.
- Web (`tools/web.ts`): `web_fetch` + `web_search` (Brave).
- Delegation/subagents (`tools/delegation.ts`, `task-manager.ts`): async
  `delegate`, `check_task`, `cancel_task`; no nested delegation.
- Scheduling (`tools/scheduling.ts`, `scheduler.ts`): one-shot `at` / `cron`.
- Skills (`tools/skills.ts`), approvals (`approval/*`, modes `yolo`/`ask`),
  context compaction (`compaction.ts`), memory tools (`tools/cog.ts`).

### 4. Memory subsystem
- **LTM package** (`packages/ltm/src/`): semantic facts (`semantic/store.ts`,
  reinforcement/contradiction/decay), episodic (`episodic/store.ts`), hybrid
  retrieval (`retrieval/retriever.ts`: vector + BM25 + recency + salience),
  embedders (Hash/Cached/Copilot/Ollama).
- **cog consolidated memory** (`server/src/memory/consolidated/`): markdown
  tiers, domains, glacier cold storage, generated skills.
- Runtime recall (`server/src/memory/recall.ts`): merges cog + LTM.
- Bridge (`server/src/memory/bridge/`): mirrors cog observations → LTM.
- Dreaming (`server/src/memory/dream/`): nightly canonicalize/dedup + LLM miner.

### 5. Coding-agent-specific features
- Per-session working dirs (`workdirs.ts`); auto-loaded `AGENTS.md`/`CLAUDE.md`
  context (`context-files.ts`).
- **Git: only for the internal memory store** (`memory/store/git.ts`), NOT
  user repos.
- Editing: exact-text replace only — no diff/patch, no line-range edits.
- Tests/build: no wrappers — only generic `bash`.
- Search: regex only — no AST/semantic navigation.

### 6. Half-built / stubbed / flagged
- Feature flags: `YTSEJAM_COMPACTION_ENABLED`, `DREAM_ENABLED`,
  `YTSEJAM_DISABLE_COPILOT_LIVE_CATALOG`, `YTSEJAM_CONTEXT_FILES`,
  `YTSEJAM_GENERATE_TITLES`.
- Unused stub `notImplemented()` (`server/src/memory/index.ts:63-65`).
- Dev-only: `packages/ltm/src/bench/run.ts`, `eval/*`.
- No significant broken/half-built runtime features.

---

## Report B — Prioritized Capability Gaps (codex)

1. **No real sandbox or workspace boundary.** Absolute paths allowed
   (`tools/files.ts:7`), `write` overwrites directly (`files.ts:35`), shell runs
   `bash -c` on host (`shell.ts:54`), sessions default to `yolo`
   (`manager.ts:251`). Approval modes only `yolo`/`ask` (`approval/types.ts:2`).
2. **Tool surface too small for serious coding.** Only `bash, read, write,
   edit, ls, grep, find` (`tools/index.ts:20`). No patch, AST, LSP, browser,
   test runner, or repo-index tool.
3. **Edit application is fragile.** `write` whole-file overwrite (`files.ts:26`);
   `edit` single exact-unique substring then full rewrite (`files.ts:43-57`).
   No unified diff / multi-hunk / line-range / atomic edits.
4. **Agentic loop is prompt-driven, not stateful.** Planning lives in persona
   prompt (`persona.ts:69`); `sendMessage()` passes raw text to `harness.prompt()`
   (`manager.ts:858`). No persisted plan/checklist/state machine.
5. **Error recovery incomplete.** Main chat handles only classified overflow
   (`manager.ts:597`); prompt rejections only logged (`manager.ts:876`).
   Subagents have one-shot retry (`task-manager.ts:601`); main chat does not.
6. **Context-window recovery can lose the task.** Reactive retry is "NOT a
   byte-for-byte replay" (`compaction.ts:211`); post-compaction only a generic
   retry prompt (`manager.ts:570`).
7. **Large repo/file handling weak.** Whole-file read + truncate (`files.ts:20`),
   50KB shell cap (`shell.ts:5`), shallow `ls` (`files.ts:67`), 200-result
   search caps (`search.ts:22`). No range/tail reads or paging.
8. **Search is basic shell search.** `grep -rnE` (`search.ts:17`), POSIX `find`
   (`search.ts:40`). No `rg`, `.gitignore` awareness, type filters, symbol
   search.
9. **No LSP / AST / symbol awareness.** Only basic tools (`tools/index.ts:20`);
   no LSP/tree-sitter/ts-morph deps (`server/package.json:15`).
10. **Memory recall loses reliability signals.** Recall hits have
    `where/score/stale/tags` (`recall.ts:82`) but injection keeps only
    source+text (`memory-section.ts:33`); failures swallowed (`:37`).
11. **LTM misses tool-result knowledge by default.** `includeToolResults`
    defaults false (`reader.ts:19`); tool-result messages return empty text
    (`reader.ts:81`).
12. **Prompt-injection boundary thin.** `web_fetch` returns page text directly
    (`web.ts:12,21`); repo context files injected without strong trust framing
    (`persona.ts:37,60`).
13. **Cancel/stop not dependable.** Shell has timeout but no abort signal
    (`shell.ts:11,30`); web calls lack timeout/abort (`web.ts:15,64`); task
    cancel may hold for minutes (`task-manager.ts:179`).
14. **Web capability thin.** Brave-only `web_search` (`web.ts:49`); no browser
    rendering, screenshots, PDF, cache, retry, or quota handling.
15. **Observability/operational UX limited.** In-memory-only EventBus
    (`events.ts:35`); dropped events on WS disconnect (`web/src/lib/ws.ts:16`);
    CLI only owns `ltm` (`cli/dispatch.ts:9`).

---

## Recommended first parallel batch

| Task | Scope | Why first |
| --- | --- | --- |
| Patch/diff edit tool | New `apply_patch`-style tool with atomic multi-hunk edits + clear conflict errors | Fixes the single most error-prone coding operation (gaps 2, 3) |
| Git working-dir tooling | New git tool(s) scoped to the session workdir: status/diff/log/add/commit/branch | Restores the defining coding-agent workflow (gap: §5 "git only for memory store") |

Subsequent batches: test/build runner, persisted plan/todo state, workspace
sandbox + read-only/escalation approval mode.
