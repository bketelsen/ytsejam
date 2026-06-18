#!/usr/bin/env bash
# shellcheck disable=SC1091,SC2016,SC2030,SC2031,SC2034,SC2155,SC2329,SC2028,SC2015
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../scripts/phase-lib.sh"
fails=0
check() { if eval "$2"; then echo "  ok: $1"; else echo "  FAIL: $1"; fails=$((fails+1)); fi; }

# create-payload regression helpers: source bottega-api in a subshell, shadow api(), and keep kickoff offline.
test_create_brief_reaches_description() {
  local td payload title desc rc
  td="$(mktemp -d)" || return $?
  (
    set -- __source_only
    . "$HERE/../scripts/bottega-api.sh" >/dev/null 2>/dev/null
    export PHASE_DIR="$td/phases"
    api() { printf '%s' "$3" > "$td/payload"; printf '{"task":{"id":777}}'; }
    _test_kickoff_noop() { :; }
    PHASE_KICKOFF_FN=_test_kickoff_noop
    parsed="$(jq -n --arg brief "BRIEF-BODY-XYZ" '{phase:"x",project:1,advance:"park",tasks:{t1:{key:"t1",title:"Title One",brief:$brief,after:[]}}}')"
    phase_state_init cb "$parsed" "" >/dev/null
    phase_launch_ready cb >/dev/null
  ); rc=$?
  if [ "$rc" -ne 0 ]; then rm -rf "$td"; return "$rc"; fi
  payload="$(cat "$td/payload")" || { rm -rf "$td"; return 1; }
  title="$(printf '%s' "$payload" | jq -r .title)" || { rm -rf "$td"; return 1; }
  desc="$(printf '%s' "$payload" | jq -r .description)" || { rm -rf "$td"; return 1; }
  rm -rf "$td"
  [ "$title" = "Title One" ] && [ "$desc" = "BRIEF-BODY-XYZ" ] && [ "$desc" != "t1" ]
}


test_create_yolo_payload() {
  local td rc park_yolo auto_yolo yolo_yolo
  td="$(mktemp -d)" || return $?
  (
    set -- __source_only
    . "$HERE/../scripts/bottega-api.sh" >/dev/null 2>/dev/null
    export PHASE_DIR="$td/phases"
    api() { printf '%s' "$3" > "$td/payload"; printf '{"task":{"id":779}}'; }
    _test_kickoff_noop() { :; }
    PHASE_KICKOFF_FN=_test_kickoff_noop
    parsed="$(jq -n '{phase:"x",project:1,advance:"park",tasks:{t1:{key:"t1",title:"Title One",brief:"Body",after:[]}}}')"
    phase_state_init cypark "$parsed" "" >/dev/null
    phase_launch_ready cypark >/dev/null
    cp "$td/payload" "$td/payload-park"
    parsed="$(jq -n '{phase:"x",project:1,advance:"auto",tasks:{t1:{key:"t1",title:"Title One",brief:"Body",after:[]}}}')"
    phase_state_init cyauto "$parsed" "" >/dev/null
    phase_launch_ready cyauto >/dev/null
    cp "$td/payload" "$td/payload-auto"
    parsed="$(jq -n '{phase:"x",project:1,advance:"yolo",tasks:{t1:{key:"t1",title:"Title One",brief:"Body",after:[]}}}')"
    phase_state_init cyyolo "$parsed" "" >/dev/null
    phase_launch_ready cyyolo >/dev/null
    cp "$td/payload" "$td/payload-yolo"
  ); rc=$?
  if [ "$rc" -ne 0 ]; then rm -rf "$td"; return "$rc"; fi
  park_yolo="$(jq -r .yolo_mode "$td/payload-park")" || { rm -rf "$td"; return 1; }
  auto_yolo="$(jq -r .yolo_mode "$td/payload-auto")" || { rm -rf "$td"; return 1; }
  yolo_yolo="$(jq -r .yolo_mode "$td/payload-yolo")" || { rm -rf "$td"; return 1; }
  local yolo_type
  yolo_type="$(jq -r '.yolo_mode|type' "$td/payload-yolo" 2>/dev/null)" || yolo_type="?"
  rm -rf "$td"
  # Bottega's create schema rejects a number; the payload yolo_mode MUST be a JSON boolean.
  [ "$park_yolo" = "false" ] && [ "$auto_yolo" = "false" ] && [ "$yolo_yolo" = "true" ] && [ "$yolo_type" = "boolean" ]
}

# A yolo task MUST be kicked with agentType=yolo (Bottega does NOT auto-start a yolo run on create;
# without this kick the task would sit forever). park/auto start with planification (no agentType arg).
test_launch_kicks_yolo_agent() {
  local td rc park_kick yolo_kick
  td="$(mktemp -d)" || return $?
  (
    set -- __source_only
    . "$HERE/../scripts/bottega-api.sh" >/dev/null 2>/dev/null
    export PHASE_DIR="$td/phases"
    # create stub returns a fixed id; kick stub records "<id> <agentType>" per call.
    api() { printf '{"task":{"id":781}}'; }
    _t_kick_rec() { printf '%s|%s\n' "$1" "${2:-PLANIFICATION}" >> "$td/kicks"; }
    PHASE_KICKOFF_FN=_t_kick_rec
    : > "$td/kicks"
    parsed="$(jq -n '{phase:"x",project:1,advance:"park",tasks:{t1:{key:"t1",title:"T",brief:"B",after:[]}}}')"
    phase_state_init lkpark "$parsed" "" >/dev/null
    phase_launch_ready lkpark >/dev/null
    cp "$td/kicks" "$td/kicks-park"; : > "$td/kicks"
    parsed="$(jq -n '{phase:"x",project:1,advance:"yolo",tasks:{t1:{key:"t1",title:"T",brief:"B",after:[]}}}')"
    phase_state_init lkyolo "$parsed" "" >/dev/null
    phase_launch_ready lkyolo >/dev/null
    cp "$td/kicks" "$td/kicks-yolo"
  ); rc=$?
  if [ "$rc" -ne 0 ]; then rm -rf "$td"; return "$rc"; fi
  park_kick="$(cat "$td/kicks-park")" || { rm -rf "$td"; return 1; }
  yolo_kick="$(cat "$td/kicks-yolo")" || { rm -rf "$td"; return 1; }
  rm -rf "$td"
  # park kicks task 781 with the default (planification, no 2nd arg -> our stub records PLANIFICATION);
  # yolo kicks task 781 with agentType=yolo.
  [ "$park_kick" = "781|PLANIFICATION" ] && [ "$yolo_kick" = "781|yolo" ]
}

test_create_brief_falls_back_to_title() {
  local td payload title desc rc
  td="$(mktemp -d)" || return $?
  (
    set -- __source_only
    . "$HERE/../scripts/bottega-api.sh" >/dev/null 2>/dev/null
    export PHASE_DIR="$td/phases"
    api() { printf '%s' "$3" > "$td/payload"; printf '{"task":{"id":778}}'; }
    _test_kickoff_noop() { :; }
    PHASE_KICKOFF_FN=_test_kickoff_noop
    parsed="$(jq -n '{phase:"x",project:1,advance:"park",tasks:{t1:{key:"t1",title:"Title One",after:[]}}}')"
    phase_state_init cf "$parsed" "" >/dev/null
    phase_launch_ready cf >/dev/null
  ); rc=$?
  if [ "$rc" -ne 0 ]; then rm -rf "$td"; return "$rc"; fi
  payload="$(cat "$td/payload")" || { rm -rf "$td"; return 1; }
  title="$(printf '%s' "$payload" | jq -r .title)" || { rm -rf "$td"; return 1; }
  desc="$(printf '%s' "$payload" | jq -r .description)" || { rm -rf "$td"; return 1; }
  rm -rf "$td"
  [ "$title" = "Title One" ] && [ "$desc" = "Title One" ] && [ "$desc" != "t1" ] && [ -n "$desc" ]
}


setup_green_gate() {
  _t_branch(){ echo b; }; export -f _t_branch; export PHASE_PR_BRANCH_FN=_t_branch
  _t_meta(){ echo "pass MERGEABLE 0"; }; export -f _t_meta; export PHASE_PR_META_FN=_t_meta
  _t_sb(){ echo ""; }; export -f _t_sb; export PHASE_STALE_BASE_FN=_t_sb
  _t_cg(){ return 0; }; export -f _t_cg; export PHASE_CONTAINER_GATE_FN=_t_cg
  _t_bh(){ echo "CLEAN"; }; export -f _t_bh; export PHASE_PR_BEHIND_FN=_t_bh
}

assert_pr_advance_mode() {
  local mode="$1" slug="adv_${1}" expect_merge="$2"
  phase_state_init "$slug" "$(printf '%s' "$J" | jq --arg a "$mode" '.advance=$a')" "" >/dev/null
  phase_task_set "$slug" schema '.taskId=90 | .state="pr_open" | .pr=390'
  rm -f "$PHASE_DIR/merge-$mode"
  _t_merge_policy(){ echo "$1" > "$PHASE_DIR/merge-$mode"; return 0; }; export -f _t_merge_policy; export PHASE_MERGE_FN=_t_merge_policy
  phase_advance_prs "$slug" || true
  if [ "$expect_merge" = "yes" ]; then
    [ "$(phase_state_read "$slug" | jq -r .tasks.schema.state)" = "merged" ] && [ "$(cat "$PHASE_DIR/merge-$mode")" = "90" ]
  else
    [ "$(phase_state_read "$slug" | jq -r .tasks.schema.state)" = "pr_open" ] && [ "$(phase_state_read "$slug" | jq -r .tasks.schema.reason)" = "awaiting-merge" ] && [ ! -f "$PHASE_DIR/merge-$mode" ]
  fi
}

# Task 1: parse
J="$(phase_parse "$HERE/fixtures/phase-sample.yaml")"
check "parse: phase name"      '[ "$(echo "$J" | jq -r .phase)" = "Add rate limiting" ]'
check "parse: project id"      '[ "$(echo "$J" | jq -r .project)" = "1" ]'
check "parse: advance sample is park" '[ "$(echo "$J" | jq -r .advance)" = "park" ]'
check "parse: 3 tasks"         '[ "$(echo "$J" | jq -r ".tasks | length")" = "3" ]'
check "parse: middleware after schema" '[ "$(echo "$J" | jq -r ".tasks.middleware.after[0]")" = "schema" ]'
check "parse: schema after empty"      '[ "$(echo "$J" | jq -r ".tasks.schema.after | length")" = "0" ]'

J_EMPTY="$(phase_parse "$HERE/fixtures/phase-empty.yaml")"
check "parse: tasks-less YAML yields empty tasks map" '[ "$(echo "$J_EMPTY" | jq -r ".tasks | length")" = "0" ]'
check "parse: advance defaults to park" '[ "$(echo "$J_EMPTY" | jq -r .advance)" = "park" ]'

PARSE_TMP="$(mktemp -d)"
printf '%s\n' 'phase: "Legacy auto"' 'project: 1' 'autonomous: true' 'tasks: []' > "$PARSE_TMP/legacy-auto.yaml"
J_LEGACY_AUTO="$(phase_parse "$PARSE_TMP/legacy-auto.yaml")"
check "parse: legacy autonomous true maps to auto" '[ "$(echo "$J_LEGACY_AUTO" | jq -r .advance)" = "auto" ]'
printf '%s\n' 'phase: "Explicit yolo"' 'project: 1' 'autonomous: true' 'advance: yolo' 'tasks: []' > "$PARSE_TMP/explicit-yolo.yaml"
J_EXPLICIT_YOLO="$(phase_parse "$PARSE_TMP/explicit-yolo.yaml")"
check "parse: explicit advance wins" '[ "$(echo "$J_EXPLICIT_YOLO" | jq -r .advance)" = "yolo" ]'
printf '%s\n' 'phase: "Invalid advance"' 'project: 1' 'advance: bogus' 'tasks: []' > "$PARSE_TMP/invalid-advance.yaml"
phase_parse "$PARSE_TMP/invalid-advance.yaml" >/dev/null 2>&1; badadv_rc=$?
check "parse: invalid advance exits 5" '[ "$badadv_rc" = "5" ]'
rm -rf "$PARSE_TMP"

phase_parse "$HERE/fixtures/does-not-exist.yaml" >/dev/null 2>&1
missing_rc=$?
check "parse: missing file exits 2" '[ "$missing_rc" = "2" ]'

# negative: invalid (non-identifier) task key -> exit 4
phase_parse "$HERE/fixtures/phase-badkey.yaml" >/dev/null 2>&1; badkey_rc=$?
check "parse: invalid task key exits 4" '[ "$badkey_rc" = "4" ]'

# negative: empty-string task key must ALSO be rejected (was a false-negative) -> exit 4
phase_parse "$HERE/fixtures/phase-emptykey.yaml" >/dev/null 2>&1; emptykey_rc=$?
check "parse: empty-string task key exits 4" '[ "$emptykey_rc" = "4" ]'

# positive: hyphen+underscore key is valid
OK="$(phase_parse "$HERE/fixtures/phase-okkey.yaml")"; okkey_rc=$?
check "parse: hyphen_underscore key valid (exit 0)" '[ "$okkey_rc" = "0" ]'
check "parse: hyphen_underscore key present"        '[ "$(echo "$OK" | jq -r ".tasks[\"my_task-1\"].title")" = "ok key" ]'

# Task 2: state
export PHASE_DIR="$(mktemp -d)"
SP="$(phase_state_init teststate "$J" "cron-123")"
check "state: file created"        '[ -f "$SP" ]'
check "state: scheduleId stored"   '[ "$(phase_state_read teststate | jq -r .scheduleId)" = "cron-123" ]'
check "state: all tasks pending"   '[ "$(phase_state_read teststate | jq -r "[.tasks[].state]|unique|.[0]")" = "pending" ]'
check "state_init: title survives" '[ "$(phase_state_read teststate | jq -r .tasks.schema.title)" = "Add rate_limit columns + migration" ]'
check "state_init: brief survives" '[ "$(phase_state_read teststate | jq -r .tasks.schema.brief)" = "Add columns" ]'
phase_task_set teststate schema '.taskId=6 | .state="created"'
check "state: task mutate sticks"  '[ "$(phase_state_read teststate | jq -r .tasks.schema.taskId)" = "6" ]'
phase_log teststate "hello"
check "state: log appends"         '[ "$(phase_state_read teststate | jq -r ".log | length")" = "1" ]'
# idempotency: re-init must not clobber a running phase if guarded by caller — here just confirm write is atomic
check "state: write atomic (valid json)" 'phase_state_read teststate | jq -e . >/dev/null'
rm -rf "$PHASE_DIR"; unset PHASE_DIR

# Task 2 hardening: missing-slug must NOT fabricate state; slug guard; tmp cleanup
export PHASE_DIR="$(mktemp -d)"
# missing slug → task_set fails non-zero AND creates no file
( phase_task_set ghost schema '.state="x"' ) ; gc=$?
check "state: missing-slug task_set fails non-zero" '[ "'"$gc"'" -ne 0 ]'
check "state: missing-slug creates no file"         '[ ! -e "$PHASE_DIR/ghost.json" ]'
# missing slug → log fails non-zero AND creates no file
( phase_log ghost2 "x" ) ; gc=$?
check "state: missing-slug log fails non-zero"      '[ "'"$gc"'" -ne 0 ]'
check "state: missing-slug log creates no file"     '[ ! -e "$PHASE_DIR/ghost2.json" ]'
# empty/null write refused
( phase_state_write demo3 "" ) ; gc=$?
check "state: empty write refused (rc!=0)"          '[ "'"$gc"'" -ne 0 ]'
( phase_state_write demo3 "null" ) ; gc=$?
check "state: null write refused (rc!=0)"           '[ "'"$gc"'" -ne 0 ]'
# slug guard: path-traversal slug rejected, nothing escapes
( phase_state_init "../evil" "$J" sid ) ; gc=$?
check "state: traversal slug rejected (rc!=0)"      '[ "'"$gc"'" -ne 0 ]'
check "state: traversal slug wrote nothing outside" '[ ! -e "$(dirname "$PHASE_DIR")/evil.json" ]'
# tmp-leak: a jq-error write leaves no orphaned tmp
phase_state_init leak "$J" sid >/dev/null
( phase_state_write leak "NOT JSON" ) ; gc=$?
check "state: bad-json write fails (rc!=0)"          '[ "'"$gc"'" -ne 0 ]'
check "state: bad-json write leaves no tmp"          '[ "$(ls -1 "$PHASE_DIR"/leak.json.* 2>/dev/null | wc -l)" = "0" ]'
check "state: bad-json write kept original intact"   'phase_state_read leak | jq -e . >/dev/null'
check "create: brief reaches description" 'test_create_brief_reaches_description'
check "create: brief falls back to title when absent" 'test_create_brief_falls_back_to_title'
check "create yolo: create_task sends yolo_mode by advance" 'test_create_yolo_payload'
check "launch yolo: kicks agentType=yolo (not planification, not nothing)" 'test_launch_kicks_yolo_agent'
rm -rf "$PHASE_DIR"; unset PHASE_DIR


# Task 3: reconcile (stub the Bottega lookups) — pure over injected status fn
export PHASE_DIR="$(mktemp -d)"
phase_state_init recon "$J" "" >/dev/null
phase_task_set recon schema     '.taskId=6 | .state="running"'
phase_task_set recon middleware '.taskId=7 | .state="running"'
phase_task_set recon docs       '.taskId=8 | .state="running"'
phase_task_set recon yolo_pr    '.taskId=10 | .state="running"'
_phase_task_status_live() {
  case "$1" in
    6) echo '{"pr_agent_complete":1,"pr_number":231,"workflow_blocked":0}';;
    7) echo '{"pr_agent_complete":0,"workflow_blocked":1}';;
    8) echo '{"pr_agent_complete":false,"workflow_blocked":false}';;   # still running, neither flag
    10) echo '{"pr_agent_complete":1,"workflow_blocked":0}';;          # real yolo shape: PR endpoint has number, task object does not
  esac
}
_phase_pr_number_from_endpoint() { [ "$1" = "10" ] && echo 256; }
export -f _phase_task_status_live _phase_pr_number_from_endpoint
export PHASE_PR_NUMBER_FN=_phase_pr_number_from_endpoint
phase_reconcile recon
check "reconcile: schema -> pr_open"            '[ "$(phase_state_read recon | jq -r .tasks.schema.state)" = "pr_open" ]'
check "reconcile: schema pr=231"                '[ "$(phase_state_read recon | jq -r .tasks.schema.pr)" = "231" ]'
check "reconcile: yolo PR number from endpoint" '[ "$(phase_state_read recon | jq -r .tasks.yolo_pr.pr)" = "256" ]'
check "reconcile: middleware parked (blocked)"  '[ "$(phase_state_read recon | jq -r .tasks.middleware.state)" = "parked" ]'
check "reconcile: middleware reason set"        '[ "$(phase_state_read recon | jq -r .tasks.middleware.reason)" = "workflow_blocked" ]'
check "reconcile: docs stays running"           '[ "$(phase_state_read recon | jq -r .tasks.docs.state)" = "running" ]'
unset PHASE_PR_NUMBER_FN
# Idempotency: a 2nd reconcile must NOT change anything (pr_open/parked are in the skip set; docs unchanged because still no flags)
B1="$(phase_state_read recon | jq -S .)"
phase_reconcile recon
B2="$(phase_state_read recon | jq -S .)"
B1_MD5="$(printf '%s' "$B1" | md5sum | awk '{print $1}')"
B2_MD5="$(printf '%s' "$B2" | md5sum | awk '{print $1}')"
check "reconcile: idempotent (2nd run no-op)"   '[ "$B1_MD5" = "$B2_MD5" ]'
# Robustness: boolean-true blocked also parks (not just numeric 1)
phase_task_set recon docs '.state="running"'   # reset docs to running
_phase_task_status_live() { case "$1" in 8) echo '{"workflow_blocked":true,"pr_agent_complete":false}';; *) echo '{}';; esac; }
export -f _phase_task_status_live
phase_reconcile recon
check "reconcile: boolean-true blocked parks"   '[ "$(phase_state_read recon | jq -r .tasks.docs.state)" = "parked" ]'
# Missing-slug reconcile aborts cleanly (Lesson C) — no crash, non-zero, no fabrication
( phase_reconcile nonexistent_slug ) ; rc=$?
check "reconcile: missing slug non-zero"        '[ "$rc" -ne 0 ]'
check "reconcile: missing slug no file made"    '[ ! -e "$PHASE_DIR/nonexistent_slug.json" ]'
# Hostile pr_number must be rejected to null (not injected), task still opens
phase_task_set recon docs '.state="running"'
_phase_task_status_live() { case "$1" in 8) echo '{"pr_agent_complete":1,"pr_number":"5\n6; DROP","workflow_blocked":0}';; *) echo '{}';; esac; }
export -f _phase_task_status_live
phase_reconcile recon
check "reconcile: hostile pr_number -> null"    '[ "$(phase_state_read recon | jq -r .tasks.docs.pr)" = "null" ]'
check "reconcile: hostile pr_number still pr_open" '[ "$(phase_state_read recon | jq -r .tasks.docs.state)" = "pr_open" ]'
check "reconcile: state valid after hostile pr" 'phase_state_read recon | jq -e . >/dev/null'
# Corrupt .tasks must fail non-zero, instead of silently no-oping via process substitution
CORRUPT_DIR="$(mktemp -d)"
printf '%s' '{"phase":"x","project":1,"advance":"park","scheduleId":"","tasks":null,"log":[]}' > "$CORRUPT_DIR/corrupt.json"
( PHASE_DIR="$CORRUPT_DIR" phase_reconcile corrupt ) 2>/dev/null ; rc=$?
check "reconcile: corrupt .tasks fails non-zero" '[ "'"$rc"'" -ne 0 ]'
rm -rf "$CORRUPT_DIR"
rm -rf "$PHASE_DIR"; unset PHASE_DIR


# Reconcile plan -> implementation seam by advance policy.
export PHASE_DIR="$(mktemp -d)"
_t_plan_done_status() { echo '{"planification_complete":1,"workflow_complete":0,"pr_agent_complete":0,"workflow_blocked":0}'; }; export -f _t_plan_done_status; export PHASE_TASK_STATUS_FN=_t_plan_done_status
_t_kick_capture() { printf '%s %s\n' "$1" "${2:-}" >> "$PHASE_DIR/kicks"; }; export -f _t_kick_capture; export PHASE_KICKOFF_FN=_t_kick_capture
phase_state_init implauto "$(printf '%s' "$J" | jq '.advance="auto"')" "" >/dev/null
phase_task_set implauto schema '.taskId=77 | .state="running"'
phase_reconcile implauto
check "reconcile auto: planification_complete kicks implementation" '[ "$(cat "$PHASE_DIR/kicks")" = "77 implementation" ]'
rm -f "$PHASE_DIR/kicks"
phase_state_init implpark "$(printf '%s' "$J" | jq '.advance="park"')" "" >/dev/null
phase_task_set implpark schema '.taskId=78 | .state="running"'
phase_reconcile implpark
check "reconcile park: planification_complete does NOT kick" '[ ! -f "$PHASE_DIR/kicks" ]'
check "reconcile park: awaiting-plan-review marker" '[ "$(phase_state_read implpark | jq -r .tasks.schema.reason)" = "awaiting-plan-review" ]'
phase_state_init implonce "$(printf '%s' "$J" | jq '.advance="auto"')" "" >/dev/null
phase_task_set implonce schema '.taskId=79 | .state="running"'
phase_reconcile implonce
phase_reconcile implonce
check "reconcile auto: does not double-kick" '[ "$(wc -l < "$PHASE_DIR/kicks")" = "1" ]'
check "reconcile auto: impl-kicked marker" '[ "$(phase_state_read implonce | jq -r .tasks.schema.reason)" = "impl-kicked" ]'
rm -rf "$PHASE_DIR"; unset PHASE_DIR PHASE_TASK_STATUS_FN PHASE_KICKOFF_FN

# Task 4: gate — exercise each rejection + the pass
export PHASE_DIR="$(mktemp -d)"
phase_state_init g "$J" "" >/dev/null
phase_task_set g schema '.taskId=6 | .state="pr_open" | .pr=231'
export PHASE_PR_BRANCH_FN=_t_branch;      _t_branch() { echo "feat/schema"; }; export -f _t_branch
export PHASE_PR_META_FN=_t_meta_ok;       _t_meta_ok() { echo "pass MERGEABLE 0"; }; export -f _t_meta_ok
export PHASE_STALE_BASE_FN=_t_stale_no;   _t_stale_no() { echo ""; }; export -f _t_stale_no
export PHASE_CONTAINER_GATE_FN=_t_gate_ok; _t_gate_ok() { return 0; }; export -f _t_gate_ok
export PHASE_PR_BEHIND_FN=_t_behind_clean; _t_behind_clean() { echo "CLEAN"; }; export -f _t_behind_clean
check "gate: all green -> pass"           '[ "$(phase_gate g schema)" = "pass" ]'
export PHASE_PR_META_FN=_t_meta_cired;    _t_meta_cired() { echo "fail MERGEABLE 0"; }; export -f _t_meta_cired
check "gate: CI red -> park"              '[[ "$(phase_gate g schema)" == park:ci-* ]]'
export PHASE_PR_META_FN=_t_meta_conf;     _t_meta_conf() { echo "pass CONFLICTING 0"; }; export -f _t_meta_conf
check "gate: conflict -> park"            '[[ "$(phase_gate g schema)" == park:not-mergeable* ]]'
export PHASE_PR_META_FN=_t_meta_blocked;  _t_meta_blocked() { echo "pass MERGEABLE 1"; }; export -f _t_meta_blocked
check "gate: workflow_blocked -> park"    '[ "$(phase_gate g schema)" = "park:workflow_blocked" ]'
export PHASE_PR_META_FN=_t_meta_ok
export PHASE_STALE_BASE_FN=_t_stale_yes;  _t_stale_yes() { printf "server/src/x.ts\n"; }; export -f _t_stale_yes
check "gate: stale-base overlap -> park"  '[[ "$(phase_gate g schema)" == park:stale-base-overlap* ]]'
export PHASE_STALE_BASE_FN=_t_stale_no
export PHASE_CONTAINER_GATE_FN=_t_gate_red; _t_gate_red() { return 1; }; export -f _t_gate_red
check "gate: container gate red -> park"  '[ "$(phase_gate g schema)" = "park:gate-red" ]'

# fail-closed: a check that CANNOT RUN must park, never proceed as pass
export PHASE_CONTAINER_GATE_FN=_t_gate_ok
# stale-base helper ERRORS (container down) -> must park, NOT treat empty as "no overlap"
export PHASE_STALE_BASE_FN=_t_stale_err; _t_stale_err() { echo "incus down" >&2; return 1; }; export -f _t_stale_err
check "gate: stale-base CANT RUN -> park (fail closed)" '[ "$(phase_gate g schema)" = "park:stale-base-check-failed" ]'
export PHASE_STALE_BASE_FN=_t_stale_no
# meta helper ERRORS -> park
export PHASE_PR_META_FN=_t_meta_err; _t_meta_err() { echo "gh down" >&2; return 1; }; export -f _t_meta_err
check "gate: meta CANT RUN -> park (fail closed)" '[ "$(phase_gate g schema)" = "park:meta-check-failed" ]'
export PHASE_PR_META_FN=_t_meta_ok
# branch resolve ERRORS -> park
export PHASE_PR_BRANCH_FN=_t_branch_err; _t_branch_err() { return 1; }; export -f _t_branch_err
check "gate: branch resolve CANT RUN -> park (fail closed)" '[ "$(phase_gate g schema)" = "park:branch-resolve-failed" ]'
export PHASE_PR_BRANCH_FN=_t_branch
# meta malformed (2 fields) -> park
export PHASE_PR_META_FN=_t_meta_malf; _t_meta_malf() { echo "pass MERGEABLE"; }; export -f _t_meta_malf
check "gate: meta malformed -> park (fail closed)" '[ "$(phase_gate g schema)" = "park:meta-malformed" ]'
export PHASE_PR_META_FN=_t_meta_ok
# no-pr task -> retry:no-pr (bounded backoff), then park:no-pr-timeout at the cap
phase_task_set g docs '.taskId=9 | .state="running" | .pr=null'
check "gate: no PR -> retry:no-pr (first tick)" '[ "$(phase_gate g docs)" = "retry:no-pr" ]'
phase_task_set g docs '.nopr_attempts=3'
check "gate: no PR at cap -> park:no-pr-timeout" '[ "$(phase_gate g docs)" = "park:no-pr-timeout" ]'
# Regression teeth: gate resolvers are task-id-first; PR remains only the existence sentinel.
phase_task_set g schema '.taskId=42 | .state="pr_open" | .pr=242'
export PHASE_PR_BRANCH_FN=_t_capture_branch_arg; _t_capture_branch_arg() { echo "$1" > "$PHASE_DIR/branch-arg"; echo feat/x; }; export -f _t_capture_branch_arg
export PHASE_PR_META_FN=_t_meta_ok; export PHASE_STALE_BASE_FN=_t_stale_no; export PHASE_CONTAINER_GATE_FN=_t_gate_ok
phase_gate g schema >/dev/null || true
check "gate: branch resolver receives task id" '[ "$(cat "$PHASE_DIR/branch-arg")" = "42" ]'
check "gate: branch resolver did not receive PR number" '[ "$(cat "$PHASE_DIR/branch-arg")" != "242" ]'
export PHASE_PR_BRANCH_FN=_t_branch
export PHASE_PR_META_FN=_t_capture_meta_arg; _t_capture_meta_arg() { echo "$1" > "$PHASE_DIR/meta-arg"; echo "pass MERGEABLE 0"; }; export -f _t_capture_meta_arg
phase_gate g schema >/dev/null || true
check "gate: meta resolver receives task id" '[ "$(cat "$PHASE_DIR/meta-arg")" = "42" ]'
check "gate: meta resolver did not receive PR number" '[ "$(cat "$PHASE_DIR/meta-arg")" != "242" ]'
export PHASE_PR_META_FN=_t_meta_ok

# Task 4 hardening: hostile branch names and strict meta parsing must fail closed.
export PHASE_PR_META_FN=_t_meta_ok; export PHASE_STALE_BASE_FN=_t_stale_no; export PHASE_CONTAINER_GATE_FN=_t_gate_ok
export PHASE_PR_BRANCH_FN=_t_br_evil; _t_br_evil() { echo 'x"; touch /tmp/pwn_$$; echo "'; }; export -f _t_br_evil
check "gate: injection branch name -> park" '[ "$(phase_gate g schema)" = "park:bad-branch-name" ]'
export PHASE_PR_BRANCH_FN=_t_br_cmdsub; _t_br_cmdsub() { echo 'main$(touch /tmp/pwn2)'; }; export -f _t_br_cmdsub
check "gate: cmd-sub branch name -> park" '[ "$(phase_gate g schema)" = "park:bad-branch-name" ]'
export PHASE_PR_BRANCH_FN=_t_br_dash; _t_br_dash() { echo '-rf'; }; export -f _t_br_dash
check "gate: leading-dash branch -> park" '[ "$(phase_gate g schema)" = "park:bad-branch-name" ]'
export PHASE_PR_BRANCH_FN=_t_branch

export PHASE_PR_META_FN=_t_meta_extra; _t_meta_extra() { echo "pass MERGEABLE 1 extra"; }; export -f _t_meta_extra
check "gate: meta extra token -> park (not pass)" '[ "$(phase_gate g schema)" = "park:meta-malformed" ]'
export PHASE_PR_META_FN=_t_meta_cr; _t_meta_cr() { printf 'pass MERGEABLE 1\r\n'; }; export -f _t_meta_cr
check "gate: meta trailing CR -> park (not pass)" '[ "$(phase_gate g schema)" = "park:meta-malformed" ]'
export PHASE_PR_META_FN=_t_meta_ok
# F4: gate keys are phase_parse-constrained (^[a-z0-9_-]+$); --arg k is defense-in-depth.
# A raw-interpolation regression is caught by code review, not this harness.
rm -f /tmp/pwn_* /tmp/pwn2
rm -rf "$PHASE_DIR"; unset PHASE_DIR PHASE_PR_BRANCH_FN PHASE_PR_META_FN PHASE_STALE_BASE_FN PHASE_CONTAINER_GATE_FN


# Task 5: full tick over stubs (auto run)
export PHASE_DIR="$(mktemp -d)"
phase_state_init t "$(printf '%s' "$J" | jq '.advance="auto"')" "" >/dev/null
ID=10; _t_create() { echo $((ID++)); }; export -f _t_create; export PHASE_CREATE_FN=_t_create ID
_t_kick() { :; }; export -f _t_kick; export PHASE_KICKOFF_FN=_t_kick
phase_tick_once t || true
check "tick1: schema running"  '[ "$(phase_state_read t | jq -r .tasks.schema.state)" = "running" ]'
check "tick1: middleware still pending (dep unmet)" '[ "$(phase_state_read t | jq -r .tasks.middleware.state)" = "pending" ]'
phase_task_set t schema '.pr=231'
_phase_task_status_live() { echo '{"pr_agent_complete":1,"pr_number":231,"workflow_blocked":0}'; }; export -f _phase_task_status_live
_t_branch(){ echo b; }; export -f _t_branch; export PHASE_PR_BRANCH_FN=_t_branch
_t_meta(){ echo "pass MERGEABLE 0"; }; export -f _t_meta; export PHASE_PR_META_FN=_t_meta
_t_sb(){ echo ""; }; export -f _t_sb; export PHASE_STALE_BASE_FN=_t_sb
_t_cg(){ return 0; }; export -f _t_cg; export PHASE_CONTAINER_GATE_FN=_t_cg
_t_merge(){ return 0; }; export -f _t_merge; export PHASE_MERGE_FN=_t_merge
phase_tick_once t || true
check "tick2: schema merged"   '[ "$(phase_state_read t | jq -r .tasks.schema.state)" = "merged" ]'
check "tick2: middleware launched (dep met)" '[ "$(phase_state_read t | jq -r .tasks.middleware.state)" = "running" ]'
check "tick2: docs launched too (parallel)"  '[ "$(phase_state_read t | jq -r .tasks.docs.state)" = "running" ]'
B="$(phase_state_read t)"; phase_tick_once t || true
check "tick3: idempotent (no churn on merged schema)" '[ "$(phase_state_read t | jq -r .tasks.schema.taskId)" = "$(echo "$B" | jq -r .tasks.schema.taskId)" ]'
# Task 5: injection-safety — a park VERDICT carrying jq-breakout chars must NOT flip state; reason stored literally
unset PHASE_MERGE_FN; _t_meta_conf(){ echo "pass CONFLICTING 0"; }; export -f _t_meta_conf; export PHASE_PR_META_FN=_t_meta_conf
phase_state_init z "$(printf '%s' "$J" | jq '.advance="auto"')" "" >/dev/null
phase_task_set z schema '.taskId=9 | .state="pr_open" | .pr=231'
phase_advance_prs z || true
check "inj: conflict parks (not merged)" '[ "$(phase_state_read z | jq -r .tasks.schema.state)" = "parked" ]'
check "inj: reason is the literal verdict" '[ "$(phase_state_read z | jq -r .tasks.schema.reason)" = "park:not-mergeable(CONFLICTING)" ]'
# Direct jq-injection probe on phase_task_set_str: a value with quotes/jq-meta is stored as DATA, never executed
phase_task_set_str z schema reason 'x" | .tasks.schema.state="merged" | .reason="x'
check "inj: malicious reason stored literally" '[ "$(phase_state_read z | jq -r .tasks.schema.reason)" = "x\" | .tasks.schema.state=\"merged\" | .reason=\"x" ]'
check "inj: malicious reason did NOT flip state to merged" '[ "$(phase_state_read z | jq -r .tasks.schema.state)" = "parked" ]'
# Task 5: chatty container-gate stdout is reduced to the operative last-line verdict before auto merge/park.
phase_state_init cgpass "$(printf '%s' "$J" | jq '.advance="auto"')" "" >/dev/null
phase_task_set cgpass schema '.taskId=9 | .state="pr_open" | .pr=231'
_t_cg_chatty_ok(){ echo "=== gate: typecheck ==="; echo "=== gate: PASSED ==="; return 0; }; export -f _t_cg_chatty_ok; export PHASE_CONTAINER_GATE_FN=_t_cg_chatty_ok
_t_merge_mark(){ : > "$PHASE_DIR/chatty-merge-fired"; return 0; }; export -f _t_merge_mark; export PHASE_MERGE_FN=_t_merge_mark
export PHASE_PR_META_FN=_t_meta
phase_advance_prs cgpass || true
check "tick: chatty passing gate merges" '[ "$(phase_state_read cgpass | jq -r .tasks.schema.state)" = "merged" ]'
check "tick: chatty passing gate fired merge fn" '[ -f "$PHASE_DIR/chatty-merge-fired" ]'
phase_state_init cgpark "$(printf '%s' "$J" | jq '.advance="auto"')" "" >/dev/null
phase_task_set cgpark schema '.taskId=9 | .state="pr_open" | .pr=231'
_t_cg_chatty_red(){ echo "=== gate: typecheck ==="; echo "=== gate: FAILED ==="; return 1; }; export -f _t_cg_chatty_red; export PHASE_CONTAINER_GATE_FN=_t_cg_chatty_red
rm -f "$PHASE_DIR/chatty-merge-fired"
phase_advance_prs cgpark || true
check "tick: chatty failing gate parks" '[ "$(phase_state_read cgpark | jq -r .tasks.schema.state)" = "parked" ]'
check "tick: chatty failing gate reason is clean token" '[ "$(phase_state_read cgpark | jq -r .tasks.schema.reason)" = "park:gate-red" ]'
check "tick: chatty failing gate did not fire merge fn" '[ ! -f "$PHASE_DIR/chatty-merge-fired" ]'
# Task 5: default/default park mode never merges, even with a chatty green gate and merge function available.
phase_state_init na "$(printf '%s' "$J" | jq '.advance="park"')" "" >/dev/null
phase_task_set na schema '.taskId=9 | .state="pr_open" | .pr=231'
export PHASE_PR_META_FN=_t_meta; export PHASE_CONTAINER_GATE_FN=_t_cg_chatty_ok; export PHASE_MERGE_FN=_t_merge_mark
rm -f "$PHASE_DIR/chatty-merge-fired"
phase_advance_prs na || true
check "tick: park leaves pr_open (no merge)" '[ "$(phase_state_read na | jq -r .tasks.schema.state)" = "pr_open" ]'
check "tick: park did not fire merge fn" '[ ! -f "$PHASE_DIR/chatty-merge-fired" ]'

# Explicit advance-policy teeth for the gate -> merge seam.
setup_green_gate
check "advance=park: gate pass does NOT merge" 'assert_pr_advance_mode park no'
check "advance=auto: gate pass merges" 'assert_pr_advance_mode auto yes'
check "advance=yolo: gate pass merges" 'assert_pr_advance_mode yolo yes'
# A gate helper can emit a park verdict with rc=1; advance_prs must still record it fail-closed instead of aborting.
phase_state_init grc "$(printf '%s' "$J" | jq '.advance="auto"')" "" >/dev/null
phase_task_set grc schema '.taskId=9 | .state="pr_open" | .pr=231'
( phase_gate() { echo "park:synthetic-failed"; return 1; }
  phase_advance_prs grc || true )
check "tick: gate rc1 still parks" '[ "$(phase_state_read grc | jq -r .tasks.schema.state)" = "parked" ]'
check "tick: gate rc1 reason preserved" '[ "$(phase_state_read grc | jq -r .tasks.schema.reason)" = "park:synthetic-failed" ]'
rm -rf "$PHASE_DIR"; unset PHASE_DIR PHASE_CREATE_FN PHASE_KICKOFF_FN PHASE_PR_BRANCH_FN PHASE_PR_META_FN PHASE_STALE_BASE_FN PHASE_CONTAINER_GATE_FN PHASE_MERGE_FN ID

# Task 5: F3 regression lock — real _phase_stale_base_live body must fail-closed on git errors.
# F3 teeth: pin the SPECIFIC exit code of each rc-guard so deleting an individual `|| exit N` flips the test.
f3_branch_rc="$( ( incus() { local p="${*: -1}"; git() { case "$*" in
      "fetch origin --quiet") return 0;;
      "merge-base origin/main origin/somebranch") echo abc;;
      "diff --name-only abc origin/somebranch") echo "fatal: bad object" >&2; return 128;; # branch-diff fails -> || exit 4
      "diff --name-only abc origin/main") echo file.ts;;
      *) echo "unexpected git $*" >&2; return 99;; esac; }; export -f git
    mkdir -p "$HOME/projects/ytsejam"  # _phase_stale_base_live cd target inside the fake container
    bash -c "$p"; }; export -f incus
    _phase_stale_base_live somebranch >/dev/null 2>&1; echo "$?" ) )"
check "stale-base live branch-diff failure -> exit 4 (rc-guard pinned)" '[ "$f3_branch_rc" = "4" ]'
f3_merge_base_rc="$( ( incus() { local p="${*: -1}"; git() { case "$*" in
      "fetch origin --quiet") return 0;;
      "merge-base origin/main origin/somebranch") echo "fatal: no merge base" >&2; return 128;; # merge-base fails -> || exit 3
      *) echo "unexpected git $*" >&2; return 99;; esac; }; export -f git
    mkdir -p "$HOME/projects/ytsejam"  # _phase_stale_base_live cd target inside the fake container
    bash -c "$p"; }; export -f incus
    _phase_stale_base_live somebranch >/dev/null 2>&1; echo "$?" ) )"
check "stale-base live merge-base failure -> exit 3 (rc-guard pinned)" '[ "$f3_merge_base_rc" = "3" ]'


# Task 6: PR-number sink guard — even after an all-green gate, merge receives numeric PRs only.
export PHASE_DIR="$(mktemp -d)"
phase_state_init sink "$(printf '%s' "$J" | jq '.advance="auto"')" "" >/dev/null
phase_task_set sink schema '.taskId=9 | .state="pr_open" | .pr="abc"'
_t_branch_num(){ echo b; }; export -f _t_branch_num; export PHASE_PR_BRANCH_FN=_t_branch_num
_t_meta_num(){ echo "pass MERGEABLE 0"; }; export -f _t_meta_num; export PHASE_PR_META_FN=_t_meta_num
_t_sb_num(){ echo ""; }; export -f _t_sb_num; export PHASE_STALE_BASE_FN=_t_sb_num
_t_cg_num(){ return 0; }; export -f _t_cg_num; export PHASE_CONTAINER_GATE_FN=_t_cg_num
_t_merge_num(){ : > "$PHASE_DIR/sink-merge-fired"; return 0; }; export -f _t_merge_num; export PHASE_MERGE_FN=_t_merge_num
phase_advance_prs sink || true
check "sink: bad PR number parks" '[ "$(phase_state_read sink | jq -r .tasks.schema.state)" = "parked" ]'
check "sink: bad PR number reason" '[ "$(phase_state_read sink | jq -r .tasks.schema.reason)" = "bad-pr-number" ]'
check "sink: bad PR number did not merge" '[ ! -f "$PHASE_DIR/sink-merge-fired" ]'
phase_state_init sinkok "$(printf '%s' "$J" | jq '.advance="auto"')" "" >/dev/null
phase_task_set sinkok schema '.taskId=9 | .state="pr_open" | .pr=231'
rm -f "$PHASE_DIR/sink-merge-fired"
phase_advance_prs sinkok || true
check "sink: numeric PR merges" '[ "$(phase_state_read sinkok | jq -r .tasks.schema.state)" = "merged" ]'
check "sink: numeric PR fired merge" '[ -f "$PHASE_DIR/sink-merge-fired" ]'
# Regression teeth: auto merge calls the task-id-first Bottega merge-cleanup helper, not raw PR merge.
phase_state_init mergearg "$(printf '%s' "$J" | jq '.advance="auto"')" "" >/dev/null
phase_task_set mergearg schema '.taskId=99 | .state="pr_open" | .pr=242'
rm -f "$PHASE_DIR/merge-arg"
_t_merge_capture(){ echo "$1" > "$PHASE_DIR/merge-arg"; return 0; }; export -f _t_merge_capture; export PHASE_MERGE_FN=_t_merge_capture
phase_advance_prs mergearg || true
check "merge: merge fn receives task id" '[ "$(cat "$PHASE_DIR/merge-arg")" = "99" ]'
check "merge: merge fn did not receive PR number" '[ "$(cat "$PHASE_DIR/merge-arg")" != "242" ]'
check "api: no dead pr->task resolver" '! grep -q _phase_taskid_for_pr "$HERE/../scripts/bottega-api.sh"'
rm -rf "$PHASE_DIR"; unset PHASE_DIR PHASE_PR_BRANCH_FN PHASE_PR_META_FN PHASE_STALE_BASE_FN PHASE_CONTAINER_GATE_FN PHASE_MERGE_FN

echo "---"; [ "$fails" -eq 0 ] && echo "verify-phase: ALL PASS" || { echo "verify-phase: $fails FAILED"; exit 1; }
