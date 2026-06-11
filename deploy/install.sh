#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# ytsejam — one-time install / setup
#
# Idempotent. Creates the deploy layout under ~/.ytsejam, seeds an env file from
# the template (never overwrites an existing one), and installs the systemd
# --user unit. Does NOT start the service and does NOT cut a release — run
# deploy/deploy.sh for that, then start the unit deliberately.
#
#   YTSEJAM_HOME   deploy root (default ~/.ytsejam)
# ─────────────────────────────────────────────────────────────────────────────

YTSEJAM_HOME="${YTSEJAM_HOME:-$HOME/.ytsejam}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_SRC="$SCRIPT_DIR/ytsejam.service"
ENV_TEMPLATE="$SCRIPT_DIR/ytsejam.env.example"
ENV_FILE="$YTSEJAM_HOME/ytsejam.env"
UNIT_DEST="$HOME/.config/systemd/user/ytsejam.service"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}▸${NC} $*"; }
warn() { echo -e "${YELLOW}▸${NC} $*"; }

log "Creating deploy layout under $YTSEJAM_HOME"
mkdir -p "$YTSEJAM_HOME/releases" "$YTSEJAM_HOME/data"

if [[ -f "$ENV_FILE" ]]; then
  warn "Env file already exists, leaving untouched: $ENV_FILE"
else
  install -m 0600 "$ENV_TEMPLATE" "$ENV_FILE"
  log "Seeded env file (0600): $ENV_FILE"
  warn "EDIT IT NOW: set YTSEJAM_AUTH_TOKEN (required) and any provider API keys."
fi

mkdir -p "$HOME/.config/systemd/user"
install -m 0644 "$UNIT_SRC" "$UNIT_DEST"
log "Installed unit: $UNIT_DEST"
systemctl --user daemon-reload
log "daemon-reload done"

cat <<EOF

Next steps:
  1. Edit $ENV_FILE — set YTSEJAM_AUTH_TOKEN and keys.
  2. Cut the first release:   $SCRIPT_DIR/deploy.sh
  3. Enable + start:          systemctl --user enable --now ytsejam
  4. Verify:                  curl -fsS http://127.0.0.1:\${YTSEJAM_PORT:-9873}/ >/dev/null && echo OK
  (Optional) survive logout:  loginctl enable-linger \$USER
EOF
