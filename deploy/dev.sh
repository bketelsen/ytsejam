#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# ytsejam — dev runner
#
# Runs a SECOND, fully isolated ytsejam instance for development, with zero risk
# to the production service:
#   • port 3000              (prod is 9873)
#   • throwaway data dir     ($DEV_DATA_DIR, default /tmp/ytsejam-dev/data)
#   • test memory daemon     (cogmemory-test socket, default; never prod memory)
#   • runs from the dev checkout this script lives in (live-reload via --watch)
#
# Prod and dev share nothing: different port, different data dir, different cog
# socket. Restarting or wiping dev never touches prod's :9873.
#
# Usage:
#   deploy/dev.sh                 # dev:server on :3000 against test memory
#   DEV_PORT=3001 deploy/dev.sh   # override port
#   WIPE=1 deploy/dev.sh          # delete the throwaway data dir first
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

DEV_PORT="${DEV_PORT:-3000}"
DEV_DATA_DIR="${DEV_DATA_DIR:-/tmp/ytsejam-dev/data}"
# Default to the cogmemory TEST socket so dev never reads/writes prod memory.
# Override with YTSEJAM_COG_SOCKET to point elsewhere (or at prod, deliberately).
DEV_COG_SOCKET="${YTSEJAM_COG_SOCKET:-$HOME/.local/share/cogmemory-test/cog-memory-test.sock}"
# A throwaway dev token; override by exporting YTSEJAM_AUTH_TOKEN before running.
DEV_TOKEN="${YTSEJAM_AUTH_TOKEN:-devtoken}"

YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'
log() { echo -e "${GREEN}▸${NC} $*"; }

if [[ "${WIPE:-0}" == 1 ]]; then
  log "Wiping throwaway data dir: $DEV_DATA_DIR"
  rm -rf "$DEV_DATA_DIR"
fi
mkdir -p "$DEV_DATA_DIR"

if [[ ! -S "$DEV_COG_SOCKET" ]]; then
  echo -e "${YELLOW}▸${NC} cog socket not found at $DEV_COG_SOCKET — cog tools will error until the daemon is up (server still boots; memory is a soft dep)."
fi

log "dev ytsejam → http://localhost:$DEV_PORT"
log "  data dir : $DEV_DATA_DIR (throwaway)"
log "  cog sock : $DEV_COG_SOCKET"
log "  source   : $REPO_DIR (live --watch reload)"

cd "$REPO_DIR"
exec env \
  YTSEJAM_PORT="$DEV_PORT" \
  YTSEJAM_DATA_DIR="$DEV_DATA_DIR" \
  YTSEJAM_COG_SOCKET="$DEV_COG_SOCKET" \
  YTSEJAM_AUTH_TOKEN="$DEV_TOKEN" \
  npm run dev:server
