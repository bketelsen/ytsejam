# ytsejam

Web-based personal AI assistant built on the [pi agent harness](https://github.com/earendil-works/pi).
JSONL files are the source of truth; sqlite is a derived index. Spec and plans in `docs/superpowers/`.
The assistant can delegate long-running research or multi-step work to background subagents via the `delegate` tool; subagents run concurrently, and the assistant is notified and takes a turn when each completes or fails.
It can also schedule reminders and recurring jobs that wake it up (cron times are server-local).

## Prerequisites

- **Operating system:** Linux. The deploy is built around `systemd --user`, which rules out macOS and Windows. Tested on Fedora-family (snosi); Ubuntu/Debian/Arch with `systemd` should work.
- **Node.js ≥ 22.0.0** — required for the built-in `node:sqlite` module the memory store uses. Check with `node --version`.
- **`systemd` with user services.** If running headless, enable lingering so the service survives logout: `loginctl enable-linger "$USER"`.
- **`git`, `npm`, and a Bourne-compatible shell** for the install scripts.
- **~200 MB free disk** for `node_modules`; runtime data under `~/.ytsejam/data` grows with use.
- **An LLM provider credential** for runtime: one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `BRAVE_API_KEY` (for web search), or a GitHub Copilot subscription via `~/.pi/agent/auth.json`. See `deploy/ytsejam.env.example` for the current list.

## Run

    npm install
    YTSEJAM_AUTH_TOKEN=<secret> ANTHROPIC_API_KEY=<key> npm start
    # open http://localhost:3000 and sign in with the token

## Configuration (env)

| Variable | Default | Purpose |
| --- | --- | --- |
| `YTSEJAM_AUTH_TOKEN` | (required) | shared login token |
| `YTSEJAM_PORT` | `3000` | HTTP port |
| `YTSEJAM_DATA_DIR` | `./data` | JSONL sessions, persona, sqlite index |
| `YTSEJAM_WEB_DIST` | `../web/dist` | directory of the built web assets to serve |
| `YTSEJAM_DEFAULT_MODEL` | `anthropic/claude-sonnet-4-6` | `provider/modelId` |
| `YTSEJAM_GENERATE_TITLES` | `true` | LLM session titles |
| `YTSEJAM_PI_AUTH` | `~/.pi/agent/auth.json` | pi CLI OAuth credentials (Copilot/Codex subscriptions) |
| `ANTHROPIC_API_KEY` etc. | — | enables that provider in the model picker |
| `BRAVE_API_KEY` | — | enables the web_search tool |
| `YTSEJAM_SUBAGENT_MODEL` | same as `YTSEJAM_DEFAULT_MODEL` | `provider/modelId` used for delegated background subagents |
| `YTSEJAM_TASK_CONCURRENCY` | `4` | max number of subagent tasks running at once |
| `YTSEJAM_TASK_TIMEOUT_MIN` | `15` | per-task timeout in minutes before the subagent is aborted |
| `YTSEJAM_CONTEXT_FILES` | `true` | auto-load `AGENTS.md`/`CLAUDE.md` from `~/.pi/agent` and the session's working-directory ancestor chain into the system prompt (mirrors `pi-coding-agent --no-context-files`; set to `false` to disable) |

## Security model

- **Loopback by default.** ytsejam binds `127.0.0.1` — only processes on the same machine can reach it. Override with `YTSEJAM_HOST=0.0.0.0` only behind a reverse proxy you trust.
- **Single shared bearer token.** Authentication is one token (`YTSEJAM_AUTH_TOKEN`). Anyone who has it has full agent access. Treat it like an SSH key: rotate if leaked, never commit, never share over plaintext channels.
- **The agent has a `bash` tool.** A reachable, token-known endpoint is therefore a remote shell on the host. Do not expose to the public internet. Do not run ytsejam as a user with files you wouldn't want the agent to be able to read or write.
- **Subagents, schedules, and tools** (`web_fetch`, `bash`, `delegate`, file operations) run with the ytsejam process's privileges. See `docs/agents/tooling.md` if you intend to harden further.
- **Outbound traffic** goes to whichever LLM provider you configured and to URLs the agent decides to fetch via `web_fetch`/`web_search`. There is no built-in egress filter.

## Development

    npm run dev:server   # API on :3000 (set YTSEJAM_AUTH_TOKEN)
    npm run dev:web      # UI on :5173, proxies /api
    npm test             # server + web tests (vitest, faux LLM provider, no network)
    npm run check        # typecheck

## Deployment

Production runs as a single systemd `--user` service on port **9873**, isolated
from a dev instance on **3000** (different port and data dir — including
in-process memory — so they coexist safely). See [`deploy/README.md`](deploy/README.md). Quick start:

    git clone https://github.com/bketelsen/ytsejam.git
    cd ytsejam
    npm install
    deploy/install.sh                 # creates ~/.ytsejam, seeds env, installs the unit
    $EDITOR ~/.ytsejam/ytsejam.env    # set YTSEJAM_AUTH_TOKEN + provider keys
    deploy/deploy.sh                  # build + cut release + swap + restart + health-check
    systemctl --user enable --now ytsejam

Upgrading from a previous daemon-era install? Run `deploy/migrate-to-folded.sh`
before upgrading so the old cogmemory service is stopped and the store is moved
under `~/.ytsejam/data/memory`.

    deploy/dev.sh                     # run a dev instance on :3000 with throwaway data/memory
