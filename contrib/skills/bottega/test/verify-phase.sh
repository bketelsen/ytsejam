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

echo "---"; [ "$fails" -eq 0 ] && echo "verify-phase: ALL PASS" || { echo "verify-phase: $fails FAILED"; exit 1; }
