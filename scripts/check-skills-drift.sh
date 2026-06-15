#!/usr/bin/env bash
# Compare seeded skills in a release dir against the live runtime skills dir.
#
# Surfaces the seed→live drift that the COPYFILE_EXCL seeder ignores by
# design (see server/skills/UPSTREAM and docs/agents/skills.md). When a PR
# updates a seeded skill but the live copy already exists, the seeder skips
# the copy and the new behavior never reaches runtime. This script makes
# that drift loud at deploy time so the operator decides explicitly.
#
# Usage:
#   bash scripts/check-skills-drift.sh <release-skills-dir> <live-skills-dir>
#
# Exit codes:
#   0  no drift on any seeded name (live missing is fine — seeder will copy it on next boot)
#   1  one or more seeded names have differing content live
#   2  bad arguments
#
# Scope: both flat `<name>.md` seeds AND dir-bundle seeds (`<name>/SKILL.md`
# plus immediate sibling `*.md` resources like REFERENCE.md). Files only
# present live (no seed counterpart) are NEVER reported — same user-dir-wins
# contract that the seeder honors via COPYFILE_EXCL.

set -euo pipefail

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'

# Suppress color when stderr is not a terminal (deploy logs are routinely captured to files / CI consoles).
if [[ ! -t 2 ]]; then RED=''; YELLOW=''; GREEN=''; NC=''; fi

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <release-skills-dir> <live-skills-dir>" >&2
  exit 2
fi

SEED_DIR="$1"
LIVE_DIR="$2"

[[ -d "$SEED_DIR" ]] || { echo "seed dir not found: $SEED_DIR" >&2; exit 2; }
[[ -d "$LIVE_DIR" ]] || { echo "live dir not found: $LIVE_DIR" >&2; exit 2; }

drift_count=0
drift_names=()
drift_compare_trouble=()

# Iterate over flat seed files.
shopt -s nullglob
for seed_file in "$SEED_DIR"/*.md; do
  name="$(basename "$seed_file")"
  # defensive: skip if a future seed glob match is a directory, not a file
  [[ -f "$seed_file" ]] || continue
  live_file="$LIVE_DIR/$name"

  # Live missing is fine — boot will seed it via COPYFILE_EXCL.
  [[ -f "$live_file" ]] || continue

  # diff exit: 0=same, 1=differ, ≥2=trouble (unreadable, missing, etc).
  # Treat trouble as drift (conservative — block deploy) but tell the operator
  # it was an I/O error so they don't chase a fake content diff.
  rc=0
  diff -q "$seed_file" "$live_file" > /dev/null 2>&1 || rc=$?
  if [[ $rc -eq 1 ]]; then
    drift_count=$((drift_count + 1))
    drift_names+=("$name")
  elif [[ $rc -ne 0 ]]; then
    echo "warning: cannot compare $name (diff exit $rc) — treating as drift" >&2
    drift_count=$((drift_count + 1))
    drift_names+=("$name")
    drift_compare_trouble+=("$name")
  fi
done

# Iterate over dir-bundle seeds (`<name>/SKILL.md` and immediate sibling
# `*.md` resources). Each bundle file is independently tracked, reported as
# `<bundle>/<filename>` so the existing report formatting works unchanged.
# Files present only in a live bundle (no seed counterpart) are NEVER
# reported — same user-dir-wins contract as flat seeds.
for seed_skill in "$SEED_DIR"/*/SKILL.md; do
  [[ -f "$seed_skill" ]] || continue
  bundle_dir="$(dirname "$seed_skill")"
  bundle_name="$(basename "$bundle_dir")"
  live_bundle="$LIVE_DIR/$bundle_name"

  # Live bundle missing entirely: fine — boot seeds the whole bundle.
  [[ -d "$live_bundle" ]] || continue

  # Compare each seeded `*.md` in the bundle against its live counterpart.
  # Non-md sibling files are also covered (shell glob would miss them, but
  # bundles today are `*.md`-only; extend the glob when that changes).
  for bundle_file in "$bundle_dir"/*.md; do
    [[ -f "$bundle_file" ]] || continue
    file_name="$(basename "$bundle_file")"
    qualified="$bundle_name/$file_name"
    live_file="$live_bundle/$file_name"

    # Live counterpart missing: fine — boot's COPYFILE_EXCL seeds individual files.
    [[ -f "$live_file" ]] || continue

    rc=0
    diff -q "$bundle_file" "$live_file" > /dev/null 2>&1 || rc=$?
    if [[ $rc -eq 1 ]]; then
      drift_count=$((drift_count + 1))
      drift_names+=("$qualified")
    elif [[ $rc -ne 0 ]]; then
      echo "warning: cannot compare $qualified (diff exit $rc) — treating as drift" >&2
      drift_count=$((drift_count + 1))
      drift_names+=("$qualified")
      drift_compare_trouble+=("$qualified")
    fi
  done
done

if [[ $drift_count -eq 0 ]]; then
  echo -e "${GREEN}✓${NC} no seeded-skill drift between $SEED_DIR and $LIVE_DIR"
  exit 0
fi

# Loud report on stderr so it survives stdout capture.
{
  echo ""
  echo -e "${RED}✗ skill drift detected: $drift_count seeded skill(s) differ from live${NC}"
  echo ""
  echo "  seed dir: $SEED_DIR"
  echo "  live dir: $LIVE_DIR"
  echo ""
  for name in "${drift_names[@]}"; do
    echo -e "${YELLOW}── $name ──${NC}"
    compare_trouble=false
    for trouble_name in "${drift_compare_trouble[@]}"; do
      if [[ "$trouble_name" == "$name" ]]; then
        compare_trouble=true
        break
      fi
    done
    if [[ "$compare_trouble" == true ]]; then
      echo "comparison unavailable due to an I/O error; see warning above"
      echo ""
      continue
    fi
    diff -u "$LIVE_DIR/$name" "$SEED_DIR/$name" | head -40 || true
    echo ""
  done
  echo "Resolve before deploying:"
  echo "  1. Sync seeds → live:    bash deploy/sync-skills.sh --yes"
  echo "  2. Override (use sparingly): ALLOW_SKILL_DRIFT=1 bash deploy/deploy.sh"
  echo ""
} >&2

exit 1
