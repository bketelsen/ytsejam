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

echo "---"; [ "$fails" -eq 0 ] && echo "verify-phase: ALL PASS" || { echo "verify-phase: $fails FAILED"; exit 1; }
