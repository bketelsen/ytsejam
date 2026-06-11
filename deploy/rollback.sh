#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# ytsejam — rollback
# Flip `current` back to `previous` and restart. One step back only; for older
# releases, point `current` at a specific dir under $YTSEJAM_HOME/releases/ by
# hand and restart.
# ─────────────────────────────────────────────────────────────────────────────

YTSEJAM_HOME="${YTSEJAM_HOME:-$HOME/.ytsejam}"
ENV_FILE="$YTSEJAM_HOME/ytsejam.env"
SERVICE_NAME="ytsejam"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}▸${NC} $*"; }
warn() { echo -e "${YELLOW}▸${NC} $*"; }
die()  { echo -e "${RED}✗${NC} $*" >&2; exit 1; }

CURRENT_LINK="$YTSEJAM_HOME/current"
PREVIOUS_LINK="$YTSEJAM_HOME/previous"

[[ -L "$PREVIOUS_LINK" ]] || die "No previous release recorded at $PREVIOUS_LINK"

PORT="$(grep -oE '^YTSEJAM_PORT=[0-9]+' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2 || true)"
UNIT_FILE="$HOME/.config/systemd/user/ytsejam.service"
if [[ -z "${PORT:-}" && -f "$UNIT_FILE" ]]; then
  PORT="$(grep -oE '^Environment=YTSEJAM_PORT=[0-9]+' "$UNIT_FILE" | head -1 | cut -d= -f3 || true)"
fi
PORT="${PORT:-9873}"
CUR_TARGET="$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo none)"
PREV_TARGET="$(readlink -f "$PREVIOUS_LINK")"
log "Rolling back: $(basename "$CUR_TARGET") → $(basename "$PREV_TARGET")"

# Swap current<->previous so a second rollback returns to where we were.
ln -sfn "$PREV_TARGET" "$CURRENT_LINK.new"
mv -Tf "$CURRENT_LINK.new" "$CURRENT_LINK"
[[ "$CUR_TARGET" != none ]] && ln -sfn "$CUR_TARGET" "$PREVIOUS_LINK"

if systemctl --user is-enabled "$SERVICE_NAME" &>/dev/null; then
  systemctl --user restart "$SERVICE_NAME"
  sleep 3
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/"; then
    log "Rollback healthy on :$PORT"
  else
    warn "Service restarted but health check failed on :$PORT — check journalctl --user -u $SERVICE_NAME"
  fi
else
  warn "Service not enabled; symlink flipped only."
fi

log "Rollback complete → $(basename "$PREV_TARGET")"
