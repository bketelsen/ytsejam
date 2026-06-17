#!/usr/bin/env bash
# bottega-api.sh — majordomo helper for the Bottega HTTP API (github.com/vdaubry/bottega).
# Wraps auth + jq parsing for the read path and the two writes (create, kickoff).
# Auth: reads a ccui_ account API key from $BOTTEGA_KEY_FILE (default below), mode-600.
# All endpoints are /api-prefixed on $BOTTEGA_BASE. Requires: curl, jq, (gh for diff verify).
set -euo pipefail

BOTTEGA_BASE="${BOTTEGA_BASE:-http://10.161.72.31:3001}"   # container Bottega (host instance retired); set BOTTEGA_BASE to override
BOTTEGA_KEY_FILE="${BOTTEGA_KEY_FILE:-$HOME/.ytsejam/data/secrets/bottega-api-key-container}"

key() {
  [ -f "$BOTTEGA_KEY_FILE" ] || { echo "no key file at $BOTTEGA_KEY_FILE (mint one in the Bottega UI, persist mode 600)" >&2; exit 2; }
  cat "$BOTTEGA_KEY_FILE"
}
api() { # api <method> <path> [data]
  local m="$1" p="$2" d="${3:-}"
  if [ -n "$d" ]; then
    curl -sS -m 20 -X "$m" -H "Authorization: Bearer $(key)" -H "Content-Type: application/json" -d "$d" "$BOTTEGA_BASE$p"
  else
    curl -sS -m 20 -X "$m" -H "Authorization: Bearer $(key)" "$BOTTEGA_BASE$p"
  fi
}
# normalize an agent-runs response (bare array OR {agentRuns|runs|data:[...]}) to an array
runs_arr() { jq 'if type=="array" then . else (.agentRuns // .runs // .data // []) end'; }
task_obj() { jq '(.task // .)'; } # task endpoints sometimes wrap in {task:...}

create_task() { # create_task <projectId> <title> <body|@file> [yolo_mode=0] -> prints task id only
  # The task brief MUST go in the "description" field — that is what the server
  # writes to task-<id>.md (the planner's {{taskDocPath}}). "documentation" is
  # NOT a create field and is silently dropped, leaving a 0-byte brief.
  local proj="$1" title="$2" body="$3" payload tid
  case "$body" in @*) body="$(cat "${body#@}")";; esac
  local yolo_bool=false; [ "${4:-0}" != "0" ] && yolo_bool=true
  payload=$(jq -n --arg t "$title" --arg b "$body" --argjson y "$yolo_bool" '{title:$t, description:$b, yolo_mode:$y}')
  CREATE_TASK_RESP=$(api POST "/api/projects/$proj/tasks" "$payload")
  tid=$(printf '%s' "$CREATE_TASK_RESP" | jq -r '(.task // .).id // empty')
  if [ -z "$tid" ]; then echo "create FAILED: $CREATE_TASK_RESP" >&2; return 1; fi
  printf '%s\n' "$tid"
}

# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/phase-lib.sh"

_phase_task_status_live() { api GET "/api/tasks/$1" | task_obj; }

_phase_create_live() { # <project> <key> <title> <brief> <yolo_mode> -> task id
  local body="$4"
  [ -n "$body" ] || body="$3"
  create_task "$1" "$3" "$body" "${5:-0}"
}

_phase_kickoff_live() {
  local at="${2:-planification}"
  api POST "/api/tasks/$1/agent-runs" "$(jq -n --arg a "$at" '{agentType:$a}')" >/dev/null
}

_phase_pr_branch_live() {  # <tid> -> head branch name
  local prj exists prnum
  prj="$(api GET "/api/tasks/$1/pull-request")" || return 1
  exists="$(printf '%s' "$prj" | jq -r '.exists // false')" || return 1
  [ "$exists" = "true" ] || return 1
  prnum="$(printf '%s' "$prj" | jq -r '.url // ""' | sed -nE 's#.*/pull/([0-9]+).*#\1#p')" || return 1
  [ -n "$prnum" ] || return 1
  gh pr view "$prnum" --repo bketelsen/ytsejam --json headRefName --jq '.headRefName // empty'
}

_phase_pr_meta_live() {  # <tid> -> "ci mergeable blocked"
  local prj tj ci mrg blk
  prj="$(api GET "/api/tasks/$1/pull-request")" || return 1
  tj="$(api GET "/api/tasks/$1" | task_obj)" || return 1
  ci="$(printf '%s' "$prj" | jq -r '.ciStatus.status // "unknown"')" || return 1
  mrg="$(printf '%s' "$prj" | jq -r '.mergeable // "UNKNOWN"')" || return 1
  blk="$(printf '%s' "$tj" | jq -r '(.workflow_blocked // false) | if . == true or . == 1 then 1 else 0 end')" || return 1
  printf '%s %s %s\n' "$ci" "$mrg" "$blk"
}

_phase_merge_live() {  # <tid> -> merge via Bottega merge-cleanup (reaps worktree)
  # ponytail: merge-cleanup is merge-THEN-clean (non-idempotent) and deliberately replaces raw gh so Bottega reaps worktrees.
  local r
  r="$(api POST "/api/tasks/$1/merge-cleanup" '{}')" || return 1
  [ "$(printf '%s' "$r" | jq -r '.success // false')" = "true" ] || return 1
}

_phase_schedule_register() { echo "PENDING-AGENT-SCHEDULE"; }   # agent replaces with a real cron id
_phase_schedule_cancel() { echo "AGENT: cancel schedule $1" >&2; }

_phase_status_pretty() {
  local slug="$1"
  phase_state_read "$slug" | jq -r '
    "phase: \(.phase)  project=\(.project)  advance=\(.advance // (if .autonomous == true then "auto" else "park" end))  scheduleId=\(.scheduleId // "")",
    (.tasks | to_entries[] | "  \(.key): \(.value.state) task=\(.value.taskId // "-") pr=\(.value.pr // "-") reason=\(.value.reason // "-") after=[\((.value.after // []) | join(","))]"),
    (if ((.log // []) | length) > 0 then "log:", ((.log // [])[] | "  \(.)") else empty end)'
}

_phase_cancel_if_complete() {
  local slug="$1" remaining sid cur j
  cur="$(phase_state_read "$slug")" || return $?
  remaining="$(printf '%s' "$cur" | jq -r '[.tasks[]|select(.state|IN("pending","running","pr_open"))]|length')" || return $?
  if [ "$remaining" = "0" ]; then
    sid="$(printf '%s' "$cur" | jq -r '.scheduleId // empty')" || return $?
    if [ -n "$sid" ]; then
      _phase_schedule_cancel "$sid" || true
      j="$(printf '%s' "$cur" | jq '.scheduleId = ""')" || return $?
      phase_state_write "$slug" "$j" || return $?
      phase_log "$slug" "complete; canceled schedule $sid" || return $?
    fi
  fi
}

cmd="${1:-help}"; shift || true
case "$cmd" in
  check)
    code=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$BOTTEGA_BASE/health" || true)
    echo "health: $code"
    api GET /api/auth/user | jq -r '(.user // .) as $u | if $u.username then "auth OK: \($u.username) (id \($u.id), admin=\($u.is_admin // "?"), technical=\($u.is_technical // "?"))" else "auth FAILED: \(.)" end'
    ;;
  projects) api GET /api/projects | jq -r '(if type=="array" then . else (.projects // .data // []) end)[] | "[\(.id)] \(.name)  repo=\(.repo_folder_path // .repo_path // "?")"' ;;
  tasks)    api GET /api/tasks | jq -r '(.tasks // . ) | (if type=="array" then . else [.] end)[] | "[\(.id)] \(.title)  status=\(.status)  proj=\(.project_id // .projectId)"' ;;
  task)     api GET "/api/tasks/$1" | task_obj | jq -r '"[\(.id)] \(.title)\n  status=\(.status)  runs=\(.workflow_run_count)\n  plan=\(.planification_complete) wf_complete=\(.workflow_complete) blocked=\(.workflow_blocked) refine=\(.refinement_complete) pr=\(.pr_agent_complete)\n  updated=\(.updated_at)"' ;;
  runs)     api GET "/api/tasks/$1/agent-runs" | runs_arr | jq -r 'sort_by(.id)[] | "  run#\(.id)  type=\(.agent_type)  status=\(.status)  model=\(.model // "-")  created=\(.created_at)  done=\(.completed_at // "RUNNING")"' ;;
  doc)      api GET "/api/tasks/$1/documentation" | jq -r '.content // .documentation // .doc // .markdown // .' ;;
  doc-set)  # doc-set <taskId> <body|@file>  -> overwrite the task brief (PUT documentation)
    tid="$1"; body="$2"
    case "$body" in @*) body="$(cat "${body#@}")";; esac
    body_bytes=$(printf '%s' "$body" | wc -c | tr -d ' ')
    api PUT "/api/tasks/$tid/documentation" "$(jq -n --arg c "$body" '{content:$c}')" | jq -r --arg body_bytes "$body_bytes" '. as $r | if .success then "doc-set OK: task '"$tid"' brief now \($body_bytes) bytes sent" else ($r|tostring) end' ;;
  pr)       api GET "/api/tasks/$1/pull-request" | jq -r 'if .exists==false then "no live PR (none opened yet, or merged/closed + branch deleted)" else "url=\(.url)\nstate=\(.state)  mergeable=\(.mergeable)  ci=\(.ciStatus.status // "?")" end' ;;
  copilot)  api GET /api/copilot-auth/status | jq -r '"authenticated=\(.authenticated)  status=\(.status)  login=\(.login // .username // "-")"' ;;
  models)   api GET /api/copilot-auth/models | jq -r '(.models // .data // .) | (if type=="array" then .[] else . end) | (.id // .name // .)' ;;

  create) # create <projectId> <title> <body|@file>  -> prints new task id
    proj="$1"; title="$2"; body="$3"
    tid_file="$(mktemp)"
    create_task "$proj" "$title" "$body" > "$tid_file"
    tid="$(cat "$tid_file")"
    rm -f "$tid_file"
    echo "created task id=$tid  title=$(printf '%s' "$CREATE_TASK_RESP" | jq -r '(.task // .).title')"
    # GUARD: read the brief back and assert it landed. A 0-byte doc means the
    # planner will run on the title alone (see "documentation" pitfall above).
    doclen=$("${BASH_SOURCE[0]}" doc "$tid" | wc -c)
    if [ "$doclen" -le 1 ]; then
      echo "WARNING: task $tid documentation is EMPTY ($doclen bytes) — the planner will have NO brief, only the title. If you passed a body, you likely used the wrong field/endpoint. Fix with: ${BASH_SOURCE[0]} doc-set $tid @<file>" >&2
    else
      echo "doc OK: task $tid brief is $doclen bytes"
    fi ;;

  kickoff) # kickoff <taskId> [agentType=planification] -> starts the loop
    tid="$1"; at="${2:-planification}"
    api POST "/api/tasks/$tid/agent-runs" "$(jq -n --arg a "$at" '{agentType:$a}')" \
      | jq -r '"started run#\((.agentRun // .run // .).id // "?")  type=\((.agentRun // .run // .).agent_type // "?")  status=\((.agentRun // .run // .).status // "?")"' ;;

  watch) # DELEGATE-ONLY: foreground poll-loop that BLOCKS its caller — run ONLY inside a background subagent, never in the main chat. watch <taskId> [maxPolls=20] [intervalSec=22] -> prints transitions, stops at pr_agent_complete or block
    tid="$1"; max="${2:-20}"; iv="${3:-22}"; prev=""
    for i in $(seq 1 "$max"); do
      line=$(api GET "/api/tasks/$tid" | task_obj | jq -r '"runs=\(.workflow_run_count) wf_complete=\(.workflow_complete) blocked=\(.workflow_blocked) refine=\(.refinement_complete) pr=\(.pr_agent_complete) status=\(.status)"')
      run=$(api GET "/api/tasks/$tid/agent-runs" | runs_arr | jq -r 'sort_by(.id)|last|"run#\(.id) \(.agent_type)/\(.status)"')
      ts=$(date +%H:%M:%S)
      if [ "$line|$run" != "$prev" ]; then echo "[$ts] $line | $run  <-- CHANGED"; prev="$line|$run"; else echo "[$ts] ... $run"; fi
      case "$line" in *"blocked=1"*) echo ">>> workflow_blocked=1 — triage (read 'doc $tid'), do NOT blind-retry"; break;; esac
      case "$line" in *"pr=1"*) echo ">>> pr_agent_complete=1"; api GET "/api/tasks/$tid/pull-request" | jq -r '"PR: \(.url)  state=\(.state)  ci=\(.ciStatus.status // "?")"'; break;; esac
      [ "$i" -lt "$max" ] && sleep "$iv"
    done ;;

  phase)
    verb="${1:-status}"; shift || true
    case "$verb" in
      run)
        file="$1"
        slug="$(basename "$file" | sed 's/\.[^.]*$//')"
        sched="$(_phase_schedule_register "$slug")"
        parsed="$(phase_parse "$file")"
        phase_state_init "$slug" "$parsed" "$sched" >/dev/null
        phase_tick_once "$slug" || true
        _phase_cancel_if_complete "$slug" || true
        _phase_status_pretty "$slug"
        ;;
      tick)
        slug="$1"
        phase_tick_once "$slug" || true
        _phase_cancel_if_complete "$slug" || true
        _phase_status_pretty "$slug"
        ;;
      status)
        slug="$1"
        if ! phase_state_path "$slug" >/dev/null; then exit 2; fi
        if [ ! -f "$(phase_state_path "$slug")" ]; then echo "no such phase: $slug" >&2; exit 2; fi
        _phase_status_pretty "$slug"
        ;;
      cancel)
        slug="$1"
        if ! cur="$(phase_state_read "$slug")"; then echo "no such phase: $slug" >&2; exit 2; fi
        sid="$(printf '%s' "$cur" | jq -r '.scheduleId // empty')"
        if [ -n "$sid" ]; then _phase_schedule_cancel "$sid"; fi
        next="$(printf '%s' "$cur" | jq '.scheduleId = ""')"
        phase_state_write "$slug" "$next"
        phase_log "$slug" "canceled schedule ${sid:-none}"
        _phase_status_pretty "$slug"
        ;;
      *)
        echo "usage: $0 phase {run <file>|tick <slug>|status <slug>|cancel <slug>}" >&2
        exit 2
        ;;
    esac ;;

  help|*)
    cat >&2 <<EOF
bottega-api.sh — Bottega majordomo helper
  check                         health + auth sanity
  projects | tasks              list
  task <id> | runs <id>         flag state | per-run detail
  doc <id>                      shared scratchpad (agent reasoning/checklist)
  pr <id>                       pull-request status
  copilot | models             provider auth status | model catalog
  create <proj> <title> <body|@file>   WRITE: create task -> id
  kickoff <id> [agentType]             WRITE: start the loop (default planification)
  watch <id> [maxPolls] [interval]     poll transitions until PR or block  (DELEGATE-ONLY: blocks the caller; run inside a subagent)
  phase run <file> | tick/status/cancel <slug>  shepherd a phase sequence
env: BOTTEGA_BASE=$BOTTEGA_BASE  BOTTEGA_KEY_FILE=$BOTTEGA_KEY_FILE
EOF
    ;;
esac
