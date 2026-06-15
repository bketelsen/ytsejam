#!/usr/bin/env bash
# Regression tests for scripts/check-skills-drift.sh.
#
# Bash-only, no external test harness. Run directly:
#   bash scripts/test/check-skills-drift.test.sh
# Exits 0 on all-pass, 1 on any failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK_SCRIPT="$SCRIPT_DIR/../check-skills-drift.sh"

[[ -r "$CHECK_SCRIPT" ]] || { echo "FAIL: cannot find $CHECK_SCRIPT" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0

run_case() {
  local name="$1"; shift
  local want_exit="$1"; shift
  local want_stderr="$1"; shift  # substring, "" to skip
  local seed="$1"; shift
  local live="$1"; shift

  local out err rc
  out="$(mktemp)"; err="$(mktemp)"
  set +e
  bash "$CHECK_SCRIPT" "$seed" "$live" >"$out" 2>"$err"
  rc=$?
  set -e

  local failed=0
  if [[ "$rc" != "$want_exit" ]]; then
    echo "FAIL [$name]: expected exit $want_exit, got $rc" >&2
    failed=1
  fi
  if [[ -n "$want_stderr" ]] && ! grep -qF "$want_stderr" "$err"; then
    echo "FAIL [$name]: stderr missing substring: $want_stderr" >&2
    echo "--- stderr ---" >&2; cat "$err" >&2; echo "--- end ---" >&2
    failed=1
  fi
  if [[ $failed -eq 0 ]]; then pass=$((pass+1)); else fail=$((fail+1)); fi
  rm -f "$out" "$err"
}

# Case 1: identical seed and live → exit 0
mkdir -p "$WORK/c1/seed" "$WORK/c1/live"
echo "hello" > "$WORK/c1/seed/foo.md"
echo "hello" > "$WORK/c1/live/foo.md"
run_case "identical → exit 0" 0 "" "$WORK/c1/seed" "$WORK/c1/live"

# Case 2: live missing the seed → exit 0 (boot will seed it)
mkdir -p "$WORK/c2/seed" "$WORK/c2/live"
echo "hello" > "$WORK/c2/seed/foo.md"
run_case "live missing → exit 0" 0 "" "$WORK/c2/seed" "$WORK/c2/live"

# Case 3: live has extra files not in seed → exit 0 (user-shaped)
mkdir -p "$WORK/c3/seed" "$WORK/c3/live"
echo "hello" > "$WORK/c3/seed/foo.md"
echo "hello" > "$WORK/c3/live/foo.md"
echo "user" > "$WORK/c3/live/user-skill.md"
run_case "live-extra → exit 0" 0 "" "$WORK/c3/seed" "$WORK/c3/live"

# Case 4: one seed differs → exit 1, name in stderr
mkdir -p "$WORK/c4/seed" "$WORK/c4/live"
echo "new content" > "$WORK/c4/seed/foo.md"
echo "old content" > "$WORK/c4/live/foo.md"
run_case "one drift → exit 1" 1 "── foo.md ──" "$WORK/c4/seed" "$WORK/c4/live"
run_case "one drift mentions count" 1 "1 seeded skill" "$WORK/c4/seed" "$WORK/c4/live"

# Case 5: multiple drifts → exit 1, both names in stderr
mkdir -p "$WORK/c5/seed" "$WORK/c5/live"
echo "new a" > "$WORK/c5/seed/a.md"; echo "old a" > "$WORK/c5/live/a.md"
echo "new b" > "$WORK/c5/seed/b.md"; echo "old b" > "$WORK/c5/live/b.md"
run_case "multi drift count" 1 "2 seeded skill" "$WORK/c5/seed" "$WORK/c5/live"

# Case 6: dir-bundle in seed is IGNORED (only flat *.md compared)
mkdir -p "$WORK/c6/seed/bundle" "$WORK/c6/live/bundle"
echo "seedy" > "$WORK/c6/seed/bundle/SKILL.md"
echo "livey" > "$WORK/c6/live/bundle/SKILL.md"
run_case "dir-bundle ignored → exit 0" 0 "" "$WORK/c6/seed" "$WORK/c6/live"

# Case 7: bad args
# Plan's placeholder run_case with two real directories was removed: it passed
# arguments and therefore did not exercise usage handling. The bare call below
# is the actual no-args regression test.
out="$(mktemp)"; err="$(mktemp)"
set +e; bash "$CHECK_SCRIPT" >"$out" 2>"$err"; rc=$?; set -e
if [[ "$rc" == 2 ]] && grep -qF "usage:" "$err"; then pass=$((pass+1)); else echo "FAIL [no-args]: rc=$rc" >&2; fail=$((fail+1)); fi
rm -f "$out" "$err"

# Case 8: missing seed dir (use a path inside $WORK, guaranteed absent)
run_case "missing seed dir → exit 2" 2 "seed dir not found" "$WORK/nope-seed" "$WORK/c1/live"

# Case 9: missing live dir (use a path inside $WORK, guaranteed absent)
run_case "missing live dir → exit 2" 2 "live dir not found" "$WORK/c1/seed" "$WORK/nope-live"

echo ""
echo "passed: $pass"
echo "failed: $fail"
[[ $fail -eq 0 ]]
