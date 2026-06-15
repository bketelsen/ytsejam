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

Between build and symlink-swap, the deploy runs a **skill drift gate**: any seeded `server/skills/*.md` that differs from its live counterpart at `~/.ytsejam/data/skills/<name>.md` aborts the deploy with a `diff -u` per drifted file. Run `bash deploy/sync-skills.sh` (dry-run) to list what would change, then `bash deploy/sync-skills.sh --yes` to apply. To override the gate (rare, justify in commit), set `ALLOW_SKILL_DRIFT=1`. See `docs/agents/skills.md` for the full contract.

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
tokensBeforeEstimated, tokensAfterEstimated, summaryTokens, filesRead,
filesModified, compactionDurationMs, succeeded, and backupPath. Run
`tail -f <path>` or `jq` over it for diagnostics. Note: both
`tokensBeforeEstimated` and `tokensAfterEstimated` are structural estimates from
the same `estimateContextTokens` path, not provider-reported measurements; the
JSONL keys are `tokens_before_estimated` and `tokens_after_estimated`.

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

## Verifying graceful shutdown

On SIGTERM/SIGINT, ytsejam runs an ordered 7-step drain (see `drainAndExit`
in `server/src/index.ts`): stop scheduler → close WebSocket clients → close
HTTP server → abort subagent sessions → cancel tasks → drain LTM bridge →
close indexer. A healthy shutdown completes in **under a second** with no
data loss; a regression looks like systemd's `Killing` log line appearing
~45s after `Stopping` (TimeoutStopSec=45 → SIGKILL).

The verification recipes below use port `3099` so they don't collide with
either the prod (9873) or dev (3000) instance. Run them from the repo root
with the test data dir wiped between runs.

### Recipe A — drain with a live authenticated WebSocket (load-bearing)

This is the recipe that catches WebSocket-related shutdown regressions.
Node's `http.Server.close()` waits for upgraded WebSocket sockets to close
before its callback fires, so a drain that closes HTTP *before* the WS
clients deadlocks for the full systemd timeout. Always verify with a live
WS attached.

    pkill -9 -f "YTSEJAM_PORT=3099" 2>/dev/null; sleep 1
    rm -rf /tmp/ytsejam-smoke && mkdir -p /tmp/ytsejam-smoke
    setsid -f bash -c 'YTSEJAM_PORT=3099 YTSEJAM_DATA_DIR=/tmp/ytsejam-smoke \
      YTSEJAM_AUTH_TOKEN=smoke exec node server/src/index.ts \
      > /tmp/ytsejam-smoke.log 2>&1' </dev/null
    sleep 4
    NODE_PID=$(ss -ltnp 'sport = :3099' | grep -oP 'pid=\K[0-9]+' | head -1)
    echo "node pid: $NODE_PID"

    # Open an authenticated WebSocket and keep it alive in the background.
    # The /api/ws endpoint uses query-string auth (?token=), NOT a Bearer header.
    node -e '
      const WebSocket = require("ws");
      const ws = new WebSocket("ws://127.0.0.1:3099/api/ws?token=smoke");
      ws.on("open",  () => console.log("WS OPEN"));
      ws.on("close", (code, reason) => {
        console.log("WS CLOSE", code, JSON.stringify(reason.toString()));
        process.exit(0);
      });
      ws.on("error", (e) => console.error("WS ERROR", e.message));
      setInterval(() => {}, 1000);
    ' > /tmp/ytsejam-ws.log 2>&1 &
    WS_PID=$!
    sleep 3
    cat /tmp/ytsejam-ws.log   # expect: "WS OPEN"

    # Time the drain.
    START=$(date +%s.%N)
    kill -SIGTERM $NODE_PID
    while kill -0 $NODE_PID 2>/dev/null; do sleep 0.1; done
    END=$(date +%s.%N)
    awk -v s="$START" -v e="$END" 'BEGIN { printf "drain: %.0f ms\n", (e-s)*1000 }'

    grep -E "shutdown|memory" /tmp/ytsejam-smoke.log
    cat /tmp/ytsejam-ws.log    # expect: WS CLOSE 1001 "server shutting down"
    kill -9 $WS_PID 2>/dev/null || true

**Pass criteria:**
- Drain time **< 1000 ms** (typically ~100 ms).
- Logs contain `[shutdown] SIGTERM received, draining` AND `[shutdown] drain complete, awaiting handle release` in order.
- WS client received `code=1001 reason="server shutting down"`.
- No `Killed` / `SIGKILL` in journal output if this were a systemd unit.

**Fail signature (the #210 bug):** drain runs > 45000 ms, only the first
`[shutdown]` line appears, and the WS client log shows `WS OPEN` only
(never CLOSE) before the test harness kills the process.

### Recipe B — drain with no client attached (sanity check)

The "easy" path. If this fails, something more fundamental is broken than
the WebSocket ordering issue. Same setup as Recipe A but skip the
`node -e` WebSocket block — just SIGTERM right after the health probe.

    setsid -f bash -c 'YTSEJAM_PORT=3099 YTSEJAM_DATA_DIR=/tmp/ytsejam-smoke \
      YTSEJAM_AUTH_TOKEN=smoke exec node server/src/index.ts \
      > /tmp/ytsejam-smoke.log 2>&1' </dev/null
    sleep 4
    NODE_PID=$(ss -ltnp 'sport = :3099' | grep -oP 'pid=\K[0-9]+' | head -1)
    curl -sS -H "Authorization: Bearer smoke" \
      http://127.0.0.1:3099/api/health -o /dev/null -w "HTTP %{http_code}\n"
    kill -SIGTERM $NODE_PID
    while kill -0 $NODE_PID 2>/dev/null; do sleep 0.1; done
    echo "exited"
    grep -E "shutdown|memory" /tmp/ytsejam-smoke.log

**Pass criteria:** same as A. Drain typically completes in **~100 ms**.

### Recipe C — production-equivalent SIGTERM via systemd

For the prod instance, restart through systemd and watch the journal for
the same `[shutdown]` log lines, with no `Killing` line within 45 s.

    journalctl --user -u ytsejam -f &
    JOURNAL_PID=$!
    sleep 1
    systemctl --user restart ytsejam   # send SIGTERM, wait for graceful exit, restart
    sleep 5
    kill $JOURNAL_PID 2>/dev/null

**Pass criteria:**
- Journal shows `Stopping` then `[shutdown] SIGTERM received, draining` then `[shutdown] drain complete` then `Started`.
- The gap between `Stopping` and `Stopped` is **< 1 s** (typically much less).
- **No** `state 'stop-sigterm' timed out. Killing.` line — that's the #210 regression.

If `systemctl status ytsejam` reports `inactive (dead)` for > 5 s after a
restart, capture `journalctl --user -u ytsejam -n 50` and investigate
which drain step hung.



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
