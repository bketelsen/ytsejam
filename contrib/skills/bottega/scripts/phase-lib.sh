#!/usr/bin/env bash
# phase-lib.sh — sequence shepherd: parse / state / gate / tick. Sourced by bottega-api.sh.
# All functions are prefixed `phase_`. No global side effects on source.

# phase_parse <file> -> normalized phase JSON {phase,project,advance,tasks:{key:{key,title,brief,after[]}}}
phase_parse() {
  local f="$1" json
  [ -f "$f" ] || { echo "phase file not found: $f" >&2; return 2; }
  command -v yq >/dev/null 2>&1 || { echo "yq not found — install mikefarah yq (phase YAML needs it)" >&2; return 3; }
  # yq (mikefarah) converts YAML->JSON; then jq normalizes tasks[] -> map keyed by .key
  json="$(yq -o=json '.' "$f" | jq '
    {phase, project, advance: (.advance // (if .autonomous == true then "auto" else "park" end)),
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
  local adv
  adv="$(printf '%s' "$json" | jq -r '(.advance // (if .autonomous == true then "auto" else "park" end))')" || return $?
  case "$adv" in
    park|auto|yolo) ;;
    *) echo "phase: invalid advance '$adv' (must be park|auto|yolo)" >&2; return 5 ;;
  esac
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
    phase, project, advance, scheduleId: $sid,
    tasks: (.tasks | map_values({key, title, brief, after, taskId: null, state: "pending", pr: null, reason: null})),
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

# phase_task_set_str <slug> <key> <field> <string-value> — set one string field without jq-code interpolation.
phase_task_set_str() {
  local slug="$1" key="$2" field="$3" val="$4" cur j
  cur="$(phase_state_read "$slug")" || return $?
  j="$(printf '%s' "$cur" | jq --arg k "$key" --arg f "$field" --arg v "$val" '.tasks[$k][$f] = $v')" || return $?
  phase_state_write "$slug" "$j"
}

# phase_reconcile <slug> — map Bottega task/PR status into local phase state.
# Pure over injectable lookup function: PHASE_TASK_STATUS_FN or _phase_task_status_live.
phase_reconcile() {
  local slug="$1" j key tid state ts blocked pr_done prnum pr_value status_fn adv
  j="$(phase_state_read "$slug")" || return $?
  status_fn="${PHASE_TASK_STATUS_FN:-_phase_task_status_live}"
  adv="$(printf '%s' "$j" | jq -r '(.advance // (if .autonomous == true then "auto" else "park" end))')" || return $?

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
      continue
    fi

    local plan_done wf_done reason
    plan_done="$(printf '%s' "$ts" | jq -r '(.planification_complete // false) | if . == true or . == 1 then "1" else "0" end')" || return $?
    wf_done="$(printf '%s' "$ts" | jq -r '(.workflow_complete // false) | if . == true or . == 1 then "1" else "0" end')" || return $?
    [ "$state" = "running" ] || continue
    [ "$plan_done" = "1" ] || continue
    [ "$wf_done" != "1" ] || continue

    case "$adv" in
      auto)
        reason="$(phase_state_read "$slug" | jq -r --arg k "$key" '.tasks[$k].reason // ""')" || return $?
        [ "$reason" != "impl-kicked" ] || continue
        "${PHASE_KICKOFF_FN:-_phase_kickoff_live}" "$tid" implementation || return $?
        phase_task_set_str "$slug" "$key" reason "impl-kicked" || return $?
        phase_log "$slug" "auto-advanced $key to implementation (task $tid)" || return $?
        ;;
      park)
        reason="$(phase_state_read "$slug" | jq -r --arg k "$key" '.tasks[$k].reason // ""')" || return $?
        if [ "$reason" != "awaiting-plan-review" ]; then
          phase_task_set_str "$slug" "$key" reason "awaiting-plan-review" || return $?
          phase_log "$slug" "awaiting-plan-review $key (task $tid)" || return $?
        fi
        ;;
      yolo) ;;
    esac
  done <<< "$keys"
}

# phase_gate <slug> <key> -> stdout verdict: pass OR park:<reason>.
# Fail-closed merge gate: any failed check OR check that cannot run parks.
# Intent-match note: auto/yolo merge has no human allowlist; it trusts only the mechanical backstops below.
phase_gate() {
  local slug="$1" key="$2" j tid pr br ci mergeable blocked clash meta
  local -a mf
  j="$(phase_state_read "$slug")" || { echo "park:state-read-failed"; return 1; }
  tid="$(printf '%s' "$j" | jq -r --arg k "$key" '.tasks[$k].taskId')" || { echo "park:tid-read-failed"; return 1; }
  pr="$(printf '%s' "$j" | jq -r --arg k "$key" '.tasks[$k].pr')" || { echo "park:pr-read-failed"; return 1; }
  if [ "$pr" = "null" ]; then
    local na
    na="$(printf '%s' "$j" | jq -r --arg k "$key" '(.tasks[$k].nopr_attempts // 0)')"
    case "$na" in ''|*[!0-9]*) na=0 ;; esac
    if [ "$na" -ge "${PHASE_MAX_NOPR_ATTEMPTS:-3}" ]; then
      echo "park:no-pr-timeout"; return 0
    fi
    phase_task_set "$slug" "$key" ".nopr_attempts = $((na + 1))" >/dev/null 2>&1 || true
    echo "retry:no-pr"; return 0
  fi

  br="$("${PHASE_PR_BRANCH_FN:-_phase_pr_branch_live}" "$tid")" || { echo "park:branch-resolve-failed"; return 0; }
  [ -z "$br" ] && { echo "park:branch-empty"; return 0; }
  case "$br" in
    -*|*[!A-Za-z0-9._/-]*) echo "park:bad-branch-name"; return 0 ;;
  esac

  meta="$("${PHASE_PR_META_FN:-_phase_pr_meta_live}" "$tid")" || { echo "park:meta-check-failed"; return 0; }
  read -r -a mf <<< "$meta"
  [ "${#mf[@]}" -eq 3 ] || { echo "park:meta-malformed"; return 0; }
  ci="${mf[0]}"; mergeable="${mf[1]}"; blocked="${mf[2]}"
  [[ "$blocked" =~ ^[01]$ ]] || { echo "park:meta-malformed"; return 0; }
  [ "$blocked" = "1" ] && { echo "park:workflow_blocked"; return 0; }
  [ "$ci" = "pass" ] || { echo "park:ci-$ci"; return 0; }
  [ "$mergeable" = "MERGEABLE" ] || { echo "park:not-mergeable($mergeable)"; return 0; }

  # Branch protection on main is strict (require up-to-date) — a BEHIND PR cannot merge.
  # Detect read-only via gh; fix via Bottega sync+push (keeps worktree+remote ref in lockstep), bounded.
  local mss
  mss="$("${PHASE_PR_BEHIND_FN:-_phase_pr_behind_live}" "$pr")" || { echo "park:behind-check-failed"; return 0; }
  case "$mss" in
    BEHIND)
      local ua
      ua="$(printf '%s' "$j" | jq -r --arg k "$key" '(.tasks[$k].update_attempts // 0)')"
      case "$ua" in ''|*[!0-9]*) ua=0 ;; esac
      if [ "$ua" -ge "${PHASE_MAX_UPDATE_ATTEMPTS:-3}" ]; then
        echo "park:stuck-behind"; return 0
      fi
      phase_task_set "$slug" "$key" ".update_attempts = $((ua + 1))" >/dev/null 2>&1 || true
      "${PHASE_SYNC_FN:-_phase_sync_live}" "$tid"  || { echo "park:sync-failed"; return 0; }
      "${PHASE_PUSH_FN:-_phase_push_live}" "$tid"  || { echo "park:push-failed"; return 0; }
      echo "retry:behind-updating"; return 0
      ;;
    CONFLICTING|DIRTY)
      echo "park:merge-conflict($mss)"; return 0
      ;;
  esac

  clash="$("${PHASE_STALE_BASE_FN:-_phase_stale_base_live}" "$br")" || { echo "park:stale-base-check-failed"; return 0; }
  [ -n "$clash" ] && { echo "park:stale-base-overlap[$(printf '%s' "$clash" | tr '\n' ',')]"; return 0; }

  if ! "${PHASE_CONTAINER_GATE_FN:-_phase_container_gate_live}" "$br"; then echo "park:gate-red"; return 0; fi
  phase_task_set "$slug" "$key" ".update_attempts = 0 | .nopr_attempts = 0" >/dev/null 2>&1 || true
  echo "pass"; return 0
}

# phase_launch_ready <slug> — launch pending tasks whose dependencies are all merged.
phase_launch_ready() {
  local slug="$1" j key keys
  j="$(phase_state_read "$slug")" || return $?
  keys="$(printf '%s' "$j" | jq -r '.tasks | keys[]')" || return $?
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    local st
    st="$(printf '%s' "$j" | jq -r --arg k "$key" '.tasks[$k].state')" || return $?
    [ "$st" = "pending" ] || continue

    local unmet
    unmet="$(printf '%s' "$j" | jq -r --arg k "$key" '
      first(.tasks as $t | $t[$k].after[]? | select(($t[.].state // "pending") != "merged")) // empty')" || return $?
    [ -n "$unmet" ] && continue

    local title brief proj newid adv yolo
    title="$(printf '%s' "$j" | jq -r --arg k "$key" '.tasks[$k].title // $k')" || return $?
    brief="$(printf '%s' "$j" | jq -r --arg k "$key" '.tasks[$k].brief // ""')" || return $?
    proj="$(printf '%s' "$j" | jq -r '.project')" || return $?
    adv="$(printf '%s' "$j" | jq -r '(.advance // (if .autonomous == true then "auto" else "park" end))')" || return $?
    if [ "$adv" = "yolo" ]; then yolo=1; else yolo=0; fi
    if ! newid="$("${PHASE_CREATE_FN:-_phase_create_live}" "$proj" "$key" "$title" "$brief" "$yolo")"; then
      phase_task_set "$slug" "$key" '.state="failed"' || return $?
      phase_task_set_str "$slug" "$key" reason "create-failed" || return $?
      continue
    fi
    if [ -z "$newid" ] || [ "$newid" = "null" ] || ! [[ "$newid" =~ ^[0-9]+$ ]]; then
      phase_task_set "$slug" "$key" '.state="failed"' || return $?
      phase_task_set_str "$slug" "$key" reason "create-failed" || return $?
      continue
    fi
    # ponytail: kickoff is fire-and-forget — a created task is marked running even if kickoff fails (recovered by reconcile), never stranded.
    # yolo tasks must be kicked with agentType=yolo (Bottega does NOT auto-start a yolo run on create — the task would sit forever otherwise); all other modes start with planification.
    if [ "$adv" = "yolo" ]; then
      "${PHASE_KICKOFF_FN:-_phase_kickoff_live}" "$newid" yolo >/dev/null 2>&1 || true
    else
      "${PHASE_KICKOFF_FN:-_phase_kickoff_live}" "$newid" >/dev/null 2>&1 || true
    fi
    phase_task_set "$slug" "$key" ".taskId=$newid | .state=\"running\"" || return $?
    phase_log "$slug" "launched $key as task $newid" || return $?
  done <<< "$keys"
}

# phase_advance_prs <slug> — gate open PRs and merge only in auto/yolo mode when the gate passes.
phase_advance_prs() {
  local slug="$1" j key adv keys
  j="$(phase_state_read "$slug")" || return $?
  adv="$(printf '%s' "$j" | jq -r '(.advance // (if .autonomous == true then "auto" else "park" end))')" || return $?
  keys="$(printf '%s' "$j" | jq -r '[.tasks|to_entries[]|select(.value.state=="pr_open")|.key][]')" || return $?
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    local verdict grc
    verdict="$(phase_gate "$slug" "$key")"; grc=$?
    verdict="${verdict##*$'\n'}"          # operative token = last line; tolerates chatty container-gate stdout leaked through phase_gate
    if [ "$grc" -eq 0 ] && [ "$verdict" = "pass" ]; then
      if [ "$adv" = "park" ]; then
        local cur_reason
        cur_reason="$(phase_state_read "$slug" | jq -r --arg k "$key" '.tasks[$k].reason // ""')" || return $?
        if [ "$cur_reason" != "awaiting-merge" ]; then
          phase_task_set_str "$slug" "$key" reason "awaiting-merge" || return $?
          phase_log "$slug" "awaiting-merge $key" || return $?
        fi
        continue
      fi
      local pr mtid
      pr="$(phase_state_read "$slug" | jq -r --arg k "$key" '.tasks[$k].pr')" || return $?
      mtid="$(phase_state_read "$slug" | jq -r --arg k "$key" '.tasks[$k].taskId')" || return $?
      if ! [[ "$pr" =~ ^[0-9]+$ ]]; then
        phase_task_set "$slug" "$key" '.state="parked"'; phase_task_set_str "$slug" "$key" reason "bad-pr-number" || return $?
        phase_log "$slug" "parked $key: bad-pr-number ($pr)" || return $?
        continue
      fi
      if ! [[ "$mtid" =~ ^[0-9]+$ ]]; then
        phase_task_set "$slug" "$key" '.state="parked"'; phase_task_set_str "$slug" "$key" reason "bad-taskid" || return $?
        phase_log "$slug" "parked $key: bad-taskid ($mtid)" || return $?
        continue
      fi
      if "${PHASE_MERGE_FN:-_phase_merge_live}" "$mtid"; then
        phase_task_set "$slug" "$key" '.state="merged"' || return $?
        phase_log "$slug" "merged $key (task $mtid, pr $pr)" || return $?
      else
        phase_task_set "$slug" "$key" '.state="parked"' || return $?
        phase_task_set_str "$slug" "$key" reason "merge-failed" || return $?
      fi
    elif [ "$grc" -eq 0 ] && [ "${verdict#retry:}" != "$verdict" ]; then
      # Non-terminal: leave state pr_open so the next tick re-gates. Log only if the reason changed.
      local cur_reason
      cur_reason="$(phase_state_read "$slug" | jq -r --arg k "$key" '.tasks[$k].reason // ""')" || return $?
      if [ "$cur_reason" != "$verdict" ]; then
        phase_task_set_str "$slug" "$key" reason "$verdict" || return $?
        phase_log "$slug" "retry $key: $verdict" || return $?
      fi
    else
      phase_task_set "$slug" "$key" '.state="parked"' || return $?
      phase_task_set_str "$slug" "$key" reason "$verdict" || return $?
      phase_log "$slug" "parked $key: $verdict" || return $?
    fi
  done <<< "$keys"
}

# phase_tick_once <slug> — one orchestration tick; returns 0 when no pending/running/pr_open tasks remain.
phase_tick_once() {
  local slug="$1"
  phase_reconcile "$slug" || return $?
  phase_advance_prs "$slug" || return $?
  phase_launch_ready "$slug" || return $?
  local j2 remaining
  j2="$(phase_state_read "$slug")" || return 1
  remaining="$(printf '%s' "$j2" | jq -r '[.tasks[]|select(.state|IN("pending","running","pr_open"))]|length')" || return 1
  case "$remaining" in ''|*[!0-9]*) return 1 ;; esac
  [ "$remaining" -eq 0 ]
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
    a=\$(git diff --name-only \"\$base\" \"origin/$br\") || exit 4
    b=\$(git diff --name-only \"\$base\" origin/main) || exit 5
    comm -12 <(printf '%s\n' \"\$a\" | sort -u) <(printf '%s\n' \"\$b\" | sort -u)
  "
}

# _phase_bottega_post <path> <json-body> -> raw response body. Uses api() if sourced, else curls with Bearer key.
_phase_bottega_post() {
  local path="$1" body="$2"
  if declare -F api >/dev/null 2>&1; then
    api POST "$path" "$body"
  else
    local base key
    base="${BOTTEGA_BASE:?BOTTEGA_BASE unset}"
    key="$(cat "${BOTTEGA_KEY_FILE:?BOTTEGA_KEY_FILE unset}")"
    curl -fsS -X POST -H "Authorization: Bearer $key" -H "Content-Type: application/json" \
      -d "$body" "$base$path"
  fi
}

# _phase_pr_behind_live <pr-number> -> stdout = mergeStateStatus (BEHIND|CLEAN|CONFLICTING|DIRTY|BLOCKED|UNKNOWN|...)
# Read-only. MUST exit non-zero if it cannot run, so the caller parks behind-check-failed rather than mis-deciding.
_phase_pr_behind_live() {
  local pr="$1"
  incus exec bottega -- su - code -c "
    set -e; cd ~/projects/ytsejam
    gh pr view \"$pr\" --json mergeStateStatus --jq '.mergeStateStatus' 2>/dev/null
  "
}

# _phase_sync_live <taskId> -> POST /api/tasks/<id>/sync (git fetch origin + merge origin/main into worktree). exit 0 on {"success":true}.
_phase_sync_live() {
  local tid="$1" out
  out="$(_phase_bottega_post "/api/tasks/$tid/sync" '{}')" || return 1
  printf '%s' "$out" | jq -e '.success == true' >/dev/null 2>&1
}

# _phase_push_live <taskId> -> POST /api/tasks/<id>/push-changes (commit-if-dirty + push to PR branch). Idempotent. exit 0 on {"success":true}.
_phase_push_live() {
  local tid="$1" out
  out="$(_phase_bottega_post "/api/tasks/$tid/push-changes" '{}')" || return 1
  printf '%s' "$out" | jq -e '.success == true' >/dev/null 2>&1
}

_phase_pr_branch_live() {  # <tid> -> branch name (Task 6 will wire gh; placeholder errors so live use before Task-6 fails closed)
  echo "_phase_pr_branch_live: not wired until Task 6" >&2; return 1
}

_phase_pr_meta_live() {  # <tid> -> "ci mergeable blocked" (Task 6 wires bottega-api.sh); placeholder errors closed
  echo "_phase_pr_meta_live: not wired until Task 6" >&2; return 1
}


_phase_create_live() {  # <project> <key> <title> -> task id (Task 6 will wire bottega-api.sh)
  echo "_phase_create_live: not wired until Task 6" >&2; return 1
}

_phase_kickoff_live() {  # <task-id> -> start task (Task 6 will wire bottega-api.sh)
  echo "_phase_kickoff_live: not wired until Task 6" >&2; return 1
}

_phase_merge_live() {  # <tid> -> merge PR (Task 6 will wire gh/API)
  echo "_phase_merge_live: not wired until Task 6" >&2; return 1
}
