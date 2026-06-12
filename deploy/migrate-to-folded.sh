#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# ytsejam — migrate from cogmemory-daemon-era installs to in-process memory
#
# Idempotent. Safe to re-run: every step checks state before acting. As of
# 2026-06-12 / fold-cogmemory Phase 5, ytsejam owns memory in-process; the
# separate cogmemory daemon, sockets, and config directory are no longer needed.
# ─────────────────────────────────────────────────────────────────────────────

PREFIX="[migrate-to-folded]"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"

log()  { echo "$PREFIX $*"; }
warn() { echo "$PREFIX WARNING: $*"; }

unit_present() {
  local unit="$1"

  if command -v systemctl >/dev/null; then
    systemctl --user list-unit-files --type=service 2>/dev/null \
      | awk '{print $1}' \
      | grep -Fxq "$unit" && return 0
  fi

  [[ -f "$SYSTEMD_USER_DIR/$unit" ]]
}

remove_unit() {
  local unit="$1"

  if unit_present "$unit"; then
    log "Stopping $unit..."
    systemctl --user stop "$unit" 2>/dev/null || true
    systemctl --user disable "$unit" 2>/dev/null || true

    log "Removing $unit unit file..."
    rm -f "$SYSTEMD_USER_DIR/$unit"
  else
    log "$unit not present; skip."
  fi
}

# 1. Stop, disable, and remove legacy daemon units when present.
remove_unit "cogmemory.service"
remove_unit "cogmemory-test.service"

# 2. Reload systemd after unit removals. Non-systemd shells should still pass.
systemctl --user daemon-reload 2>/dev/null || true

# 3. Move the legacy memory store into ytsejam's data directory when safe.
LEGACY="$HOME/.chapterhouse/memory"
TARGET="$HOME/.ytsejam/data/memory"

if [[ -d "$LEGACY" && ! -d "$TARGET" ]]; then
  log "Legacy store detected at $LEGACY"
  log "Target $TARGET does not exist; moving..."
  mkdir -p "$(dirname "$TARGET")"
  mv "$LEGACY" "$TARGET"
  log "Moved $LEGACY -> $TARGET"
elif [[ -d "$LEGACY" && -d "$TARGET" ]]; then
  warn "both $LEGACY and $TARGET exist."
  log "Manual reconciliation needed — refusing to overwrite. Inspect both and choose:"
  log "  - If $TARGET is authoritative: rm -rf $LEGACY"
  log "  - If $LEGACY is authoritative: mv $TARGET ${TARGET}.bak && mv $LEGACY $TARGET"
elif [[ ! -d "$LEGACY" && -d "$TARGET" ]]; then
  log "Store already at $TARGET; skip."
else
  log "No store found at $LEGACY or $TARGET; skip (fresh install)."
fi

# 4. Remove orphaned daemon sockets and their parent dirs if empty.
rm -f "$HOME/.local/share/cogmemory/cog-memory.sock"
rm -f "$HOME/.local/share/cogmemory-test/cog-memory-test.sock"
rmdir "$HOME/.local/share/cogmemory" 2>/dev/null || true
rmdir "$HOME/.local/share/cogmemory-test" 2>/dev/null || true

# 5. Remove daemon config. The folded memory module reads ytsejam config only.
if [[ -d "$HOME/.config/cogmemory" ]]; then
  log "Removing $HOME/.config/cogmemory ..."
  rm -rf "$HOME/.config/cogmemory"
fi

# 6. Leave the daemon binary as a rollback safety net; tell the user how to prune.
if [[ -f "$HOME/.local/bin/cogmemory" ]]; then
  log "Note: $HOME/.local/bin/cogmemory binary still present."
  log "      Safe to delete now: rm $HOME/.local/bin/cogmemory"
  log "      (Or keep it as a rollback safety net for a few releases.)"
fi

log "Done. Restart ytsejam to pick up the in-process memory module:"
log "  systemctl --user restart ytsejam"
