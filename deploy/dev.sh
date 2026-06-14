#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# ytsejam — dev runner
#
# Runs a SECOND, fully isolated ytsejam instance for development, with zero risk
# to the production service:
#   • port 3000              (prod is 9873)
#   • throwaway data dir     ($DEV_DATA_DIR, default /tmp/ytsejam-dev/data)
#   • in-process memory      (under the throwaway data dir; never prod memory)
#   • serves THIS checkout's freshly built web/dist (not prod's)
#   • runs from the dev checkout this script lives in (live-reload via --watch)
#
# Isolation is explicit: this script SETS every prod-shaped env var rather than
# inheriting it, because a shell that sourced production env (YTSEJAM_WEB_DIST,
# NODE_ENV=production, ...) would otherwise leak prod paths into the dev process
# — pointing dev at prod data/memory, prod's stale UI bundle, or skipping
# devDependencies. Prod and dev share nothing.
#
# Usage:
#   deploy/dev.sh                  # build web + run dev:server on :3000
#   DEV_PORT=3001 deploy/dev.sh    # override port
#   WIPE=1 deploy/dev.sh           # delete the throwaway data dir first
#   NO_BUILD=1 deploy/dev.sh       # skip the web build (faster restart; serves last build)
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

DEV_PORT="${DEV_PORT:-3000}"
DEV_DATA_DIR="${DEV_DATA_DIR:-/tmp/ytsejam-dev/data}"
# Serve THIS checkout's build, never an inherited (prod) YTSEJAM_WEB_DIST.
DEV_WEB_DIST="$REPO_DIR/web/dist"
# A throwaway dev token; override with DEV_TOKEN if you want a specific one.
DEV_TOKEN="${DEV_TOKEN:-${YTSEJAM_AUTH_TOKEN:-devtoken}}"

YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'
log() { echo -e "${GREEN}▸${NC} $*"; }
warn() { echo -e "${YELLOW}▸${NC} $*"; }

if [[ "${WIPE:-0}" == 1 ]]; then
  log "Wiping throwaway data dir: $DEV_DATA_DIR"
  rm -rf "$DEV_DATA_DIR"
fi
mkdir -p "$DEV_DATA_DIR"

cd "$REPO_DIR"

# Build the web UI so what's served matches the source. dev:server runs the
# server via `node --watch` but serves a PREBUILT web/dist — without this, web
# changes are invisible until rebuilt. NODE_ENV is unset for the build so
# devDependencies (vite, typescript) are present even if the parent shell
# exported NODE_ENV=production.
if [[ "${NO_BUILD:-0}" == 1 ]]; then
  warn "NO_BUILD=1 — serving the last web build (may be stale)"
else
  log "Building web UI ($DEV_WEB_DIST)…"
  env -u NODE_ENV npm run build --workspace web >/dev/null
fi

if [[ ! -f "$DEV_WEB_DIST/index.html" ]]; then
  warn "No web build at $DEV_WEB_DIST — run without NO_BUILD, or npm run build --workspace web"
fi
log "dev ytsejam → http://localhost:$DEV_PORT"
log "  data dir : $DEV_DATA_DIR (throwaway)"
log "  memory   : in-process (under data dir)"
log "  embedder : auto (copilot if creds, else ollama, else hash)"
log "  web dist : $DEV_WEB_DIST"
log "  source   : $REPO_DIR (live --watch reload)"

# `env -i`-style explicitness: we do NOT inherit prod-shaped vars. Start from the
# current environment but hard-override every isolation-critical knob and clear
# NODE_ENV so devDependencies load and prod behavior can't leak in.
exec env \
  -u NODE_ENV \
  YTSEJAM_PORT="$DEV_PORT" \
  YTSEJAM_DATA_DIR="$DEV_DATA_DIR" \
  YTSEJAM_WEB_DIST="$DEV_WEB_DIST" \
  YTSEJAM_AUTH_TOKEN="$DEV_TOKEN" \
  YTSEJAM_LTM_EMBEDDER="auto" \
  npm run dev:server
