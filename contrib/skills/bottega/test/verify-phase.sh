#!/usr/bin/env bash
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
    parsed="$(jq -n --arg brief "BRIEF-BODY-XYZ" '{phase:"x",project:1,autonomous:false,tasks:{t1:{key:"t1",title:"Title One",brief:$brief,after:[]}}}')"
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
    parsed="$(jq -n '{phase:"x",project:1,autonomous:false,tasks:{t1:{key:"t1",title:"Title One",after:[]}}}')"
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

# Task 1: parse
J="$(phase_parse "$HERE/fixtures/phase-sample.yaml")"
check "parse: phase name"      '[ "$(echo "$J" | jq -r .phase)" = "Add rate limiting" ]'
check "parse: project id"      '[ "$(echo "$J" | jq -r .project)" = "1" ]'
check "parse: autonomous false" '[ "$(echo "$J" | jq -r .autonomous)" = "false" ]'
check "parse: 3 tasks"         '[ "$(echo "$J" | jq -r ".tasks | length")" = "3" ]'
check "parse: middleware after schema" '[ "$(echo "$J" | jq -r ".tasks.middleware.after[0]")" = "schema" ]'
check "parse: schema after empty"      '[ "$(echo "$J" | jq -r ".tasks.schema.after | length")" = "0" ]'

J_EMPTY="$(phase_parse "$HERE/fixtures/phase-empty.yaml")"
check "parse: tasks-less YAML yields empty tasks map" '[ "$(echo "$J_EMPTY" | jq -r ".tasks | length")" = "0" ]'

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
rm -rf "$PHASE_DIR"; unset PHASE_DIR


# Task 3: reconcile (stub the Bottega lookups) — pure over injected status fn
export PHASE_DIR="$(mktemp -d)"
phase_state_init recon "$J" "" >/dev/null
phase_task_set recon schema     '.taskId=6 | .state="running"'
phase_task_set recon middleware '.taskId=7 | .state="running"'
phase_task_set recon docs       '.taskId=8 | .state="running"'
_phase_task_status_live() {
  case "$1" in
    6) echo '{"pr_agent_complete":1,"pr_number":231,"workflow_blocked":0}';;
    7) echo '{"pr_agent_complete":0,"workflow_blocked":1}';;
    8) echo '{"pr_agent_complete":false,"workflow_blocked":false}';;   # still running, neither flag
  esac
}
export -f _phase_task_status_live
phase_reconcile recon
check "reconcile: schema -> pr_open"            '[ "$(phase_state_read recon | jq -r .tasks.schema.state)" = "pr_open" ]'
check "reconcile: schema pr=231"                '[ "$(phase_state_read recon | jq -r .tasks.schema.pr)" = "231" ]'
check "reconcile: middleware parked (blocked)"  '[ "$(phase_state_read recon | jq -r .tasks.middleware.state)" = "parked" ]'
check "reconcile: middleware reason set"        '[ "$(phase_state_read recon | jq -r .tasks.middleware.reason)" = "workflow_blocked" ]'
check "reconcile: docs stays running"           '[ "$(phase_state_read recon | jq -r .tasks.docs.state)" = "running" ]'
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
printf '%s' '{"phase":"x","project":1,"autonomous":false,"scheduleId":"","tasks":null,"log":[]}' > "$CORRUPT_DIR/corrupt.json"
( PHASE_DIR="$CORRUPT_DIR" phase_reconcile corrupt ) 2>/dev/null ; rc=$?
check "reconcile: corrupt .tasks fails non-zero" '[ "'"$rc"'" -ne 0 ]'
rm -rf "$CORRUPT_DIR"
rm -rf "$PHASE_DIR"; unset PHASE_DIR


# Task 4: gate — exercise each rejection + the pass
export PHASE_DIR="$(mktemp -d)"
phase_state_init g "$J" "" >/dev/null
phase_task_set g schema '.taskId=6 | .state="pr_open" | .pr=231'
export PHASE_PR_BRANCH_FN=_t_branch;      _t_branch() { echo "feat/schema"; }; export -f _t_branch
export PHASE_PR_META_FN=_t_meta_ok;       _t_meta_ok() { echo "pass MERGEABLE 0"; }; export -f _t_meta_ok
export PHASE_STALE_BASE_FN=_t_stale_no;   _t_stale_no() { echo ""; }; export -f _t_stale_no
export PHASE_CONTAINER_GATE_FN=_t_gate_ok; _t_gate_ok() { return 0; }; export -f _t_gate_ok
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
# no-pr task -> park:no-pr
phase_task_set g docs '.taskId=9 | .state="running" | .pr=null'
check "gate: no PR -> park:no-pr" '[ "$(phase_gate g docs)" = "park:no-pr" ]'

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


# Task 5: full tick over stubs (autonomous run)
export PHASE_DIR="$(mktemp -d)"
phase_state_init t "$(printf '%s' "$J" | jq '.autonomous=true')" "" >/dev/null
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
phase_state_init z "$(printf '%s' "$J" | jq '.autonomous=true')" "" >/dev/null
phase_task_set z schema '.taskId=9 | .state="pr_open" | .pr=231'
phase_advance_prs z || true
check "inj: conflict parks (not merged)" '[ "$(phase_state_read z | jq -r .tasks.schema.state)" = "parked" ]'
check "inj: reason is the literal verdict" '[ "$(phase_state_read z | jq -r .tasks.schema.reason)" = "park:not-mergeable(CONFLICTING)" ]'
# Direct jq-injection probe on phase_task_set_str: a value with quotes/jq-meta is stored as DATA, never executed
phase_task_set_str z schema reason 'x" | .tasks.schema.state="merged" | .reason="x'
check "inj: malicious reason stored literally" '[ "$(phase_state_read z | jq -r .tasks.schema.reason)" = "x\" | .tasks.schema.state=\"merged\" | .reason=\"x" ]'
check "inj: malicious reason did NOT flip state to merged" '[ "$(phase_state_read z | jq -r .tasks.schema.state)" = "parked" ]'
# Task 5: chatty container-gate stdout is reduced to the operative last-line verdict before autonomous merge/park.
phase_state_init cgpass "$(printf '%s' "$J" | jq '.autonomous=true')" "" >/dev/null
phase_task_set cgpass schema '.taskId=9 | .state="pr_open" | .pr=231'
_t_cg_chatty_ok(){ echo "=== gate: typecheck ==="; echo "=== gate: PASSED ==="; return 0; }; export -f _t_cg_chatty_ok; export PHASE_CONTAINER_GATE_FN=_t_cg_chatty_ok
_t_merge_mark(){ : > "$PHASE_DIR/chatty-merge-fired"; return 0; }; export -f _t_merge_mark; export PHASE_MERGE_FN=_t_merge_mark
export PHASE_PR_META_FN=_t_meta
phase_advance_prs cgpass || true
check "tick: chatty passing gate merges" '[ "$(phase_state_read cgpass | jq -r .tasks.schema.state)" = "merged" ]'
check "tick: chatty passing gate fired merge fn" '[ -f "$PHASE_DIR/chatty-merge-fired" ]'
phase_state_init cgpark "$(printf '%s' "$J" | jq '.autonomous=true')" "" >/dev/null
phase_task_set cgpark schema '.taskId=9 | .state="pr_open" | .pr=231'
_t_cg_chatty_red(){ echo "=== gate: typecheck ==="; echo "=== gate: FAILED ==="; return 1; }; export -f _t_cg_chatty_red; export PHASE_CONTAINER_GATE_FN=_t_cg_chatty_red
rm -f "$PHASE_DIR/chatty-merge-fired"
phase_advance_prs cgpark || true
check "tick: chatty failing gate parks" '[ "$(phase_state_read cgpark | jq -r .tasks.schema.state)" = "parked" ]'
check "tick: chatty failing gate reason is clean token" '[ "$(phase_state_read cgpark | jq -r .tasks.schema.reason)" = "park:gate-red" ]'
check "tick: chatty failing gate did not fire merge fn" '[ ! -f "$PHASE_DIR/chatty-merge-fired" ]'
# Task 5: default/non-autonomous mode never merges, even with a chatty green gate and merge function available.
phase_state_init na "$(printf '%s' "$J" | jq '.autonomous=false')" "" >/dev/null
phase_task_set na schema '.taskId=9 | .state="pr_open" | .pr=231'
export PHASE_PR_META_FN=_t_meta; export PHASE_CONTAINER_GATE_FN=_t_cg_chatty_ok; export PHASE_MERGE_FN=_t_merge_mark
rm -f "$PHASE_DIR/chatty-merge-fired"
phase_advance_prs na || true
check "tick: non-autonomous leaves pr_open (no merge)" '[ "$(phase_state_read na | jq -r .tasks.schema.state)" = "pr_open" ]'
check "tick: non-autonomous did not fire merge fn" '[ ! -f "$PHASE_DIR/chatty-merge-fired" ]'
# A gate helper can emit a park verdict with rc=1; advance_prs must still record it fail-closed instead of aborting.
phase_state_init grc "$(printf '%s' "$J" | jq '.autonomous=true')" "" >/dev/null
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
      *) echo "unexpected git $*" >&2; return 99;; esac; }; export -f git; bash -c "$p"; }; export -f incus
    _phase_stale_base_live somebranch >/dev/null 2>&1; echo "$?" ) )"
check "stale-base live branch-diff failure -> exit 4 (rc-guard pinned)" '[ "$f3_branch_rc" = "4" ]'
f3_merge_base_rc="$( ( incus() { local p="${*: -1}"; git() { case "$*" in
      "fetch origin --quiet") return 0;;
      "merge-base origin/main origin/somebranch") echo "fatal: no merge base" >&2; return 128;; # merge-base fails -> || exit 3
      *) echo "unexpected git $*" >&2; return 99;; esac; }; export -f git; bash -c "$p"; }; export -f incus
    _phase_stale_base_live somebranch >/dev/null 2>&1; echo "$?" ) )"
check "stale-base live merge-base failure -> exit 3 (rc-guard pinned)" '[ "$f3_merge_base_rc" = "3" ]'


# Task 6: PR-number sink guard — even after an all-green gate, merge receives numeric PRs only.
export PHASE_DIR="$(mktemp -d)"
phase_state_init sink "$(printf '%s' "$J" | jq '.autonomous=true')" "" >/dev/null
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
phase_state_init sinkok "$(printf '%s' "$J" | jq '.autonomous=true')" "" >/dev/null
phase_task_set sinkok schema '.taskId=9 | .state="pr_open" | .pr=231'
rm -f "$PHASE_DIR/sink-merge-fired"
phase_advance_prs sinkok || true
check "sink: numeric PR merges" '[ "$(phase_state_read sinkok | jq -r .tasks.schema.state)" = "merged" ]'
check "sink: numeric PR fired merge" '[ -f "$PHASE_DIR/sink-merge-fired" ]'
rm -rf "$PHASE_DIR"; unset PHASE_DIR PHASE_PR_BRANCH_FN PHASE_PR_META_FN PHASE_STALE_BASE_FN PHASE_CONTAINER_GATE_FN PHASE_MERGE_FN

echo "---"; [ "$fails" -eq 0 ] && echo "verify-phase: ALL PASS" || { echo "verify-phase: $fails FAILED"; exit 1; }
