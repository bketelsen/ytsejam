# Deploying ytsejam

ytsejam separates **three independent things** so a dev instance can run beside
production without touching it:

| | Production | Development |
| --- | --- | --- |
| Port (`YTSEJAM_PORT`) | **9873** (YTSE on a keypad) | **3000** |
| Code | `~/.ytsejam/current` → `~/.ytsejam/releases/<ts>` | your repo checkout |
| Data (`YTSEJAM_DATA_DIR`) | `~/.ytsejam/data` | `/tmp/ytsejam-dev/data` (throwaway) |
| Memory | in-process under the data dir | in-process under the throwaway data dir |

Because every distinction is just an environment value (see `server/src/config.ts`),
dev and prod share nothing and cannot collide. The working directory the agent
operates in is **not** set here — it is chosen per session at runtime.

Everything lives under `~/.ytsejam/` (override with `YTSEJAM_HOME`):

    ~/.ytsejam/
      ytsejam.env        # secrets + overrides, mode 0600 (NOT in git)
      releases/<ts>/     # immutable release trees (clean checkout + web build + node_modules)
      current  -> releases/<ts>   # what systemd runs
      previous -> releases/<ts>   # one step back, for rollback
      data/              # YTSEJAM_DATA_DIR: sessions, index.db, persona, skills, memory

## First-time setup

    deploy/install.sh                 # makes ~/.ytsejam, seeds env, installs the unit
    $EDITOR ~/.ytsejam/ytsejam.env    # set YTSEJAM_AUTH_TOKEN + provider keys
    deploy/deploy.sh                  # cut the first release into current/
    systemctl --user enable --now ytsejam
    curl -fsS http://127.0.0.1:9873/ >/dev/null && echo OK

To keep the service running after you log out:

    loginctl enable-linger "$USER"

Memory is in-process as of Phase 5 of the 2026-06-12 fold; no separate memory service is needed.
The store lives at `$YTSEJAM_DATA_DIR/memory` by default; set `YTSEJAM_MEMORY_DIR` to an absolute path to override (see `ytsejam.env.example`).

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

    deploy/dev.sh                 # :3000, throwaway data + in-process memory
    WIPE=1 deploy/dev.sh          # wipe the throwaway data dir first
    DEV_PORT=3001 deploy/dev.sh   # different port

`dev.sh` runs from your checkout with `--watch` live reload, on port 3000,
against `/tmp/ytsejam-dev/data`. Its memory store is under that throwaway data
dir, so it cannot affect the production instance on :9873.

## Runtime operations

### Context-window compaction

ytsejam auto-compacts long sessions at idle boundaries before they hit the
selected model's contextWindow. Calibration is model-aware: every catalog entry
in `@earendil-works/pi-ai` carries its own `contextWindow` and `maxTokens`, so
there is no per-model configuration to maintain. The compaction module lives at
`server/src/compaction.ts`; main-session wiring is in `server/src/manager.ts`;
subagent wiring is in `server/src/task-manager.ts`.

**Per-session backups:** before each `harness.compact()`, the session JSONL is
copied to `<session.jsonl>.pre-compact-<epoch-ms>`. The last 3 backups are
kept and older backups are auto-pruned. Backups are co-located with the session
file, not in a per-session-id directory; pi's actual layout is
`<sessionsRoot>/--<cwd>--/<timestamp>_<id>.jsonl`.

**Per-session observability log:** each compaction event writes a JSON record to
`<session.jsonl>.compactions.jsonl`. Fields include timestamp, trigger
(proactive/reactive), reason, model, contextWindow, reserveTokens,
tokensBefore, tokensAfterEstimated, summaryTokens, droppedTurns, filesRead,
filesModified, compactionDurationMs, succeeded, and backupPath. Run
`tail -f <path>` or `jq` over it for diagnostics. Note: `tokensAfterEstimated`
is a structural estimate of the kept-set token count, not a provider-reported
measurement; the JSONL key is `tokens_after_estimated`.

**Cog dev-log entry:** each compaction also writes a single line to the cog
dev-log (`~/.ytsejam/data/memory/projects/ytsejam/dev-log.md`, or whatever
`YTSEJAM_MEMORY_DIR` resolves to). There is one line per compaction event,
surfaced by `/housekeeping` pattern detection.

**Reactive recovery:** when the API returns "prompt is too long" mid-turn, the
harness compacts immediately and retries the turn once. If the retry also
fails, the user gets an actionable diagnostic message with token count,
contextWindow, and options: summarize so far, start a fresh session, or switch
model. ytsejam does not auto-switch models.

**Emergency disable.** If the compaction module ships a bug that's corrupting
sessions or misbehaving, set `YTSEJAM_COMPACTION_ENABLED=false` in
`~/.ytsejam/ytsejam.env` and `systemctl --user restart ytsejam`. The service
reverts to no-compaction behavior: sessions will 400 with "prompt is too long"
on overflow, the pre-compaction behavior. This is known-bad-but-survivable
while a fix ships.

## Migrating from an older install

**First-time installers can skip this whole section.** Both `deploy/migrate-data.sh`
and `deploy/migrate-to-folded.sh` are upgrade-only — they detect a fresh install
and exit 0 with a brief explanation, so it's harmless to run them, but you don't
need to.

### Moving an existing data dir

When you move from a dev/manual data dir to the production one (or to a new
host), carry the **source-of-truth** state — sessions, tasks, schedules,
persona, skills — but **not** `index.db`. That sqlite file is a derived cache
the server rebuilds from the JSONL on boot; copying a live WAL risks a torn
database.

    systemctl --user stop ytsejam          # stop the destination writer
    SRC=~/old/data DST=~/.ytsejam/data deploy/migrate-data.sh
    systemctl --user start ytsejam          # rebuilds index.db from the copied JSONL
    journalctl --user -u ytsejam -n 10

Defaults are `SRC=~/projects/ytsejam/server/data` and `DST=~/.ytsejam/data`.
`EXTRAS=1` also copies any non-core working directories the agent created in
the source. Run it with the **source instance stopped** so nothing is
mid-write. Skills are merged: files missing in the destination are copied,
release-seeded ones are left untouched.

### Folding from the cogmemory daemon (pre-2026-06-12 installs)

If you're upgrading from a release that used the separate `cogmemory` daemon,
run `deploy/migrate-to-folded.sh` once. It stops and removes the legacy
`cogmemory.service` and `cogmemory-test.service` units, moves the legacy
`~/.chapterhouse/memory` store to `~/.ytsejam/data/memory`, and cleans up
the daemon's sockets and config. The daemon binary at `~/.local/bin/cogmemory` is intentionally left in place as a rollback safety net; the script prints when it's safe to delete. Idempotent — safe to re-run.

    deploy/migrate-to-folded.sh
    systemctl --user restart ytsejam

## Notes / portability

- The unit (`ytsejam.service`) and scripts use `%h`/`$HOME` only — no hardcoded
  user paths. They are safe to hand to another user as-is.
- The `PATH=` line in the unit is broad and tolerant of absent directories.
  Trim or extend it to match where your toolchains live; the agent's `bash`
  tool needs `node`, `git`, and whatever your subagents call to be on it.
- `ExecStart=/usr/bin/env node src/index.ts` resolves `node` via the unit's
  `PATH=` line (works whether node comes from your system, Homebrew, Volta,
  etc.) without hardcoding a node path. The `/usr/bin/env` indirection is
  required: systemd looks up a *bare* `ExecStart` command (`node`) against its
  own PATH computed *before* the unit's `Environment=PATH=` is applied, so a
  bare `node` fails with "Unable to locate executable: node". An absolute
  `/usr/bin/env` is always found and then resolves `node` from the PATH we set.
  If your `node` is not on that PATH, add its directory to the unit's `PATH=`.
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
