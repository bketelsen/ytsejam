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
    api PUT "/api/tasks/$tid/documentation" "$(jq -n --arg c "$body" '{content:$c}')" | jq -r '. as $r | if .success then "doc-set OK: task '"$tid"' brief now \($r|tostring|length) chars sent" else ($r|tostring) end' ;;
  pr)       api GET "/api/tasks/$1/pull-request" | jq -r 'if .exists==false then "no live PR (none opened yet, or merged/closed + branch deleted)" else "url=\(.url)\nstate=\(.state)  mergeable=\(.mergeable)  ci=\(.ciStatus.status // "?")" end' ;;
  copilot)  api GET /api/copilot-auth/status | jq -r '"authenticated=\(.authenticated)  status=\(.status)  login=\(.login // .username // "-")"' ;;
  models)   api GET /api/copilot-auth/models | jq -r '(.models // .data // .) | (if type=="array" then .[] else . end) | (.id // .name // .)' ;;

  create) # create <projectId> <title> <body|@file>  -> prints new task id
    # The task brief MUST go in the "description" field — that is what the server
    # writes to task-<id>.md (the planner's {{taskDocPath}}). "documentation" is
    # NOT a create field and is silently dropped, leaving a 0-byte brief.
    proj="$1"; title="$2"; body="$3"
    case "$body" in @*) body="$(cat "${body#@}")";; esac
    payload=$(jq -n --arg t "$title" --arg b "$body" '{title:$t, description:$b}')
    resp=$(api POST "/api/projects/$proj/tasks" "$payload")
    tid=$(printf '%s' "$resp" | jq -r '(.task // .).id // empty')
    if [ -z "$tid" ]; then echo "create FAILED: $resp" >&2; exit 1; fi
    echo "created task id=$tid  title=$(printf '%s' "$resp" | jq -r '(.task // .).title')"
    # GUARD: read the brief back and assert it landed. A 0-byte doc means the
    # planner will run on the title alone (see "documentation" pitfall above).
    doclen=$("$0" doc "$tid" | wc -c)
    if [ "$doclen" -le 1 ]; then
      echo "WARNING: task $tid documentation is EMPTY ($doclen bytes) — the planner will have NO brief, only the title. If you passed a body, you likely used the wrong field/endpoint. Fix with: $0 doc-set $tid @<file>" >&2
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
env: BOTTEGA_BASE=$BOTTEGA_BASE  BOTTEGA_KEY_FILE=$BOTTEGA_KEY_FILE
EOF
    ;;
esac
