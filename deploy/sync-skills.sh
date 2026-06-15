#!/usr/bin/env bash
# Sync seeded skills from the current release dir over the live runtime dir.
#
# Resolves the drift that `check-skills-drift.sh` flags: copies each seeded
# `<name>.md` from the release seed dir over the matching live file. Also
# handles dir-bundle seeds (`<name>/SKILL.md` plus immediate sibling `*.md`
# resources). Live files that have no seed counterpart (generated domain
# skills, user-added bundles, user-added files INSIDE a seeded bundle) are
# NEVER touched.
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
# Suppress color when neither stdout nor stderr is a terminal (operator may capture both).
if [[ ! -t 1 && ! -t 2 ]]; then RED=''; YELLOW=''; GREEN=''; NC=''; fi
log()  { echo -e "${GREEN}▸${NC} $*"; }
warn() { echo -e "${YELLOW}▸${NC} $*"; }
warn_err() { echo -e "${YELLOW}▸${NC} $*" >&2; }
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
synced=0
trouble=0
current_file=""
completed_normally=0

# EXIT trap: if the loop aborts mid-cp (set -e on a failed copy, ENOSPC,
# read-only target, etc.), the summary block below never runs and the
# operator is left with cp's stderr but no "N of M synced, aborted"
# reconciliation. Trap fires unconditionally; we suppress its output on
# normal completion via `completed_normally`.
on_exit() {
  local rc=$?
  if [[ $completed_normally -eq 1 ]]; then
    exit $rc
  fi
  # Abnormal exit: print whatever state we have so the operator knows
  # how partial the partial sync was.
  if [[ $APPLY -eq 1 && $would_copy -gt 0 ]]; then
    echo "" >&2
    warn_err "aborted mid-sync: $synced seeded skill(s) synced before failure on '${current_file:-?}'"
    if [[ $trouble -gt 0 ]]; then
      warn_err "(plus $trouble skipped due to compare errors — see warnings above)"
    fi
    warn_err "any remaining skills are unprocessed; live state is partially updated"
    warn_err "re-run --dry-run to see remaining drift, then --yes to retry"
  fi
  exit $rc
}
trap on_exit EXIT

shopt -s nullglob

# A small helper: given seed + live + qualified-name, do the diff-and-sync
# step that's identical for flat files and bundle files. Mutates the loop
# counters via the enclosing-scope variables (would_copy/synced/trouble/
# current_file). Pure helper would need name-based output channels — this
# is bash; closures over the counters are how we keep one truth.
sync_one() {
  local seed_file="$1" live_file="$2" name="$3"

  # Live missing: not drift, skip (boot will seed it).
  [[ -f "$live_file" ]] || return 0

  # diff exit: 0=same (skip), 1=differ (sync), ≥2=trouble (treat conservatively).
  local rc=0
  diff -q "$seed_file" "$live_file" > /dev/null 2>&1 || rc=$?
  if [[ $rc -eq 0 ]]; then
    return 0
  elif [[ $rc -ne 1 ]]; then
    # Trouble warnings go to stderr — they're anomaly signals, not progress.
    # Operators piping stdout to a log must still see "this skill was left un-synced".
    warn_err "cannot compare $name (diff exit $rc) — skipping; resolve manually"
    trouble=$((trouble + 1))
    return 0
  fi

  would_copy=$((would_copy + 1))
  if [[ $APPLY -eq 1 ]]; then
    log "syncing $name"
    current_file="$name"
    cp "$seed_file" "$live_file"
    # Only bump `synced` AFTER cp succeeds. set -e ensures we don't reach
    # this line on cp failure, so this counter is the truth for the trap.
    synced=$((synced + 1))
    current_file=""
  else
    warn "would sync $name (use --yes to apply)"
  fi
}

# Flat seeds.
for seed_file in "$SEED_DIR"/*.md; do
  # defensive: skip if a future seed glob match is a directory, not a file
  [[ -f "$seed_file" ]] || continue
  name="$(basename "$seed_file")"
  sync_one "$seed_file" "$LIVE_DIR/$name" "$name"
done

# Dir-bundle seeds (`<name>/SKILL.md` + immediate sibling `*.md` resources).
# Each bundle file is independently synced; files only present live in a
# seeded bundle are NEVER touched (same user-dir-wins contract).
for seed_skill in "$SEED_DIR"/*/SKILL.md; do
  [[ -f "$seed_skill" ]] || continue
  bundle_dir="$(dirname "$seed_skill")"
  bundle_name="$(basename "$bundle_dir")"
  live_bundle="$LIVE_DIR/$bundle_name"

  # Live bundle missing entirely: not drift, skip (boot seeds the whole bundle).
  [[ -d "$live_bundle" ]] || continue

  for bundle_file in "$bundle_dir"/*.md; do
    [[ -f "$bundle_file" ]] || continue
    file_name="$(basename "$bundle_file")"
    sync_one "$bundle_file" "$live_bundle/$file_name" "$bundle_name/$file_name"
  done
done

if [[ $would_copy -eq 0 ]]; then
  if [[ $trouble -gt 0 ]]; then
    log "no syncable drift ($trouble skill(s) skipped due to compare errors — see warnings above)"
  else
    log "no drift — nothing to sync"
  fi
elif [[ $APPLY -eq 1 ]]; then
  if [[ $trouble -gt 0 ]]; then
    log "synced $synced seeded skill(s); $trouble skipped due to compare errors"
  else
    log "synced $synced seeded skill(s)"
  fi
else
  echo ""
  if [[ $trouble -gt 0 ]]; then
    warn "dry-run: $would_copy seeded skill(s) would be synced; $trouble skipped due to compare errors; re-run with --yes to apply"
  else
    warn "dry-run: $would_copy seeded skill(s) would be synced; re-run with --yes to apply"
  fi
fi

completed_normally=1
