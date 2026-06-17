#!/usr/bin/env bash
# phase-lib.sh — sequence shepherd: parse / state / gate / tick. Sourced by bottega-api.sh.
# All functions are prefixed `phase_`. No global side effects on source.

# phase_parse <file> -> normalized phase JSON {phase,project,autonomous,tasks:{key:{key,title,brief,after[]}}}
phase_parse() {
  local f="$1" json
  [ -f "$f" ] || { echo "phase file not found: $f" >&2; return 2; }
  command -v yq >/dev/null 2>&1 || { echo "yq not found — install mikefarah yq (phase YAML needs it)" >&2; return 3; }
  # yq (mikefarah) converts YAML->JSON; then jq normalizes tasks[] -> map keyed by .key
  json="$(yq -o=json '.' "$f" | jq '
    {phase, project, autonomous: (.autonomous // false),
     tasks: ( (.tasks // []) | map({(.key): {key, title, brief, after: (.after // [])}}) | add // {} )}')" || return 1
  # key-shape guard: reject any task key that is not a safe identifier slug.
  # Detect by COUNT (not string-emptiness) so an empty-string key ("") is still caught.
  local nbad
  nbad="$(printf '%s' "$json" | jq '[.tasks | keys[]? | select(test("^[a-z0-9_-]+$") | not)] | length')"
  if [ "${nbad:-0}" -gt 0 ]; then
    # Emit one stderr line per offending key. `jq -r ... | @json` makes each key (even ""/embedded-newline) one JSON-quoted token.
    local k
    while IFS= read -r k; do
      echo "phase: invalid task key $k (keys must match [a-z0-9_-]+)" >&2
    done < <(printf '%s' "$json" | jq -r '.tasks | keys[]? | select(test("^[a-z0-9_-]+$") | not) | @json')
    return 4
  fi
  printf '%s\n' "$json"
}

PHASE_DIR="${PHASE_DIR:-$HOME/.bottega/phases}"   # overridable for tests

phase_state_path() {
  if ! printf '%s' "$1" | grep -qE '^[a-z0-9_-]+$'; then
    echo "phase_state_path: invalid slug \"$1\" (must match [a-z0-9_-]+)" >&2
    return 2
  fi
  echo "$PHASE_DIR/$1.json"
}

# phase_state_init <slug> <parsed-json> <scheduleId> -> writes initial state, all tasks pending
phase_state_init() {
  local slug="$1" parsed="$2" sched="${3:-}"
  mkdir -p "$PHASE_DIR"
  local p; p="$(phase_state_path "$slug")" || return $?
  echo "$parsed" | jq --arg sid "$sched" '{
    phase, project, autonomous, scheduleId: $sid,
    tasks: (.tasks | map_values({key, after, taskId: null, state: "pending", pr: null, reason: null})),
    log: []
  }' > "$p"
  echo "$p"
}

phase_state_read() {
  local p; p="$(phase_state_path "$1")" || return $?
  cat "$p"
}

# phase_state_write <slug> <json> — atomic (tmp+mv) so a crash mid-write never corrupts SSOT
phase_state_write() {
  local slug="$1" json="$2" p t
  # Refuse empty/null — a failed upstream read must never fabricate or clobber state (see phase_log/phase_task_set).
  if [ -z "$json" ] || [ "$json" = "null" ]; then
    echo "phase_state_write: refusing empty/null state for slug \"$slug\"" >&2
    return 6
  fi
  p="$(phase_state_path "$slug")" || return $?
  t="$(mktemp "${p}.XXXX")" || return $?
  if printf '%s' "$json" | jq '.' > "$t"; then
    mv "$t" "$p"
  else
    rm -f "$t"
    return 5
  fi
}

# ponytail: read-compute-write is not pair-atomic; safe because one cron owns one slug (serialized ticks). phase_state_write itself IS atomic (tmp+mv).
# phase_log <slug> <msg> — append-only audit line with timestamp
phase_log() {
  local slug="$1" msg="$2" cur j
  cur="$(phase_state_read "$slug")" || return $?
  j="$(printf '%s' "$cur" | jq --arg m "$(date -Is): $msg" '.log += [$m]')" || return $?
  phase_state_write "$slug" "$j"
}

# ponytail: read-compute-write is not pair-atomic; safe because one cron owns one slug (serialized ticks). phase_state_write itself IS atomic (tmp+mv).
# phase_task_set <slug> <key> <jq-assignment> — mutate one task, atomic
phase_task_set() {
  local slug="$1" key="$2" assign="$3" cur j
  cur="$(phase_state_read "$slug")" || return $?
  j="$(printf '%s' "$cur" | jq --arg k "$key" ".tasks[\$k] |= ($assign)")" || return $?
  phase_state_write "$slug" "$j"
}
