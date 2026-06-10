# ytsejam

Web-based personal AI assistant built on the [pi agent harness](https://github.com/earendil-works/pi).
JSONL files are the source of truth; sqlite is a derived index. Spec and plans in `docs/superpowers/`.
The assistant can delegate long-running research or multi-step work to background subagents via the `delegate` tool; subagents run concurrently, and the assistant is notified and takes a turn when each completes or fails.

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
| `YTSEJAM_DEFAULT_MODEL` | `anthropic/claude-sonnet-4-6` | `provider/modelId` |
| `YTSEJAM_GENERATE_TITLES` | `true` | LLM session titles |
| `YTSEJAM_PI_AUTH` | `~/.pi/agent/auth.json` | pi CLI OAuth credentials (Copilot/Codex subscriptions) |
| `ANTHROPIC_API_KEY` etc. | — | enables that provider in the model picker |
| `BRAVE_API_KEY` | — | enables the web_search tool |
| `YTSEJAM_SUBAGENT_MODEL` | same as `YTSEJAM_DEFAULT_MODEL` | `provider/modelId` used for delegated background subagents |
| `YTSEJAM_TASK_CONCURRENCY` | `4` | max number of subagent tasks running at once |
| `YTSEJAM_TASK_TIMEOUT_MIN` | `15` | per-task timeout in minutes before the subagent is aborted |

## Development

    npm run dev:server   # API on :3000 (set YTSEJAM_AUTH_TOKEN)
    npm run dev:web      # UI on :5173, proxies /api
    npm test             # server tests (vitest, faux LLM provider, no network)
    npm run check        # typecheck
