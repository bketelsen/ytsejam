#!/usr/bin/env bash
# Regression tests for phase_gate auto-update-behind + CI bucket rollup + no-pr backoff.
# Bash-only, no external harness. Run: bash scripts/test/phase-yolo-update.test.sh
# Exits 0 on all-pass, 1 on any failure.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/../../contrib/skills/bottega/scripts/phase-lib.sh"
[[ -r "$LIB" ]] || { echo "FAIL: cannot find $LIB" >&2; exit 1; }
# shellcheck disable=SC1090
source "$LIB"

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
export PHASE_DIR="$WORK/phases"; mkdir -p "$PHASE_DIR"

pass=0; fail=0
assert_eq() { local n="$1" want="$2" got="$3"
  if [[ "$got" == "$want" ]]; then echo "PASS [$n]"; pass=$((pass+1));
  else echo "FAIL [$n]" >&2; echo "  want: [$want]" >&2; echo "  got:  [$got]" >&2; fail=$((fail+1)); fi; }

# Write a phase state with one pr_open task. Args: slug key pr extra-json
write_state() { local slug="$1" key="$2" pr="$3" extra="${4:-{\}}"
  jq -n --arg k "$key" --argjson pr "$pr" --argjson x "$extra" \
    '{advance:"yolo",tasks:{($k):({taskId:42,state:"pr_open",pr:$pr} + $x)}}' \
    > "$PHASE_DIR/$slug.json"
}

# Default benign seams (override per-case via env)
export PHASE_PR_BRANCH_FN=_t_branch;  _t_branch() { echo "task/42-x"; }
export PHASE_STALE_BASE_FN=_t_stale;  _t_stale() { echo ""; }            # no overlap
export PHASE_CONTAINER_GATE_FN=_t_gate; _t_gate() { return 0; }          # gate green
export PHASE_PR_BEHIND_FN=_t_behind;  _t_behind() { echo "${MSS:-CLEAN}"; }
export PHASE_SYNC_FN=_t_sync;  _t_sync() { echo "sync:$1" >> "$WORK/calls"; return "${SYNC_RC:-0}"; }
export PHASE_PUSH_FN=_t_push;  _t_push() { echo "push:$1" >> "$WORK/calls"; return "${PUSH_RC:-0}"; }
export PHASE_PR_META_FN=_t_meta
_t_meta() { echo "${CI:-pass} ${MERGEABLE:-MERGEABLE} 0"; }

# Case: CLEAN + pass -> pass, no sync/push, counters reset
: > "$WORK/calls"; write_state s1 t1 7
CI=pass MERGEABLE=MERGEABLE MSS=CLEAN
assert_eq "clean green -> pass" "pass" "$(phase_gate s1 t1)"
assert_eq "clean green fires no sync/push" "" "$(cat "$WORK/calls" 2>/dev/null || true)"

# Case: ci=fail -> park:ci-fail (proves the gate reads the rolled-up ci token, not past-tense status)
write_state s1 t1 7; CI=fail MSS=CLEAN
assert_eq "ci fail -> park" "park:ci-fail" "$(phase_gate s1 t1)"

# Case: BEHIND under cap -> retry:behind-updating, fires sync+push, counter=1
: > "$WORK/calls"; write_state s1 t1 7; CI=pass MSS=BEHIND
assert_eq "behind -> retry" "retry:behind-updating" "$(phase_gate s1 t1)"
assert_eq "behind fired sync+push in order" "sync:42
push:42" "$(cat "$WORK/calls")"
assert_eq "behind bumped update_attempts" "1" "$(jq -r '.tasks.t1.update_attempts' "$PHASE_DIR/s1.json")"

# Case: BEHIND at cap -> park:stuck-behind, fires neither sync nor push
: > "$WORK/calls"; write_state s1 t1 7 '{"update_attempts":3}'; CI=pass MSS=BEHIND
assert_eq "behind at cap -> stuck" "park:stuck-behind" "$(phase_gate s1 t1)"
assert_eq "stuck fires nothing" "" "$(cat "$WORK/calls" 2>/dev/null || true)"

# Case: CONFLICTING -> park:merge-conflict, fires neither
: > "$WORK/calls"; write_state s1 t1 7; CI=pass MSS=CONFLICTING
assert_eq "conflict -> park" "park:merge-conflict(CONFLICTING)" "$(phase_gate s1 t1)"
assert_eq "conflict fires nothing" "" "$(cat "$WORK/calls" 2>/dev/null || true)"

# Case: no-pr first tick -> retry:no-pr, counter=1
write_state s1 t1 null
assert_eq "no-pr first -> retry" "retry:no-pr" "$(phase_gate s1 t1)"
assert_eq "no-pr bumped nopr_attempts" "1" "$(jq -r '.tasks.t1.nopr_attempts' "$PHASE_DIR/s1.json")"

# Case: no-pr at cap -> park:no-pr-timeout
write_state s1 t1 null '{"nopr_attempts":3}'
assert_eq "no-pr at cap -> timeout" "park:no-pr-timeout" "$(phase_gate s1 t1)"

# Case: sync failure on BEHIND -> park:sync-failed (push not reached)
: > "$WORK/calls"; write_state s1 t1 7; CI=pass MSS=BEHIND SYNC_RC=1
assert_eq "sync fail -> park" "park:sync-failed" "$(phase_gate s1 t1)"
assert_eq "sync fail did not push" "sync:42" "$(cat "$WORK/calls")"
unset SYNC_RC

# Case: push failure on BEHIND -> park:push-failed
: > "$WORK/calls"; write_state s1 t1 7; CI=pass MSS=BEHIND PUSH_RC=1
assert_eq "push fail -> park" "park:push-failed" "$(phase_gate s1 t1)"
unset PUSH_RC

# Case: the LIVE branch resolver wins (regression guard against re-adding the dead stub in phase-lib.sh).
# Sourcing bottega-api.sh (which sources phase-lib.sh then redefines _phase_pr_branch_live) must yield
# the real gh-headRefName impl, never the "not wired" placeholder. api() is shadowed so nothing hits net.
API_SH="$SCRIPT_DIR/../../contrib/skills/bottega/scripts/bottega-api.sh"
if [[ -r "$API_SH" ]]; then
  resolver_body="$(bash -c '
    api() { echo "{}"; }
    source "'"$API_SH"'" >/dev/null 2>&1 || true
    declare -f _phase_pr_branch_live
  ' 2>/dev/null)"
  if printf '%s' "$resolver_body" | grep -q 'headRefName'; then
    echo "PASS [live resolver is real gh impl, not stub]"; pass=$((pass+1))
  else
    echo "FAIL [live resolver is real gh impl, not stub]" >&2
    echo "  active _phase_pr_branch_live lacks 'headRefName' — a dead stub may have been re-added to phase-lib.sh" >&2
    fail=$((fail+1))
  fi
fi

echo ""; echo "phase-yolo-update.test.sh: $pass passed, $fail failed"; [[ $fail -eq 0 ]]
