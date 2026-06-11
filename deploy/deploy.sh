#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# ytsejam — deploy
#
# Builds the web UI from a clean dependency install, cuts an immutable
# timestamped release, atomically swaps the `current` symlink, restarts the
# systemd --user service, health-checks it, and auto-rolls-back on failure.
#
# The server runs TypeScript directly under Node, so a "release" is:
#   a clean checkout of the repo  +  a built web/dist  +  npm ci'd node_modules
# in an immutable timestamped dir. Deploy = swap which dir `current` points at.
#
# Locations (all override-able; defaults keep everything under ~/.ytsejam):
#   YTSEJAM_HOME    deploy root        (default ~/.ytsejam)
#   SOURCE_DIR      dev checkout       (default the repo this script lives in)
# Runtime config (port, data dir, token, model, cog socket) lives in
#   $YTSEJAM_HOME/ytsejam.env  — created by deploy/install.sh, never by this.
# ─────────────────────────────────────────────────────────────────────────────

YTSEJAM_HOME="${YTSEJAM_HOME:-$HOME/.ytsejam}"
# Resolve the repo root from this script's own location so SOURCE_DIR is correct
# regardless of where the script is invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="${SOURCE_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
RELEASES_DIR="$YTSEJAM_HOME/releases"
ENV_FILE="$YTSEJAM_HOME/ytsejam.env"
SERVICE_NAME="ytsejam"
KEEP_RELEASES="${KEEP_RELEASES:-5}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}▸${NC} $*"; }
warn() { echo -e "${YELLOW}▸${NC} $*"; }
die()  { echo -e "${RED}✗${NC} $*" >&2; exit 1; }

# ─── Preflight ───
[[ -d "$SOURCE_DIR/.git" ]] || die "Source dir is not a git checkout: $SOURCE_DIR"
[[ -f "$ENV_FILE" ]]        || die "Production env not found: $ENV_FILE  (run deploy/install.sh first)"
command -v node >/dev/null  || die "node not found on PATH"
command -v npm  >/dev/null  || die "npm not found on PATH"
command -v git  >/dev/null  || die "git not found on PATH"

# Port for the health check, resolved in priority order:
#   1. an override in the prod env file, 2. the unit's Environment= default,
#   3. the 9873 fallback. (systemd is the source of truth for the default.)
UNIT_FILE="$HOME/.config/systemd/user/ytsejam.service"
PORT="$(grep -oE '^YTSEJAM_PORT=[0-9]+' "$ENV_FILE" | head -1 | cut -d= -f2 || true)"
if [[ -z "${PORT:-}" && -f "$UNIT_FILE" ]]; then
  PORT="$(grep -oE '^Environment=YTSEJAM_PORT=[0-9]+' "$UNIT_FILE" | head -1 | cut -d= -f3 || true)"
fi
PORT="${PORT:-9873}"
mkdir -p "$RELEASES_DIR"

# ─── 1. Build in an isolated staging copy (never mutate the dev tree) ───
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
RELEASE_DIR="$RELEASES_DIR/$TIMESTAMP"
GIT_REF="$(cd "$SOURCE_DIR" && git rev-parse --short HEAD)"
GIT_BRANCH="$(cd "$SOURCE_DIR" && git rev-parse --abbrev-ref HEAD)"

log "Cutting release $TIMESTAMP from $GIT_BRANCH@$GIT_REF"

# Export a clean tree at HEAD (respects .gitignore; no node_modules, no data/).
mkdir -p "$RELEASE_DIR"
( cd "$SOURCE_DIR" && git archive --format=tar HEAD ) | tar -x -C "$RELEASE_DIR"

# Record provenance for `current`/rollback introspection.
cat > "$RELEASE_DIR/RELEASE" <<EOF
timestamp=$TIMESTAMP
git_branch=$GIT_BRANCH
git_ref=$GIT_REF
built_at=$(date -Iseconds)
built_on=$(hostname)
EOF

# ─── 2. Install deps + build web, inside the release ───
log "Installing dependencies (npm ci)…"
( cd "$RELEASE_DIR" && npm ci 2>&1 | tail -3 )

log "Building web UI…"
( cd "$RELEASE_DIR" && npm run build 2>&1 | tail -3 )

[[ -f "$RELEASE_DIR/web/dist/index.html" ]] || die "web build missing: $RELEASE_DIR/web/dist/index.html"
[[ -f "$RELEASE_DIR/server/src/index.ts" ]] || die "server entry missing: $RELEASE_DIR/server/src/index.ts"

# ─── 3. Swap symlinks atomically (save previous for rollback) ───
log "Swapping symlinks…"
CURRENT_LINK="$YTSEJAM_HOME/current"
PREVIOUS_LINK="$YTSEJAM_HOME/previous"

if [[ -L "$CURRENT_LINK" ]]; then
  ln -sfn "$(readlink -f "$CURRENT_LINK")" "$PREVIOUS_LINK"
fi
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK.new"
mv -Tf "$CURRENT_LINK.new" "$CURRENT_LINK"
log "current → $TIMESTAMP"

# ─── 4. Restart + health check ───
if systemctl --user is-enabled "$SERVICE_NAME" &>/dev/null; then
  log "Restarting $SERVICE_NAME…"
  systemctl --user restart "$SERVICE_NAME"
  sleep 3

  ok=0
  for _ in 1 2 3 4 5; do
    if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/"; then ok=1; break; fi
    sleep 2
  done

  if [[ "$ok" == 1 ]]; then
    log "Health check passed on :$PORT"
  else
    warn "Health check FAILED on :$PORT — rolling back"
    if [[ -L "$PREVIOUS_LINK" ]]; then
      ln -sfn "$(readlink -f "$PREVIOUS_LINK")" "$CURRENT_LINK.new"
      mv -Tf "$CURRENT_LINK.new" "$CURRENT_LINK"
      systemctl --user restart "$SERVICE_NAME"
      die "Rolled back to previous release. Logs: journalctl --user -u $SERVICE_NAME -n 50"
    fi
    die "No previous release to roll back to. Logs: journalctl --user -u $SERVICE_NAME -n 50"
  fi
else
  warn "Service '$SERVICE_NAME' not enabled — release cut + symlink swapped, but not started."
  warn "Enable it once: systemctl --user enable $SERVICE_NAME && systemctl --user start $SERVICE_NAME"
fi

# ─── 5. Prune old releases ───
mapfile -t OLD < <(ls -1d "$RELEASES_DIR"/[0-9]* 2>/dev/null | head -n -"$KEEP_RELEASES" || true)
if (( ${#OLD[@]} > 0 )); then
  log "Pruning ${#OLD[@]} old release(s), keeping $KEEP_RELEASES…"
  for d in "${OLD[@]}"; do rm -rf "$d"; log "  removed $(basename "$d")"; done
fi

log "Deploy complete: $TIMESTAMP ($GIT_BRANCH@$GIT_REF) on :$PORT"
