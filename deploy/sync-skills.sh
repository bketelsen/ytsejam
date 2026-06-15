#!/usr/bin/env bash
# Sync seeded skills from the current release dir over the live runtime dir.
#
# Resolves the drift that `check-skills-drift.sh` flags: copies each seeded
# `<name>.md` from the release seed dir over the matching live file. Live
# files that have no seed counterpart (generated domain skills, user-added
# dir-bundles, etc.) are NEVER touched.
#
# Usage:
#   bash deploy/sync-skills.sh           # dry-run (print what would change, exit 0)
#   bash deploy/sync-skills.sh --yes     # actually copy
#
# Reads from $YTSEJAM_HOME/current/server/skills (the active release's seed dir)
# Writes to $YTSEJAM_HOME/data/skills (the live runtime dir)
#
# Override paths via env vars:
#   YTSEJAM_HOME       deploy root        (default ~/.ytsejam)
#   SEED_DIR           seed source        (default $YTSEJAM_HOME/current/server/skills)
#   LIVE_DIR           live destination   (default $YTSEJAM_HOME/data/skills)

set -euo pipefail

YTSEJAM_HOME="${YTSEJAM_HOME:-$HOME/.ytsejam}"
SEED_DIR="${SEED_DIR:-$YTSEJAM_HOME/current/server/skills}"
LIVE_DIR="${LIVE_DIR:-$YTSEJAM_HOME/data/skills}"

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'
# Suppress color when stdout is not a terminal (operator may capture output to a log).
if [[ ! -t 1 ]]; then RED=''; YELLOW=''; GREEN=''; NC=''; fi
log()  { echo -e "${GREEN}▸${NC} $*"; }
warn() { echo -e "${YELLOW}▸${NC} $*"; }
die()  { echo -e "${RED}✗${NC} $*" >&2; exit 1; }

[[ -d "$SEED_DIR" ]] || die "seed dir not found: $SEED_DIR"
[[ -d "$LIVE_DIR" ]] || die "live dir not found: $LIVE_DIR"

APPLY=0
case "${1:-}" in
  --yes|-y) APPLY=1 ;;
  ""|--dry-run) APPLY=0 ;;
  -h|--help)
    echo "usage: $0 [--yes|--dry-run]"
    exit 0
    ;;
  *) die "unknown arg: $1 (try --yes or --dry-run)" ;;
esac

would_copy=0
shopt -s nullglob
for seed_file in "$SEED_DIR"/*.md; do
  # defensive: skip if a future seed glob match is a directory, not a file
  [[ -f "$seed_file" ]] || continue
  name="$(basename "$seed_file")"
  live_file="$LIVE_DIR/$name"

  # Live missing: not drift, skip (boot will seed it).
  [[ -f "$live_file" ]] || continue

  # diff exit: 0=same (skip), 1=differ (sync), ≥2=trouble (treat conservatively).
  # See lesson: scripts/check-skills-drift.sh applies the same pattern.
  rc=0
  diff -q "$seed_file" "$live_file" > /dev/null 2>&1 || rc=$?
  if [[ $rc -eq 0 ]]; then
    continue
  elif [[ $rc -ne 1 ]]; then
    warn "cannot compare $name (diff exit $rc) — skipping; resolve manually"
    continue
  fi

  would_copy=$((would_copy + 1))
  if [[ $APPLY -eq 1 ]]; then
    log "syncing $name"
    cp "$seed_file" "$live_file"
  else
    warn "would sync $name (use --yes to apply)"
  fi
done

if [[ $would_copy -eq 0 ]]; then
  log "no drift — nothing to sync"
elif [[ $APPLY -eq 1 ]]; then
  log "synced $would_copy seeded skill(s)"
else
  echo ""
  warn "dry-run: $would_copy seeded skill(s) would be synced; re-run with --yes to apply"
fi
