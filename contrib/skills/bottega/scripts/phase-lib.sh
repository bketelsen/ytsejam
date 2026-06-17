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

# phase_reconcile <slug> — map Bottega task/PR status into local phase state.
# Pure over injectable lookup function: PHASE_TASK_STATUS_FN or _phase_task_status_live.
phase_reconcile() {
  local slug="$1" j key tid state ts blocked pr_done prnum pr_value status_fn
  j="$(phase_state_read "$slug")" || return $?
  status_fn="${PHASE_TASK_STATUS_FN:-_phase_task_status_live}"

  printf '%s' "$j" | jq -e '.tasks | type == "object"' >/dev/null 2>&1 || { echo "phase_reconcile: state has no valid .tasks object for \"$slug\"" >&2; return 4; }
  local keys
  keys="$(printf '%s' "$j" | jq -r '.tasks | keys[]')" || return $?
  while IFS= read -r key; do
    [ -z "$key" ] && continue
    tid="$(printf '%s' "$j" | jq -r --arg k "$key" '.tasks[$k].taskId')" || return $?
    state="$(printf '%s' "$j" | jq -r --arg k "$key" '.tasks[$k].state')" || return $?

    case "$state" in
      merged|parked|failed|pending|pr_open) continue ;;
    esac
    [ "$tid" != "null" ] || continue

    ts="$($status_fn "$tid")" || return $?
    blocked="$(printf '%s' "$ts" | jq -r '(.workflow_blocked // false) | if . == true or . == 1 then "1" else "0" end')" || return $?
    pr_done="$(printf '%s' "$ts" | jq -r '(.pr_agent_complete // false) | if . == true or . == 1 then "1" else "0" end')" || return $?

    if [ "$blocked" = "1" ]; then
      phase_task_set "$slug" "$key" '.state="parked" | .reason="workflow_blocked"' || return $?
      continue
    fi

    if [ "$pr_done" = "1" ]; then
      prnum="$(printf '%s' "$ts" | jq -r '.pr_number // .pr // empty')" || return $?
      if [[ "$prnum" =~ ^[0-9]+$ ]]; then
        pr_value="$prnum"
      else
        pr_value="null"
      fi
      phase_task_set "$slug" "$key" ".state=\"pr_open\" | .pr=$pr_value" || return $?
    fi
  done <<< "$keys"
}

# phase_gate <slug> <key> -> stdout verdict: pass OR park:<reason>.
# Fail-closed autonomous merge gate: any failed check OR check that cannot run parks.
# Intent-match note: autonomous v1 has no human allowlist; it trusts only the mechanical backstops below.
phase_gate() {
  local slug="$1" key="$2" j tid pr br ci mergeable blocked clash meta
  j="$(phase_state_read "$slug")" || { echo "park:state-read-failed"; return 1; }
  tid="$(printf '%s' "$j" | jq -r --arg k "$key" '.tasks[$k].taskId')" || { echo "park:tid-read-failed"; return 1; }
  pr="$(printf '%s' "$j" | jq -r --arg k "$key" '.tasks[$k].pr')" || { echo "park:pr-read-failed"; return 1; }
  [ "$pr" = "null" ] && { echo "park:no-pr"; return 0; }

  br="$("${PHASE_PR_BRANCH_FN:-_phase_pr_branch_live}" "$pr")" || { echo "park:branch-resolve-failed"; return 0; }
  [ -z "$br" ] && { echo "park:branch-empty"; return 0; }

  meta="$("${PHASE_PR_META_FN:-_phase_pr_meta_live}" "$pr" "$tid")" || { echo "park:meta-check-failed"; return 0; }
  read -r ci mergeable blocked <<< "$meta"
  { [ -n "$ci" ] && [ -n "$mergeable" ] && [ -n "$blocked" ]; } || { echo "park:meta-malformed"; return 0; }
  [ "$blocked" = "1" ] && { echo "park:workflow_blocked"; return 0; }
  [ "$ci" = "pass" ] || { echo "park:ci-$ci"; return 0; }
  [ "$mergeable" = "MERGEABLE" ] || { echo "park:not-mergeable($mergeable)"; return 0; }

  clash="$("${PHASE_STALE_BASE_FN:-_phase_stale_base_live}" "$br")" || { echo "park:stale-base-check-failed"; return 0; }
  [ -n "$clash" ] && { echo "park:stale-base-overlap[$(printf '%s' "$clash" | tr '\n' ',')]"; return 0; }

  if ! "${PHASE_CONTAINER_GATE_FN:-_phase_container_gate_live}" "$br"; then echo "park:gate-red"; return 0; fi
  echo "pass"; return 0
}

# ponytail: live helpers shell into the bottega container; offline tests inject stubs via PHASE_*_FN.
_phase_container_gate_live() {  # <pr-branch> -> exit 0 pass / non-zero fail (incl. can't-fetch=90)
  local br="$1"
  incus exec bottega -- su - code -c "
    set -e; cd ~/projects/ytsejam
    git fetch origin --quiet \"$br\" 2>/dev/null || git fetch origin --quiet
    wt=\$(mktemp -d); git worktree add -q \"\$wt\" \"origin/$br\" 2>/dev/null || { rm -rf \"\$wt\"; exit 90; }
    ( cd \"\$wt\" && bash scripts/gate.sh ); rc=\$?
    git worktree remove --force \"\$wt\" 2>/dev/null; rm -rf \"\$wt\"; exit \$rc
  "
}

_phase_stale_base_live() {  # <pr-branch> -> stdout = intersecting files (empty=safe); MUST exit non-zero if it cannot run
  local br="$1"
  incus exec bottega -- su - code -c "
    set -e; cd ~/projects/ytsejam; git fetch origin --quiet 2>/dev/null
    base=\$(git merge-base origin/main \"origin/$br\") || exit 3
    comm -12 <(git diff --name-only \"\$base\" \"origin/$br\" | sort -u) <(git diff --name-only \"\$base\" origin/main | sort -u)
  "
}

_phase_pr_branch_live() {  # <pr> -> branch name (Task 6 will wire gh; placeholder errors so live use before Task-6 fails closed)
  echo "_phase_pr_branch_live: not wired until Task 6" >&2; return 1
}

_phase_pr_meta_live() {  # <pr> <tid> -> "ci mergeable blocked" (Task 6 wires bottega-api.sh); placeholder errors closed
  echo "_phase_pr_meta_live: not wired until Task 6" >&2; return 1
}
