#!/usr/bin/env bash
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../scripts/phase-lib.sh"
fails=0
check() { if eval "$2"; then echo "  ok: $1"; else echo "  FAIL: $1"; fails=$((fails+1)); fi; }

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
rm -rf "$PHASE_DIR"; unset PHASE_DIR

echo "---"; [ "$fails" -eq 0 ] && echo "verify-phase: ALL PASS" || { echo "verify-phase: $fails FAILED"; exit 1; }
