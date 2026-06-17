#!/usr/bin/env bash
# phase-lib.sh — sequence shepherd: parse / state / gate / tick. Sourced by bottega-api.sh.
# All functions are prefixed `phase_`. No global side effects on source.

# phase_parse <file> -> normalized phase JSON {phase,project,autonomous,tasks:{key:{key,title,brief,after[]}}}
phase_parse() {
  local f="$1"
  [ -f "$f" ] || { echo "phase file not found: $f" >&2; return 2; }
  if command -v yq >/dev/null 2>&1; then
    # yq (mikefarah) converts YAML->JSON; then jq normalizes tasks[] -> map keyed by .key
    yq -o=json '.' "$f" | jq '
      {phase, project, autonomous: (.autonomous // false),
       tasks: ( (.tasks // []) | map({(.key): {key, title, brief, after: (.after // [])}}) | add // {} )}'
  else
    echo "yq not found — install mikefarah yq (phase YAML needs it)" >&2
    return 3
  fi
}
