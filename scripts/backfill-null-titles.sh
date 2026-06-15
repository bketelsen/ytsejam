#!/usr/bin/env bash
# Backfill auto-titles on sessions with NULL title in the indexer.
#
# Why this exists: PR #187 (squash c2cf026) fixed maybeGenerateTitle for OAuth
# providers. Sessions created before that deploy still have NULL titles in the
# index. This script POSTs to the regenerate-title endpoint for each one, with
# a small delay to be polite to the model provider.
#
# Usage: ./scripts/backfill-null-titles.sh [--dry-run] [--server URL]
#   --dry-run        list ids without POSTing
#   --server URL     default: http://localhost:9873 (prod). Use :3000 for dev.
#
# Requires: sqlite3, curl. The server must be running.
# Idempotent: regenerate-title no-ops if the session already has a title.
set -euo pipefail

SERVER="http://localhost:9873"
DRY_RUN=0
DELAY="${BACKFILL_DELAY:-1.5}"  # seconds between calls

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --server) SERVER="$2"; shift 2 ;;
    -h|--help)
      sed -n '1,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

DB="${YTSEJAM_DATA_DIR:-$HOME/.ytsejam/data}/index.db"
[[ -f "$DB" ]] || { echo "index.db not found at $DB" >&2; exit 1; }

# Only target sessions with actual content (preview != ''). Empty sessions have
# no first user message and would no-op anyway, but skipping them keeps the
# log clean.
mapfile -t ids < <(sqlite3 "$DB" \
  "SELECT id FROM sessions WHERE title IS NULL AND preview != '' ORDER BY created_at;")

echo "found ${#ids[@]} NULL-titled sessions with content"
if [[ $DRY_RUN -eq 1 ]]; then
  printf '  %s\n' "${ids[@]}"
  exit 0
fi
[[ ${#ids[@]} -eq 0 ]] && exit 0

for id in "${ids[@]}"; do
  printf 'POST regenerate-title %s ... ' "$id"
  if curl -fsS -X POST "$SERVER/api/sessions/$id/regenerate-title" >/dev/null; then
    echo "ok"
  else
    echo "FAILED (continuing)" >&2
  fi
  sleep "$DELAY"
done

echo "done. re-check: sqlite3 $DB \"SELECT COUNT(*) FROM sessions WHERE title IS NULL AND preview != '';\""
