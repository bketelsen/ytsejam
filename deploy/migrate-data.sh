#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# ytsejam — migrate data dir
#
# Copies the SOURCE-OF-TRUTH state from one ytsejam data dir to another:
# chat/subagent sessions, subagent task transcripts, schedules (JSONL),
# persona, and skills. Deliberately DOES NOT copy index.db* — that file is a
# derived sqlite cache the server rebuilds from the JSONL on boot. Copying a
# live WAL would risk handing the new instance a torn/locked database.
#
# Use it when moving from the dev/manual data dir to the production data dir
# (e.g. ~/projects/ytsejam/server/data  ->  ~/.ytsejam/data). Run it with the
# OLD instance STOPPED so nothing is mid-write.
#
#   SRC   source data dir   (default ~/projects/ytsejam/server/data)
#   DST   dest data dir     (default ~/.ytsejam/data)
#   EXTRAS=1  also copy non-core working dirs the agent created in SRC
#             (anything that isn't sessions/tasks/schedules/persona/skills/index.db*)
#
#   SRC=… DST=… deploy/migrate-data.sh
# ─────────────────────────────────────────────────────────────────────────────

SRC="${SRC:-$HOME/projects/ytsejam/server/data}"
DST="${DST:-$HOME/.ytsejam/data}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}▸${NC} $*"; }
warn() { echo -e "${YELLOW}▸${NC} $*"; }
die()  { echo -e "${RED}✗${NC} $*" >&2; exit 1; }

if [[ ! -d "$SRC" ]]; then
  log "Source data dir not found: $SRC"
  log "(migrate-data.sh is only needed when upgrading from an older data dir."
  log " First-time installs don't need it — skipping.)"
  exit 0
fi
[[ "$SRC" != "$DST" ]] || die "SRC and DST are the same dir: $SRC"
command -v rsync >/dev/null || die "rsync required"
mkdir -p "$DST"

# Safety: warn if the destination service looks live (a fresh WAL implies an
# active writer). Migrating into a running instance can lose writes.
if [[ -f "$DST/index.db-wal" ]] && [[ -n "$(find "$DST/index.db-wal" -mmin -1 2>/dev/null)" ]]; then
  warn "DST index.db-wal was modified in the last minute — is the destination service running?"
  warn "Stop it first (systemctl --user stop ytsejam) so the rebuild picks up the copied JSONL."
fi

log "Migrating ytsejam data"
log "  from: $SRC"
log "  to:   $DST"
log "  (index.db* excluded — derived cache, rebuilt on boot)"

# ── Core SSOT dirs ──
# sessions/ and tasks/ are append-only JSONL; -a preserves, no --delete so we
# never remove anything already in DST.
for d in sessions tasks schedules persona; do
  if [[ -d "$SRC/$d" ]]; then
    log "  • $d/"
    rsync -a "$SRC/$d/" "$DST/$d/"
  fi
done

# ── Skills: copy only those MISSING in DST, never clobber release-seeded ones ──
# (The release seeds the committed cog-pipeline skills; runtime-generated domain
#  skills + user-installed skills live only in the old data dir.)
if [[ -d "$SRC/skills" ]]; then
  mkdir -p "$DST/skills"
  copied=0
  while IFS= read -r -d '' f; do
    base="$(basename "$f")"
    if [[ ! -e "$DST/skills/$base" ]]; then
      cp -a "$f" "$DST/skills/$base"; copied=$((copied+1))
    fi
  done < <(find "$SRC/skills" -maxdepth 1 -type f -name '*.md' -print0)
  log "  • skills/ (+$copied missing, existing left untouched)"
fi

# ── Optional: non-core working dirs the agent created in SRC ──
if [[ "${EXTRAS:-0}" == 1 ]]; then
  while IFS= read -r -d '' p; do
    base="$(basename "$p")"
    case "$base" in
      sessions|tasks|schedules|persona|skills) continue ;;       # core, already done
      index.db|index.db-shm|index.db-wal) continue ;;            # derived cache, never copy
    esac
    log "  • extra: $base"
    if [[ -d "$p" ]]; then rsync -a "$p/" "$DST/$base/"; else cp -a "$p" "$DST/$base"; fi
  done < <(find "$SRC" -maxdepth 1 -mindepth 1 -print0)
fi

log "Migration complete."
log "Start (or restart) the destination service; it will rebuild index.db from the copied JSONL:"
log "  systemctl --user restart ytsejam && journalctl --user -u ytsejam -n 10"
