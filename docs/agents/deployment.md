# Deployment

> Sub-doc of [`OVERVIEW.md`](OVERVIEW.md). Read this before changing anything under `deploy/`.
> Scripts: `deploy/install.sh`, `deploy/deploy.sh`, `deploy/rollback.sh`, `deploy/dev.sh`,
> `deploy/migrate-data.sh`, `deploy/sync-skills.sh`. Unit: `deploy/ytsejam.service`. Env template: `deploy/ytsejam.env.example`.
> The authoritative operator doc is `deploy/README.md`; this doc is the agent-facing summary.

## Runtime model

There is **no server build step.** The server runs TypeScript directly under Node
(`node src/index.ts`). Only the **web UI** is built (Vite → `web/dist`). A "release" is therefore:
a clean checkout of the repo + a built `web/dist` + an `npm ci`'d `node_modules`, all in an immutable
timestamped directory.

## systemd `--user` unit

Production is a **systemd user service** (`~/.config/systemd/user/ytsejam.service`), not a system
service — no root. Key facts from `deploy/ytsejam.service`:

- `WorkingDirectory=%h/.ytsejam/current/server` — `%h` is `$HOME`; the unit is user-portable (no
  hardcoded paths).
- `ExecStart=/usr/bin/env node src/index.ts` — the `/usr/bin/env` indirection is **required**:
  systemd resolves a *bare* `ExecStart` command against its own PATH, computed *before* the unit's
  `Environment=PATH=` applies, so a bare `node` fails with "Unable to locate executable". An absolute
  `/usr/bin/env` is always found and then resolves `node` from the unit's PATH.
- A deliberately **broad `Environment=PATH=`** line: the systemd `--user` manager does not apply
  `~/.config/environment.d`, so without this the agent's `bash`/web/delegate tool calls would fail
  with "command not found". Edit it to match where your toolchains live.
- `Environment=NODE_ENV=production` is **pinned in the unit** (systemd `Environment=` overrides
  `EnvironmentFile=` for matching keys, so a stale env file can't flip it). This is the source of the
  subagent install gotcha documented in [`delegation.md`](delegation.md).
- Path defaults (`YTSEJAM_PORT=9873`, `YTSEJAM_DATA_DIR=%h/.ytsejam/data`,
  `YTSEJAM_WEB_DIST=%h/.ytsejam/current/web/dist`, `YTSEJAM_PI_AUTH=%h/.pi/agent/auth.json`) live
  **in the unit** via `%h`, because systemd expands
  `%h` in `Environment=` but does **not** expand `${HOME}`/`~` inside an `EnvironmentFile`. Override
  any of them only with an **absolute** path in the env file.
- `EnvironmentFile=-%h/.ytsejam/ytsejam.env` — read *after* the unit's `Environment=` lines, so keys
  set there win (except the pinned ones). Leading `-` makes it optional, so a missing file fails loud
  at the app layer (`config.ts` requires `YTSEJAM_AUTH_TOKEN`) rather than at unit-parse time.
- `ExecStartPre=` checks for `server/src/index.ts` and `web/dist/index.html` — fail loud at activation
  if a release is incomplete.
- Memory is in-process; the unit has no memory-service dependency.
- Stop sends `SIGTERM` with `TimeoutStopSec=45`; the server now orchestrates a graceful drain (scheduler stop, WebSocket 1001 closes, HTTP close, manager/task cancellation, LTM drain, sqlite close) and should exit naturally before systemd needs the timeout.

## Release layout

Everything under `~/.ytsejam/` (override root with `YTSEJAM_HOME`):

```
~/.ytsejam/
  ytsejam.env              # secrets + overrides, mode 0600, NOT in git
  releases/<timestamp>/    # immutable release trees (checkout + web/dist + node_modules)
  current  -> releases/<ts>   # what systemd runs
  previous -> releases/<ts>   # one step back, for rollback
  data/                    # YTSEJAM_DATA_DIR (sessions, index.db, persona, skills, ...)
```

## `deploy/install.sh` (one-time, idempotent)

Creates `~/.ytsejam/{releases,data}`, seeds `ytsejam.env` from `ytsejam.env.example` at mode **0600**
(never overwrites an existing one), installs the unit to `~/.config/systemd/user/` and runs
`daemon-reload`. It does **not** start the service or cut a release. Next steps it prints: edit the
env file, run `deploy.sh`, then `systemctl --user enable --now ytsejam`. (`loginctl enable-linger
$USER` to survive logout.)

## `deploy/deploy.sh` flow

1. **Preflight** — source dir is a git checkout, prod env file exists, `node`/`npm`/`git` on PATH.
   Resolve the health-check port from the env file → unit `Environment=` → `9873` fallback.
2. **Stage from `HEAD`** — `git archive --format=tar HEAD | tar -x` into
   `releases/<timestamp>/`. This respects `.gitignore` (no `node_modules`, no `data/`) and **never
   mutates the dev working tree**. Writes a `RELEASE` provenance file (timestamp, branch, ref,
   built-at/-on).
3. **Install + build, inside the release** — `env -u NODE_ENV npm ci --include=dev --ignore-scripts`
   (clears the inherited `NODE_ENV=production` so devDeps install; `--ignore-scripts` avoids depending
   on `patch-package` being resolvable on PATH during install), then `npx --no-install patch-package`
   to apply `patches/` explicitly, then **`env -u NODE_ENV npm rebuild`** to build native modules that
   `--ignore-scripts` skipped (notably `node-pty` for the terminal) plus a
   `node -e 'require("node-pty")'` smoke check that **`die`s the deploy before the symlink swap** if
   the native addon won't load, then `env -u NODE_ENV npm run build` (web). Asserts
   `web/dist/index.html` and `server/src/index.ts` exist or dies. → see § Native modules below.
4. **Seeded-skill drift gate, against the staged release** — before `current` moves, run
   `scripts/check-skills-drift.sh <new-release>/server/skills ~/.ytsejam/data/skills`. A content drift
   exit (`1`) aborts unless `ALLOW_SKILL_DRIFT=1`; structural errors still abort. This is intentionally
   after the release dir exists and before activation, so a failed deploy leaves the prepared release
   available as the operator's sync source but does not change what systemd is running.
5. **Atomic symlink swap** — point `previous` at the old `current`, then
   `ln -sfn <release> current.new && mv -Tf current.new current` (atomic rename).
6. **Restart + health-check** — if the unit is enabled, `systemctl --user restart ytsejam`, then up to
   5 retries of `curl -fsS http://127.0.0.1:<port>/`. **On failure: auto-rollback** — flip `current`
   back to `previous`, restart, and exit non-zero. If the unit isn't enabled, it cuts the release and
   swaps the symlink but doesn't start anything.
7. **Prune** — keep the last `KEEP_RELEASES` (default 5) release dirs.

The agent contract: `deploy.sh` verifies the *exit code* and the health check, not log scraping. The
quality gate (`scripts/gate.sh`) is a **separate** pre-deploy bar — `deploy.sh` does not run it; run
the gate before you deploy. See [`quality-gate.md`](quality-gate.md).

## Native modules (`node-pty`)

`server` depends on **`node-pty`** (the interactive terminal — see [`terminal.md`](terminal.md)),
which ships **native bindings compiled against the host's Node ABI**. Two facts make this a deploy
concern:

- `deploy.sh` installs with `--ignore-scripts` (to avoid needing `patch-package` on PATH during
  `npm ci`), which **also skips native build lifecycles**. So the flow runs an explicit
  `env -u NODE_ENV npm rebuild` after the patch step, then `node -e 'require("node-pty")'`. The smoke
  check runs **before the atomic symlink swap**, so a release with a broken/incompatible native build
  fails the deploy without ever becoming `current`. (Added in commit `cb9c2a1`.)
- If you add another native dependency, do **not** assume `npm ci` built it under `--ignore-scripts` —
  it must be covered by the `npm rebuild` step (and ideally the load-smoke check). A native module
  built for the wrong Node major will load-fail at boot, not at install.

`deploy/dev.sh` runs the same checkout's `node_modules`, so its native modules are whatever your dev
`npm install` produced for your local Node — keep the dev Node major aligned with prod to avoid a
"works in dev, fails the deploy rebuild" surprise.

## `deploy/sync-skills.sh` semantics

Use this when the deploy drift gate says seeded skills differ from the live runtime copy:

```bash
bash deploy/sync-skills.sh           # dry-run: list seeded files that would change
bash deploy/sync-skills.sh --yes     # copy those seeded files into the live skills dir
```

The important post-#216 behavior: by default the script reads seeds from the **newest timestamped release directory** under `$YTSEJAM_HOME/releases/`, not from `~/.ytsejam/current`. A drift-gate abort happens after `deploy.sh` has already built `<new-release>/server/skills` but before it advances `current`; comparing against `current` would therefore compare the live skills against the previous successful release and can incorrectly report "no drift". `sync-skills.sh` instead diffs/copies what **will** be live if the blocked deploy proceeds. On fresh/non-deploy boxes with no `releases/` dir, it falls back to `$YTSEJAM_HOME/current/server/skills`.

Only seeded names are touched: flat `*.md` seeds and directory-bundle `*.md` files (`<name>/SKILL.md` plus immediate markdown siblings). Generated domain skills, user bundles, live-only files inside a seeded bundle, and any live skill with no seed counterpart are never deleted or overwritten. Override `SEED_DIR=` or `LIVE_DIR=` only when deliberately syncing a non-default tree.

## `deploy/rollback.sh`

Flips `current` ↔ `previous` (so a second rollback returns to where you were), restarts, health-checks.
**One step back only**; for an older release, point `current` at a specific `releases/<ts>` by hand and
`systemctl --user restart ytsejam`.

## `deploy/dev.sh` — isolation against prod

Runs a **second, fully isolated** instance for development with zero risk to prod. Isolation is
explicit: the script **sets** every prod-shaped env var rather than inheriting it, because a shell
that sourced prod env would otherwise leak prod paths into dev. Differences from prod:

| | Production | Dev (`dev.sh`) |
| --- | --- | --- |
| Port | `9873` | `3000` (`DEV_PORT`) |
| Code | `~/.ytsejam/current` | your checkout, live `--watch` reload |
| Data | `~/.ytsejam/data` | `/tmp/ytsejam-dev/data` (throwaway; `WIPE=1` to reset) |
| Memory | in-process under the data dir | in-process under the throwaway data dir |
| Web dist | prod release's | this checkout's freshly built `web/dist` |

Notes that matter:

- It builds the web UI on launch (`env -u NODE_ENV npm run build --workspace web`) unless `NO_BUILD=1`,
  because `dev:server` serves a *prebuilt* `web/dist` (the server's `--watch` reloads the server, not
  the bundle). `NODE_ENV` is cleared for the build so devDeps are present.
- It `exec env -u NODE_ENV ... npm run dev:server` with every isolation-critical var hard-set.

## `deploy/migrate-data.sh` semantics

Copies the **SSOT** state from one data dir to another: `sessions/`, `tasks/`, `schedules/`, `persona/`,
and (merge-only) `skills/`. It **deliberately does not copy `index.db*`** — that's the derived sqlite
cache the server rebuilds from JSONL on boot; copying a live WAL risks a torn/locked DB. Details:

- `sessions/`, `tasks/`, `schedules/`, `persona/` are `rsync -a` (no `--delete`, so nothing in the
  destination is removed).
- `skills/` is **merge-only**: files missing in the destination are copied; release-seeded ones are
  left untouched (so runtime-generated/user skills carry over without clobbering seeds).
- `EXTRAS=1` also copies non-core working dirs the agent created in the source (skipping core dirs and
  `index.db*`).
- Defaults: `SRC=~/projects/ytsejam/server/data`, `DST=~/.ytsejam/data`. **Run with the source
  instance stopped** so nothing is mid-write; the script warns if the destination's `index.db-wal` was
  touched in the last minute (a sign the destination service is live).
- After migrating, start/restart the destination service — it rebuilds `index.db` from the copied
  JSONL.

## Open experiment (not adopted)

`deploy/README.md` documents a deferred `bun build --compile` single-file-binary path. It is **not in
use**: it would switch the prod runtime from Node to Bun, and the streaming WebSocket path
(`@hono/node-ws`) is the highest-risk dependency under Bun. Production stays on Node until a Bun build
passes a 4-point gate (boots + serves `web/dist`, streams tokens over WS, runs a full `delegate` task
with live task-card streaming, and tests stay green). Don't switch the runtime without clearing that.
