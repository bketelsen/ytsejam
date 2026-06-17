#!/usr/bin/env bash
# Regression tests for contrib/skills/bottega/scripts/bottega-api.sh.
#
# Bash-only, no external test harness. Run directly:
#   bash scripts/test/bottega-api.test.sh
# Exits 0 on all-pass, 1 on any failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$SCRIPT_DIR/../../contrib/skills/bottega/scripts/bottega-api.sh"

[[ -r "$HELPER" ]] || { echo "FAIL: cannot find $HELPER" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/bin"
printf 'test-token' > "$WORK/key"

cat > "$WORK/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

method=""
payload=""
url=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -X)
      method="$2"
      shift 2
      ;;
    -d)
      payload="$2"
      shift 2
      ;;
    http://*|https://*)
      url="$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

printf '%s' "$method" > "$CAPTURE_METHOD"
printf '%s' "$payload" > "$CAPTURE_PAYLOAD"
printf '%s' "$url" > "$CAPTURE_URL"
printf '{"success":true}\n'
EOF
chmod +x "$WORK/bin/curl"

pass=0
fail=0

assert_eq() {
  local name="$1" want="$2" got="$3"
  if [[ "$got" == "$want" ]]; then
    echo "PASS [$name]"
    pass=$((pass + 1))
  else
    echo "FAIL [$name]" >&2
    echo "  want: $want" >&2
    echo "  got:  $got" >&2
    fail=$((fail + 1))
  fi
}

body=$'brief with "quotes"\nand a second line'
expected_bytes="$(printf '%s' "$body" | wc -c | tr -d ' ')"

out="$(
  PATH="$WORK/bin:$PATH" \
  BOTTEGA_KEY_FILE="$WORK/key" \
  BOTTEGA_BASE="http://bottega.test" \
  CAPTURE_METHOD="$WORK/method" \
  CAPTURE_PAYLOAD="$WORK/payload.json" \
  CAPTURE_URL="$WORK/url" \
  bash "$HELPER" doc-set 243 "$body"
)"

assert_eq "doc-set reports sent body bytes" \
  "doc-set OK: task 243 brief now $expected_bytes bytes sent" \
  "$out"
assert_eq "doc-set uses PUT" "PUT" "$(cat "$WORK/method")"
assert_eq "doc-set targets documentation endpoint" \
  "http://bottega.test/api/tasks/243/documentation" \
  "$(cat "$WORK/url")"

if jq -e --arg body "$body" '. == {content: $body}' "$WORK/payload.json" >/dev/null; then
  echo "PASS [doc-set preserves PUT payload]"
  pass=$((pass + 1))
else
  echo "FAIL [doc-set preserves PUT payload]" >&2
  echo "--- payload ---" >&2
  cat "$WORK/payload.json" >&2
  echo "--- end ---" >&2
  fail=$((fail + 1))
fi

echo ""
echo "bottega-api.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
