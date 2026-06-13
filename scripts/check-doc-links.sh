#!/usr/bin/env bash
# Verify markdown internal links in the given files resolve.
# Checks that:
#   - relative path targets exist
#   - if a #anchor is given, the target file contains a matching heading
# Skips: http(s) URLs, mailto:, plain #anchor (same-file anchors not yet validated).

set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <markdown file> [markdown file ...]" >&2
  exit 2
fi

fail=0

slugify() {
  # GitHub-compatible slug (mirrors Flet/github-slugger):
  # lowercase, strip everything except a-z 0-9 spaces hyphens, then spaces → hyphens
  # (consecutive spaces produce consecutive hyphens — em-dashes/section-marks etc. get
  # stripped but their surrounding spaces remain, e.g. "Foo — bar" → "foo--bar").
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9 -]//g' \
    | sed -E 's/ /-/g'
}

for src in "$@"; do
  src_dir="$(dirname "$src")"
  # Extract every (target) inside ](target) into an array so the per-link loop
  # runs in the PARENT shell, not a pipeline subshell. The previous
  # `grep | sed | while read` form put `while` in its own subshell, so `fail=1`
  # set inside the loop never propagated and the script always exited 0 even
  # when BROKEN: lines were printed (issue #112).
  # External/anchor-only links are filtered inside the loop rather than via a
  # second `grep -v` pipeline stage, because under `set -o pipefail` a
  # fully-filtered pipe exits non-zero — which used to false-fail files with
  # zero relative-path links (see #97). The trailing `|| true` on the grep
  # tolerates files with no markdown link syntax at all (same pipefail trap).
  mapfile -t links < <(grep -oE '\]\([^)]+\)' "$src" | sed -E 's/^\]\(//; s/\)$//' || true)
  for link in "${links[@]}"; do
    if [[ "$link" =~ ^(https?|mailto|#) ]]; then
      continue
    fi
    path="${link%%#*}"
    anchor=""
    if [[ "$link" == *"#"* ]]; then
      anchor="${link#*#}"
    fi
    target="$src_dir/$path"
    # Normalize via realpath if available, else best-effort.
    if command -v realpath >/dev/null 2>&1; then
      target="$(realpath -m "$target")"
    fi
    if [ ! -e "$target" ]; then
      echo "BROKEN: $src → $link (no file at $target)" >&2
      fail=1
      continue
    fi
    if [ -n "$anchor" ]; then
      # Build a flattened slug list of every # heading in the target.
      mapfile -t headings < <(grep -E '^#{1,6} ' "$target" | sed -E 's/^#+ //')
      found=0
      for h in "${headings[@]}"; do
        slug="$(slugify "$h")"
        if [ "$slug" = "$anchor" ]; then
          found=1
          break
        fi
      done
      if [ "$found" -eq 0 ]; then
        echo "BROKEN: $src → $link (anchor #$anchor not found in $target)" >&2
        fail=1
      fi
    fi
  done
done

if [ "$fail" -ne 0 ]; then
  echo "FAIL: one or more links are broken." >&2
  exit 1
fi

echo "OK: all internal links resolve."
