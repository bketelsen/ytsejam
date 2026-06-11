# Deploying ytsejam

ytsejam separates **three independent things** so a dev instance can run beside
production without touching it:

| | Production | Development |
| --- | --- | --- |
| Port (`YTSEJAM_PORT`) | **9873** (YTSE on a keypad) | **3000** |
| Code | `~/.ytsejam/current` → `~/.ytsejam/releases/<ts>` | your repo checkout |
| Data (`YTSEJAM_DATA_DIR`) | `~/.ytsejam/data` | `/tmp/ytsejam-dev/data` (throwaway) |
| Memory (`YTSEJAM_COG_SOCKET`) | cogmemory prod socket | cogmemory **test** socket |

Because every distinction is just an environment value (see `server/src/config.ts`),
dev and prod share nothing and cannot collide. The working directory the agent
operates in is **not** set here — it is chosen per session at runtime.

Everything lives under `~/.ytsejam/` (override with `YTSEJAM_HOME`):

    ~/.ytsejam/
      ytsejam.env        # secrets + overrides, mode 0600 (NOT in git)
      releases/<ts>/     # immutable release trees (clean checkout + web build + node_modules)
      current  -> releases/<ts>   # what systemd runs
      previous -> releases/<ts>   # one step back, for rollback
      data/              # YTSEJAM_DATA_DIR: sessions, index.db, persona, skills

## First-time setup

    deploy/install.sh                 # makes ~/.ytsejam, seeds env, installs the unit
    $EDITOR ~/.ytsejam/ytsejam.env    # set YTSEJAM_AUTH_TOKEN + provider keys
    deploy/deploy.sh                  # cut the first release into current/
    systemctl --user enable --now ytsejam
    curl -fsS http://127.0.0.1:9873/ >/dev/null && echo OK

To keep the service running after you log out:

    loginctl enable-linger "$USER"

## Deploying a new version

    git pull            # or check out the ref you want
    deploy/deploy.sh    # build web, cut release, swap symlink, restart, health-check

`deploy.sh` builds in an isolated copy of `HEAD` (via `git archive`, so it never
mutates your working tree), runs `npm ci` + `npm run build`, swaps `current`
atomically, restarts, and **auto-rolls-back if the health check on the prod port
fails**. Old releases are pruned to the last `KEEP_RELEASES` (default 5).

## Rolling back

    deploy/rollback.sh   # flip current -> previous, restart, health-check

One step back only. For an older release, point `current` at a specific
`releases/<ts>` by hand and `systemctl --user restart ytsejam`.

## Development beside production

    deploy/dev.sh                 # :3000, throwaway data, cogmemory TEST socket
    WIPE=1 deploy/dev.sh          # wipe the throwaway data dir first
    DEV_PORT=3001 deploy/dev.sh   # different port

`dev.sh` runs from your checkout with `--watch` live reload, on port 3000,
against `/tmp/ytsejam-dev/data` and the cogmemory **test** socket. It cannot
affect the production instance on :9873.

## Notes / portability

- The unit (`ytsejam.service`) and scripts use `%h`/`$HOME` only — no hardcoded
  user paths. They are safe to hand to another user as-is.
- The `PATH=` line in the unit is broad and tolerant of absent directories.
  Trim or extend it to match where your toolchains live; the agent's `bash`
  tool needs `node`, `git`, and whatever your subagents call to be on it.
- `ExecStart=node src/index.ts` resolves `node` via the unit's `PATH=` line
  (works whether node comes from your system, Homebrew, Volta, etc.). If `node`
  is somewhere exotic, either add its dir to the `PATH=` line or change
  `ExecStart` to an absolute path. `systemd-analyze verify` will warn that
  `node` "is not executable" — that is a false positive (the verifier ignores
  the unit's own `PATH=`); it resolves correctly at runtime.
- cogmemory is a **soft dependency**: if its socket is absent the server still
  boots and only the `cog_*` tools error. Drop the `Wants=/After=cogmemory.service`
  lines from the unit if you do not run it.
- The server runs TypeScript directly under Node (no server build step); only
  the web UI is built. `ExecStart=node src/index.ts`.

## Experiment: single-file binary (deferred)

`bun build --compile` could turn the server into one self-contained binary,
simplifying deploys to "drop in the binary" (the `ExecStart` would become
`~/.ytsejam/current/ytsejam` with no other change — the env contract is
identical). It is **not adopted yet** because it would switch the production
runtime from Node to Bun, and the streaming WebSocket path (`@hono/node-ws`) is
the highest-risk dependency under Bun — and also the live-streaming task-card
feature we most rely on.

Adopt it only when a Bun-built binary passes **all** of these against a
throwaway data dir:

1. boots and serves the built `web/dist`,
2. opens a session and streams assistant tokens over the WebSocket,
3. runs a full `delegate` subagent task to completion with live task-card streaming,
4. `npm test` (or the Bun equivalent) stays green.

Until that gate is met cleanly, production stays on the validated Node runtime.
