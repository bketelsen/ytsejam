#!/usr/bin/env bash
# Regression tests for deploy/sync-skills.sh.
#
# Bash-only, no external test harness. Run directly:
#   bash deploy/test/sync-skills.test.sh
# Exits 0 on all-pass, 1 on any failure.
#
# Mirrors the conventions of scripts/test/check-skills-drift.test.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC_SCRIPT="$SCRIPT_DIR/../sync-skills.sh"

[[ -r "$SYNC_SCRIPT" ]] || { echo "FAIL: cannot find $SYNC_SCRIPT" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0

# run_case <name> <args...> SEP <want_exit> <want_stdout_substr> <want_stderr_substr> <seed> <live>
#   Pass "" for any want_* that should be skipped.
#   Sync-skills reads SEED_DIR + LIVE_DIR from env (not positional args), so the
#   caller sets those directly via the seed/live paths.
run_case() {
  local name="$1"; shift
  local mode="$1"; shift            # "dry" or "yes"
  local want_exit="$1"; shift
  local want_stdout="$1"; shift
  local want_stderr="$1"; shift
  local seed="$1"; shift
  local live="$1"; shift

  local out err rc args=()
  out="$(mktemp)"; err="$(mktemp)"
  [[ "$mode" == "yes" ]] && args+=("--yes")

  set +e
  SEED_DIR="$seed" LIVE_DIR="$live" bash "$SYNC_SCRIPT" "${args[@]}" >"$out" 2>"$err"
  rc=$?
  set -e

  local failed=0
  if [[ "$rc" != "$want_exit" ]]; then
    echo "FAIL [$name]: expected exit $want_exit, got $rc" >&2
    failed=1
  fi
  if [[ -n "$want_stdout" ]] && ! grep -qF "$want_stdout" "$out"; then
    echo "FAIL [$name]: stdout missing substring: $want_stdout" >&2
    echo "--- stdout ---" >&2; cat "$out" >&2; echo "--- end ---" >&2
    failed=1
  fi
  if [[ -n "$want_stderr" ]] && ! grep -qF "$want_stderr" "$err"; then
    echo "FAIL [$name]: stderr missing substring: $want_stderr" >&2
    echo "--- stderr ---" >&2; cat "$err" >&2; echo "--- end ---" >&2
    failed=1
  fi
  if [[ $failed -eq 0 ]]; then
    echo "PASS [$name]"
    pass=$((pass+1))
  else
    fail=$((fail+1))
  fi
  rm -f "$out" "$err"
}

# Case 1: identical seed and live → dry-run reports nothing
mkdir -p "$WORK/c1/seed" "$WORK/c1/live"
echo "hello" > "$WORK/c1/seed/foo.md"
echo "hello" > "$WORK/c1/live/foo.md"
run_case "identical (dry) → no drift" "dry" 0 "no drift" "" "$WORK/c1/seed" "$WORK/c1/live"

# Case 2: flat file drift, dry-run reports it but doesn't write
mkdir -p "$WORK/c2/seed" "$WORK/c2/live"
echo "seedy" > "$WORK/c2/seed/foo.md"
echo "livey" > "$WORK/c2/live/foo.md"
run_case "flat drift (dry) → would-sync line" "dry" 0 "would sync foo.md" "" "$WORK/c2/seed" "$WORK/c2/live"
# Verify dry-run didn't mutate live
if diff -q "$WORK/c2/seed/foo.md" "$WORK/c2/live/foo.md" >/dev/null 2>&1; then
  echo "FAIL [dry didn't mutate]: live foo.md should still be 'livey'" >&2; fail=$((fail+1))
else
  echo "PASS [dry didn't mutate]"; pass=$((pass+1))
fi

# Case 3: flat file drift, --yes actually syncs
mkdir -p "$WORK/c3/seed" "$WORK/c3/live"
echo "seedy" > "$WORK/c3/seed/foo.md"
echo "livey" > "$WORK/c3/live/foo.md"
run_case "flat drift (yes) → synced line" "yes" 0 "syncing foo.md" "" "$WORK/c3/seed" "$WORK/c3/live"
if diff -q "$WORK/c3/seed/foo.md" "$WORK/c3/live/foo.md" >/dev/null 2>&1; then
  echo "PASS [live now matches seed]"; pass=$((pass+1))
else
  echo "FAIL [live should match seed after --yes]" >&2; fail=$((fail+1))
fi

# Case 4: bundle SKILL.md drift, dry-run reports as `bundle/SKILL.md`
mkdir -p "$WORK/c4/seed/bundle" "$WORK/c4/live/bundle"
echo "seedy" > "$WORK/c4/seed/bundle/SKILL.md"
echo "livey" > "$WORK/c4/live/bundle/SKILL.md"
run_case "bundle drift (dry) → qualified name" "dry" 0 "would sync bundle/SKILL.md" "" "$WORK/c4/seed" "$WORK/c4/live"

# Case 5: bundle SKILL.md drift, --yes syncs
mkdir -p "$WORK/c5/seed/bundle" "$WORK/c5/live/bundle"
echo "seedy" > "$WORK/c5/seed/bundle/SKILL.md"
echo "livey" > "$WORK/c5/live/bundle/SKILL.md"
echo "matched" > "$WORK/c5/seed/bundle/REFERENCE.md"
echo "matched" > "$WORK/c5/live/bundle/REFERENCE.md"
run_case "bundle drift (yes) → synced" "yes" 0 "syncing bundle/SKILL.md" "" "$WORK/c5/seed" "$WORK/c5/live"
if diff -q "$WORK/c5/seed/bundle/SKILL.md" "$WORK/c5/live/bundle/SKILL.md" >/dev/null 2>&1; then
  echo "PASS [bundle SKILL.md synced]"; pass=$((pass+1))
else
  echo "FAIL [bundle SKILL.md not synced]" >&2; fail=$((fail+1))
fi

# Case 6: live-only file INSIDE a seeded bundle is NEVER touched
mkdir -p "$WORK/c6/seed/bundle" "$WORK/c6/live/bundle"
echo "seedy" > "$WORK/c6/seed/bundle/SKILL.md"
echo "livey" > "$WORK/c6/live/bundle/SKILL.md"
echo "user-notes" > "$WORK/c6/live/bundle/user-only.md"
SEED_DIR="$WORK/c6/seed" LIVE_DIR="$WORK/c6/live" bash "$SYNC_SCRIPT" --yes >/dev/null 2>&1
if [[ -f "$WORK/c6/live/bundle/user-only.md" ]] && \
   [[ "$(cat "$WORK/c6/live/bundle/user-only.md")" == "user-notes" ]]; then
  echo "PASS [user-only file preserved]"; pass=$((pass+1))
else
  echo "FAIL [user-only file should be preserved]" >&2; fail=$((fail+1))
fi

# Case 7: live bundle missing entirely → skipped (boot will seed it whole)
mkdir -p "$WORK/c7/seed/bundle" "$WORK/c7/live"
echo "seedy" > "$WORK/c7/seed/bundle/SKILL.md"
run_case "live bundle missing → no-op" "dry" 0 "no drift" "" "$WORK/c7/seed" "$WORK/c7/live"

# Case 8: bad args
out="$(mktemp)"; err="$(mktemp)"
set +e; bash "$SYNC_SCRIPT" --bogus >"$out" 2>"$err"; rc=$?; set -e
if [[ "$rc" == 1 ]] && grep -qF "unknown arg" "$err"; then
  echo "PASS [bad args → exit 1 + error]"
  pass=$((pass+1))
else
  echo "FAIL [bad args]: rc=$rc" >&2
  fail=$((fail+1))
fi
rm -f "$out" "$err"

# Case 9: --help exits 0 with usage on stdout
out="$(mktemp)"; err="$(mktemp)"
set +e; bash "$SYNC_SCRIPT" --help >"$out" 2>"$err"; rc=$?; set -e
if [[ "$rc" == 0 ]] && grep -qF "usage:" "$out"; then
  echo "PASS [--help → exit 0 + usage]"
  pass=$((pass+1))
else
  echo "FAIL [--help]: rc=$rc" >&2
  fail=$((fail+1))
fi
rm -f "$out" "$err"

# Case 10: missing seed dir → exit 1
run_case "missing seed dir → exit 1" "dry" 1 "" "seed dir not found" "$WORK/nope-seed" "$WORK/c1/live"

# Case 11: missing live dir → exit 1
run_case "missing live dir → exit 1" "dry" 1 "" "live dir not found" "$WORK/c1/seed" "$WORK/nope-live"

# Case 12: idempotent — running --yes twice on the same state produces no second sync
mkdir -p "$WORK/c12/seed" "$WORK/c12/live"
echo "seedy" > "$WORK/c12/seed/foo.md"
echo "livey" > "$WORK/c12/live/foo.md"
SEED_DIR="$WORK/c12/seed" LIVE_DIR="$WORK/c12/live" bash "$SYNC_SCRIPT" --yes >/dev/null 2>&1
run_case "idempotent re-run → no drift" "dry" 0 "no drift" "" "$WORK/c12/seed" "$WORK/c12/live"

# ── Cases 13–17: SEED_DIR-defaulting regression (the 2026-06-15 bug). ──
# When YTSEJAM_HOME is set and SEED_DIR is NOT, the script must default to
# the NEWEST dir under $YTSEJAM_HOME/releases/, not $YTSEJAM_HOME/current.
# This catches the false-negative where deploy.sh aborts at the gate
# (current still stale) and the operator's `sync-skills.sh --yes` sees
# "no drift" against current and re-fails the next deploy.
# These cases set YTSEJAM_HOME and LIVE_DIR but deliberately leave SEED_DIR
# unset to exercise the new defaulting path.

assert_substring() {
  # Lightweight helper for the YTSEJAM_HOME-based cases (run_case takes SEED_DIR).
  local name="$1" want="$2" got="$3"
  if [[ "$got" == *"$want"* ]]; then
    echo "PASS [$name]"
    pass=$((pass + 1))
  else
    echo "FAIL [$name]" >&2
    echo "  want substring: $want" >&2
    echo "  got: $got" >&2
    fail=$((fail + 1))
  fi
}

# Case 13: stale current, newer release pending, live = stale → must detect drift
mkdir -p "$WORK/c13/releases/20260101-000000/server/skills"
mkdir -p "$WORK/c13/releases/20260102-000000/server/skills"
mkdir -p "$WORK/c13/data/skills"
echo "old skill content" > "$WORK/c13/releases/20260101-000000/server/skills/cog.md"
echo "new skill content" > "$WORK/c13/releases/20260102-000000/server/skills/cog.md"
echo "old skill content" > "$WORK/c13/data/skills/cog.md"
ln -sfn "$WORK/c13/releases/20260101-000000" "$WORK/c13/current"

out13=$(LIVE_DIR="$WORK/c13/data/skills" YTSEJAM_HOME="$WORK/c13" bash "$SYNC_SCRIPT" 2>&1)
assert_substring "stale-current-pending-release: dry-run detects drift" "would sync cog.md" "$out13"
assert_substring "stale-current-pending-release: cites count of 1" "1 seeded skill(s) would be synced" "$out13"

# Case 14: --yes against the same scenario writes the NEW release's content
out14=$(LIVE_DIR="$WORK/c14/data/skills" YTSEJAM_HOME="$WORK/c14" bash -c "
  set -euo pipefail
  mkdir -p $WORK/c14/releases/20260101-000000/server/skills
  mkdir -p $WORK/c14/releases/20260102-000000/server/skills
  mkdir -p $WORK/c14/data/skills
  echo 'old skill content' > $WORK/c14/releases/20260101-000000/server/skills/cog.md
  echo 'new skill content' > $WORK/c14/releases/20260102-000000/server/skills/cog.md
  echo 'old skill content' > $WORK/c14/data/skills/cog.md
  ln -sfn $WORK/c14/releases/20260101-000000 $WORK/c14/current
  LIVE_DIR=$WORK/c14/data/skills YTSEJAM_HOME=$WORK/c14 bash $SYNC_SCRIPT --yes
  cat $WORK/c14/data/skills/cog.md
" 2>&1)
assert_substring "stale-current-pending-release: --yes writes NEW content" "new skill content" "$out14"
assert_substring "stale-current-pending-release: --yes reports sync" "synced 1 seeded skill(s)" "$out14"

# Case 15: live already matches NEWEST release → no drift
mkdir -p "$WORK/c15/releases/20260101-000000/server/skills"
mkdir -p "$WORK/c15/releases/20260102-000000/server/skills"
mkdir -p "$WORK/c15/data/skills"
echo "old" > "$WORK/c15/releases/20260101-000000/server/skills/cog.md"
echo "match" > "$WORK/c15/releases/20260102-000000/server/skills/cog.md"
echo "match" > "$WORK/c15/data/skills/cog.md"
ln -sfn "$WORK/c15/releases/20260102-000000" "$WORK/c15/current"

out15=$(LIVE_DIR="$WORK/c15/data/skills" YTSEJAM_HOME="$WORK/c15" bash "$SYNC_SCRIPT" 2>&1)
assert_substring "match-newest-release: no drift" "no drift" "$out15"

# Case 16: explicit SEED_DIR override still wins (operator can point anywhere)
mkdir -p "$WORK/c16/releases/20260102-000000/server/skills"
mkdir -p "$WORK/c16/alt-seed" "$WORK/c16/data/skills"
echo "newest-release" > "$WORK/c16/releases/20260102-000000/server/skills/cog.md"
echo "alt-content" > "$WORK/c16/alt-seed/cog.md"
echo "newest-release" > "$WORK/c16/data/skills/cog.md"
ln -sfn "$WORK/c16/releases/20260102-000000" "$WORK/c16/current"

out16=$(SEED_DIR="$WORK/c16/alt-seed" LIVE_DIR="$WORK/c16/data/skills" YTSEJAM_HOME="$WORK/c16" bash "$SYNC_SCRIPT" 2>&1)
assert_substring "SEED_DIR-override: takes precedence over YTSEJAM_HOME default" "would sync cog.md" "$out16"

# Case 17: no releases/ dir → fall back to current/server/skills
mkdir -p "$WORK/c17/fresh/server/skills" "$WORK/c17/data/skills"
echo "fresh" > "$WORK/c17/fresh/server/skills/cog.md"
echo "old-live" > "$WORK/c17/data/skills/cog.md"
ln -sfn "$WORK/c17/fresh" "$WORK/c17/current"

out17=$(LIVE_DIR="$WORK/c17/data/skills" YTSEJAM_HOME="$WORK/c17" bash "$SYNC_SCRIPT" 2>&1)
assert_substring "no-releases-dir: falls back to current/server/skills" "would sync cog.md" "$out17"

echo ""
echo "sync-skills.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
