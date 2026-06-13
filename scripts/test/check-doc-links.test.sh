#!/usr/bin/env bash
# Regression tests for scripts/check-doc-links.sh.
#
# Covers the exit-code behavior fix from issue #112 (subshell variable-scope
# leak that caused exit 0 on broken links) plus the no-internal-links pipefail
# tolerance from #97.
#
# No external test harness — keeps the dependency surface flat. Run directly:
#   bash scripts/test/check-doc-links.test.sh
# Exits 0 on all-pass, 1 on any assertion failure (with the offending case
# name on stderr).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK_SCRIPT="$SCRIPT_DIR/../check-doc-links.sh"

if [ ! -x "$CHECK_SCRIPT" ] && [ ! -r "$CHECK_SCRIPT" ]; then
  echo "FAIL: cannot find check-doc-links.sh at $CHECK_SCRIPT" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0

# assert_case <name> <expected_exit> <expect_stdout_contains> <expect_stderr_contains> <files...>
# Use "" for any expect_* that should be skipped.
assert_case() {
  local name="$1"; shift
  local want_exit="$1"; shift
  local want_stdout="$1"; shift
  local want_stderr="$1"; shift

  local out err rc
  out="$(mktemp)"; err="$(mktemp)"
  set +e
  bash "$CHECK_SCRIPT" "$@" >"$out" 2>"$err"
  rc=$?
  set -e

  local failed=0
  if [ "$rc" != "$want_exit" ]; then
    echo "FAIL [$name]: expected exit $want_exit, got $rc" >&2
    failed=1
  fi
  if [ -n "$want_stdout" ] && ! grep -qF "$want_stdout" "$out"; then
    echo "FAIL [$name]: stdout missing substring: $want_stdout" >&2
    echo "  stdout was:" >&2
    sed 's/^/    /' "$out" >&2
    failed=1
  fi
  if [ -n "$want_stderr" ] && ! grep -qF "$want_stderr" "$err"; then
    echo "FAIL [$name]: stderr missing substring: $want_stderr" >&2
    echo "  stderr was:" >&2
    sed 's/^/    /' "$err" >&2
    failed=1
  fi
  # Regression-specific: on broken-link cases the false-positive OK line must
  # NOT appear (this was the #112 bug signature).
  if [ "$want_exit" = "1" ] && grep -qF "OK: all internal links resolve." "$out"; then
    echo "FAIL [$name]: stdout contains false-positive OK line on broken input" >&2
    failed=1
  fi

  rm -f "$out" "$err"
  if [ "$failed" = "0" ]; then
    echo "PASS [$name]"
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
  fi
}

# ---- fixtures ----------------------------------------------------------------

cd "$WORK"

cat > broken.md <<'MD'
# Test
This links to a [missing file](./does-not-exist.md) which is broken.
MD

cat > clean-target.md <<'MD'
# Clean Target
Body.
MD

cat > clean.md <<'MD'
# Clean
See [the target](./clean-target.md).
MD

cat > external.md <<'MD'
# External
See [GitHub](https://github.com) and [mail](mailto:foo@example.com).
Also a same-file [anchor](#external).
MD

cat > no-links.md <<'MD'
# No Links
Just prose, no markdown link syntax at all.
This is the #97 regression fixture.
MD

cat > anchor-broken.md <<'MD'
# Anchor Broken
See [nope](./clean-target.md#no-such-section).
MD

cat > anchor-good.md <<'MD'
# Anchor Good
See [the heading](./clean-target.md#clean-target).
MD

# ---- cases -------------------------------------------------------------------

assert_case "broken-link exits 1" \
  1 "" "BROKEN: " "$WORK/broken.md"

assert_case "broken-link prints FAIL summary" \
  1 "" "FAIL: one or more links are broken." "$WORK/broken.md"

assert_case "clean-link exits 0 with OK summary" \
  0 "OK: all internal links resolve." "" "$WORK/clean.md"

assert_case "no-internal-links exits 0 (issue #97)" \
  0 "OK: all internal links resolve." "" "$WORK/no-links.md"

assert_case "external-only links exit 0" \
  0 "OK: all internal links resolve." "" "$WORK/external.md"

assert_case "multi-file with one broken exits 1" \
  1 "" "BROKEN: " "$WORK/clean.md" "$WORK/broken.md"

assert_case "broken anchor exits 1" \
  1 "" "anchor #no-such-section not found" "$WORK/anchor-broken.md"

assert_case "valid anchor exits 0" \
  0 "OK: all internal links resolve." "" "$WORK/anchor-good.md"

# ---- summary -----------------------------------------------------------------

echo ""
echo "check-doc-links.test.sh: $pass passed, $fail failed"
if [ "$fail" -ne 0 ]; then
  exit 1
fi
