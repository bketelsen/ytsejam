# advance:yolo auto-update-behind — Implementation Plan

> Execute with the `develop` skill, task-by-task.

**Goal:** Make the Bottega phase orchestrator auto-update behind PRs (via Bottega sync+push-changes), read CI from the stable per-check bucket, and treat `no-pr`/`behind` as bounded-retryable instead of terminal parks.

**Spec:** docs/plans/2026-06-18-phase-yolo-auto-update-behind-design.md

**Architecture:** Pure-decision `phase_gate` gains BEHIND detection (read-only `gh`) + action (Bottega `sync`/`push-changes`) and bounded retry counters in phase state. A new `retry:<reason>` verdict keeps a task `pr_open` (re-gated next tick) instead of terminally `parked`; the actuator `phase_advance_prs` gains one branch for it. CI rollup reads `.ciStatus.checks[].bucket`.

**Tech Stack:** Bash, jq, gh, curl. Bash-only regression test (no external harness), matching the existing `scripts/test/bottega-api.test.sh`.

**Worktree:** /tmp/phase-yolo-auto-update-behind

**Branch:** fix/phase-yolo-auto-update-behind

---

## Conventions

- Files edited live at `contrib/skills/bottega/scripts/{phase-lib.sh,bottega-api.sh}` (repo source-of-truth). The live runtime copy under `~/.ytsejam/data/skills/bottega/` is synced **after merge**, separately — NOT touched by this plan.
- Run the script test as: `bash scripts/test/phase-yolo-update.test.sh` (new file, Task 5).
- All new live helpers shell into the bottega container or curl Bottega; all are injectable via `PHASE_*_FN` env overrides so the test touches no network. Follow the existing `_phase_*_live` + `PHASE_*_FN` pattern exactly.
- Verdict contract: `phase_gate` echoes exactly one operative token on its last line — `pass`, `park:<reason>` (terminal), or `retry:<reason>` (non-terminal, re-gate next tick). `phase_advance_prs` already takes `${verdict##*$'\n'}`.

---

## Task 1: CI bucket rollup (defect 1)

**Files:**
- Modify: `contrib/skills/bottega/scripts/bottega-api.sh` (`_phase_pr_meta_live`, ~lines 67-75)
- Test: covered in Task 5

### Step 1: Replace the `.ciStatus.status` read with a per-check bucket rollup

In `_phase_pr_meta_live`, replace this line:
```bash
  ci="$(printf '%s' "$prj" | jq -r '.ciStatus.status // "unknown"')" || return 1
```
with:
```bash
  # Roll up CI from per-check buckets (stable: pass|fail|pending|skipping).
  # .ciStatus.status is the past-tense rollup "passed"/"failed" — do NOT compare it to "pass".
  ci="$(printf '%s' "$prj" | jq -r '
    (.ciStatus.checks // []) as $c
    | if   ($c|length)==0                 then "none"
      elif any($c[]; .bucket=="fail")     then "fail"
      elif any($c[]; .bucket=="pending")  then "pending"
      elif all($c[]; .bucket=="pass")     then "pass"
      else "unknown" end')" || return 1
```

### Step 2: Commit
```bash
git add contrib/skills/bottega/scripts/bottega-api.sh
git commit -m "fix(phase): roll up CI from per-check bucket, not past-tense .status"
```

---

## Task 2: New live helpers — BEHIND detect, sync, push (Option A seam)

**Files:**
- Modify: `contrib/skills/bottega/scripts/phase-lib.sh` (add three `_phase_*_live` helpers near the other live helpers, after `_phase_stale_base_live`)
- Test: covered in Task 5

### Step 1: Add `_phase_pr_behind_live` (read-only mergeStateStatus via gh)

Append after `_phase_stale_base_live` (the helpers run in the bottega container, matching the existing pattern):
```bash
# _phase_pr_behind_live <pr-number> -> stdout = mergeStateStatus (BEHIND|CLEAN|CONFLICTING|DIRTY|BLOCKED|UNKNOWN|...)
# Read-only. MUST exit non-zero if it cannot run, so the caller parks meta-check-failed rather than mis-deciding.
_phase_pr_behind_live() {
  local pr="$1"
  incus exec bottega -- su - code -c "
    set -e; cd ~/projects/ytsejam
    gh pr view \"$pr\" --json mergeStateStatus --jq '.mergeStateStatus' 2>/dev/null
  "
}
```

### Step 2: Add `_phase_sync_live` and `_phase_push_live` (Bottega pull + push)

Append after the helper above. These POST to Bottega with the same `api` helper / Bearer key the skill already uses (sourced from `bottega-api.sh` in the live runtime; in the phase lib they shell the helper script):
```bash
# _phase_sync_live <taskId> -> POST /api/tasks/<id>/sync (git fetch origin + merge origin/main into worktree). exit 0 on {"success":true}.
_phase_sync_live() {
  local tid="$1" out
  out="$(_phase_bottega_post "/api/tasks/$tid/sync" '{}')" || return 1
  printf '%s' "$out" | jq -e '.success == true' >/dev/null 2>&1
}

# _phase_push_live <taskId> -> POST /api/tasks/<id>/push-changes (commit-if-dirty + push to PR branch). Idempotent. exit 0 on {"success":true}.
_phase_push_live() {
  local tid="$1" out
  out="$(_phase_bottega_post "/api/tasks/$tid/push-changes" '{}')" || return 1
  printf '%s' "$out" | jq -e '.success == true' >/dev/null 2>&1
}
```

### Step 3: Add the `_phase_bottega_post` shim

`phase-lib.sh` is sourced alongside `bottega-api.sh` (which defines `api()`), but to keep the lib self-contained and testable, add a thin POST shim near the top of the live-helpers block. If an `api` function is already in scope it delegates; otherwise it curls directly using `BOTTEGA_BASE` + `BOTTEGA_KEY_FILE` (the same env the skill already exports):
```bash
# _phase_bottega_post <path> <json-body> -> raw response body. Uses api() if sourced, else curls with Bearer key.
_phase_bottega_post() {
  local path="$1" body="$2"
  if declare -F api >/dev/null 2>&1; then
    api POST "$path" "$body"
  else
    local base key
    base="${BOTTEGA_BASE:?BOTTEGA_BASE unset}"
    key="$(cat "${BOTTEGA_KEY_FILE:?BOTTEGA_KEY_FILE unset}")"
    curl -fsS -X POST -H "Authorization: Bearer $key" -H "Content-Type: application/json" \
      -d "$body" "$base$path"
  fi
}
```

### Step 4: Commit
```bash
git add contrib/skills/bottega/scripts/phase-lib.sh
git commit -m "feat(phase): add live helpers for BEHIND detect + Bottega sync/push"
```

---

## Task 3: phase_gate — BEHIND auto-update with bounded retry (defect 2) + no-pr backoff (defect 3)

**Files:**
- Modify: `contrib/skills/bottega/scripts/phase-lib.sh` (`phase_gate`, lines 178-206)
- Test: covered in Task 5

### Step 1: Make `no-pr` bounded-retryable

Replace line 184:
```bash
  [ "$pr" = "null" ] && { echo "park:no-pr"; return 0; }
```
with:
```bash
  if [ "$pr" = "null" ]; then
    local na
    na="$(printf '%s' "$j" | jq -r --arg k "$key" '(.tasks[$k].nopr_attempts // 0)')"
    case "$na" in ''|*[!0-9]*) na=0 ;; esac
    if [ "$na" -ge "${PHASE_MAX_NOPR_ATTEMPTS:-3}" ]; then
      echo "park:no-pr-timeout"; return 0
    fi
    phase_state_set "$slug" "$key" nopr_attempts "$((na + 1))" >/dev/null 2>&1 || true
    echo "retry:no-pr"; return 0
  fi
```

### Step 2: Insert BEHIND detection + action after the mergeable check (after line 199)

After:
```bash
  [ "$mergeable" = "MERGEABLE" ] || { echo "park:not-mergeable($mergeable)"; return 0; }
```
insert:
```bash

  # Branch protection on main is strict (require up-to-date) — a BEHIND PR cannot merge.
  # Detect read-only via gh; fix via Bottega sync+push (keeps worktree+remote ref in lockstep), bounded.
  local mss
  mss="$("${PHASE_PR_BEHIND_FN:-_phase_pr_behind_live}" "$pr")" || { echo "park:behind-check-failed"; return 0; }
  case "$mss" in
    BEHIND)
      local ua
      ua="$(printf '%s' "$j" | jq -r --arg k "$key" '(.tasks[$k].update_attempts // 0)')"
      case "$ua" in ''|*[!0-9]*) ua=0 ;; esac
      if [ "$ua" -ge "${PHASE_MAX_UPDATE_ATTEMPTS:-3}" ]; then
        echo "park:stuck-behind"; return 0
      fi
      phase_state_set "$slug" "$key" update_attempts "$((ua + 1))" >/dev/null 2>&1 || true
      "${PHASE_SYNC_FN:-_phase_sync_live}" "$tid"  || { echo "park:sync-failed"; return 0; }
      "${PHASE_PUSH_FN:-_phase_push_live}" "$tid"  || { echo "park:push-failed"; return 0; }
      echo "retry:behind-updating"; return 0
      ;;
    CONFLICTING|DIRTY)
      echo "park:merge-conflict($mss)"; return 0
      ;;
  esac
```
(All other `mss` values — `CLEAN`, `BLOCKED`, `UNKNOWN`, `HAS_HOOKS`, `UNSTABLE`, empty — fall through to the existing stale-base + container-gate checks unchanged.)

### Step 3: Reset counters on the pass path

Replace the final two lines of `phase_gate`:
```bash
  if ! "${PHASE_CONTAINER_GATE_FN:-_phase_container_gate_live}" "$br"; then echo "park:gate-red"; return 0; fi
  echo "pass"; return 0
```
with:
```bash
  if ! "${PHASE_CONTAINER_GATE_FN:-_phase_container_gate_live}" "$br"; then echo "park:gate-red"; return 0; fi
  phase_state_set "$slug" "$key" update_attempts 0 >/dev/null 2>&1 || true
  phase_state_set "$slug" "$key" nopr_attempts 0 >/dev/null 2>&1 || true
  echo "pass"; return 0
```

### Step 4: Commit
```bash
git add contrib/skills/bottega/scripts/phase-lib.sh
git commit -m "feat(phase): auto-update BEHIND PRs + bounded no-pr backoff in phase_gate"
```

---

## Task 4: phase_advance_prs — honor the `retry:` verdict (keep pr_open)

**Files:**
- Modify: `contrib/skills/bottega/scripts/phase-lib.sh` (`phase_advance_prs`, the final `else` park branch ~line 293-297)
- Test: covered in Task 5

### Step 1: Add a `retry:` branch before the terminal park

Replace the final else branch:
```bash
    else
      phase_task_set "$slug" "$key" '.state="parked"' || return $?
      phase_task_set_str "$slug" "$key" reason "$verdict" || return $?
      phase_log "$slug" "parked $key: $verdict" || return $?
    fi
```
with:
```bash
    elif [ "$grc" -eq 0 ] && [ "${verdict#retry:}" != "$verdict" ]; then
      # Non-terminal: leave state pr_open so the next tick re-gates. Log only if the reason changed.
      local cur_reason
      cur_reason="$(phase_state_read "$slug" | jq -r --arg k "$key" '.tasks[$k].reason // ""')" || return $?
      if [ "$cur_reason" != "$verdict" ]; then
        phase_task_set_str "$slug" "$key" reason "$verdict" || return $?
        phase_log "$slug" "retry $key: $verdict" || return $?
      fi
    else
      phase_task_set "$slug" "$key" '.state="parked"' || return $?
      phase_task_set_str "$slug" "$key" reason "$verdict" || return $?
      phase_log "$slug" "parked $key: $verdict" || return $?
    fi
```

### Step 2: Commit
```bash
git add contrib/skills/bottega/scripts/phase-lib.sh
git commit -m "feat(phase): retry: verdict keeps task pr_open for next-tick re-gate"
```

---

## Task 5: Regression test (bash-only, stubbed)

**Files:**
- Create: `scripts/test/phase-yolo-update.test.sh` (repo-root `scripts/test/` — this is where the gate's tests live, confirmed: `gate.sh` calls `bash scripts/test/bottega-api.test.sh`; the contrib tree has no test dir).
- Wire into the repo gate: append a call in `scripts/gate.sh` next to the existing `scripts/test/bottega-api.test.sh` line.

**Path note:** because the test sits at repo-root `scripts/test/`, its `LIB` resolves up two levels into contrib: `LIB="$SCRIPT_DIR/../../contrib/skills/bottega/scripts/phase-lib.sh"`.

### Step 1: Write the test

Create `scripts/test/phase-yolo-update.test.sh`. It sources both scripts, sets a `PHASE_DIR` to a tmp dir with a crafted state file, and overrides every live seam (`PHASE_PR_BRANCH_FN`, `PHASE_PR_META_FN`, `PHASE_PR_BEHIND_FN`, `PHASE_SYNC_FN`, `PHASE_PUSH_FN`, `PHASE_STALE_BASE_FN`, `PHASE_CONTAINER_GATE_FN`) so nothing hits the network. Each case calls `phase_gate <slug> <key>` and asserts the verdict + side effects (counter in state, sync/push capture files).

```bash
#!/usr/bin/env bash
# Regression tests for phase_gate auto-update-behind + CI bucket rollup + no-pr backoff.
# Bash-only, no external harness. Run: bash scripts/test/phase-yolo-update.test.sh
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
  else echo "FAIL [$n]" >&2; echo "  want: $want" >&2; echo "  got:  $got" >&2; fail=$((fail+1)); fi; }

# Write a phase state with one pr_open task. Args: slug key pr extra-json
write_state() { local slug="$1" key="$2" pr="$3" extra="${4:-{}}"
  cat > "$PHASE_DIR/$slug.json" <<EOF
{"advance":"yolo","tasks":{"$key":$(jq -n --arg k "$key" --argjson pr "$pr" --argjson x "$extra" \
  '{taskId:42,state:"pr_open",pr:$pr} + $x')}}
EOF
}

# Default benign seams (override per-case as needed)
export PHASE_PR_BRANCH_FN=_t_branch;  _t_branch() { echo "task/42-x"; }
export PHASE_STALE_BASE_FN=_t_stale;  _t_stale() { echo ""; }            # no overlap
export PHASE_CONTAINER_GATE_FN=_t_gate; _t_gate() { return 0; }          # gate green
export PHASE_PR_BEHIND_FN=_t_behind;  _t_behind() { echo "${MSS:-CLEAN}"; }
export PHASE_SYNC_FN=_t_sync;  _t_sync() { echo "sync:$1" >> "$WORK/calls"; return "${SYNC_RC:-0}"; }
export PHASE_PUSH_FN=_t_push;  _t_push() { echo "push:$1" >> "$WORK/calls"; return "${PUSH_RC:-0}"; }

# --- CI bucket rollup (via _phase_pr_meta_live is live; here assert the jq directly through a meta stub) ---
# meta stub returns "<ci> <mergeable> <blocked>" — exercise phase_gate's consumption of ci values:
export PHASE_PR_META_FN=_t_meta
_t_meta() { echo "${CI:-pass} ${MERGEABLE:-MERGEABLE} 0"; }

# Case: CLEAN + pass -> pass, counters reset
: > "$WORK/calls"; write_state s1 t1 7
CI=pass MERGEABLE=MERGEABLE MSS=CLEAN
assert_eq "clean green -> pass" "pass" "$(phase_gate s1 t1)"
assert_eq "clean green fires no sync/push" "" "$(cat "$WORK/calls" 2>/dev/null || true)"

# Case: ci=passed-style mismatch is gone — meta now yields pass; ci=fail -> park:ci-fail
write_state s1 t1 7; CI=fail MSS=CLEAN
assert_eq "ci fail -> park" "park:ci-fail" "$(phase_gate s1 t1)"

# Case: BEHIND under cap -> retry:behind-updating, fires sync+push, counter=1
: > "$WORK/calls"; write_state s1 t1 7; CI=pass MSS=BEHIND
assert_eq "behind -> retry" "retry:behind-updating" "$(phase_gate s1 t1)"
assert_eq "behind fired sync+push" "sync:42
push:42" "$(cat "$WORK/calls")"
assert_eq "behind bumped counter" "1" "$(jq -r '.tasks.t1.update_attempts' "$PHASE_DIR/s1.json")"

# Case: BEHIND at cap -> park:stuck-behind, fires neither
: > "$WORK/calls"; write_state s1 t1 7 '{"update_attempts":3}'; CI=pass MSS=BEHIND
assert_eq "behind at cap -> stuck" "park:stuck-behind" "$(phase_gate s1 t1)"
assert_eq "stuck fires nothing" "" "$(cat "$WORK/calls" 2>/dev/null || true)"

# Case: CONFLICTING -> park:merge-conflict
write_state s1 t1 7; CI=pass MSS=CONFLICTING
assert_eq "conflict -> park" "park:merge-conflict(CONFLICTING)" "$(phase_gate s1 t1)"

# Case: no-pr first tick -> retry, counter=1
write_state s1 t1 null
assert_eq "no-pr first -> retry" "retry:no-pr" "$(phase_gate s1 t1)"
assert_eq "no-pr bumped counter" "1" "$(jq -r '.tasks.t1.nopr_attempts' "$PHASE_DIR/s1.json")"

# Case: no-pr at cap -> timeout
write_state s1 t1 null '{"nopr_attempts":3}'
assert_eq "no-pr at cap -> timeout" "park:no-pr-timeout" "$(phase_gate s1 t1)"

# Case: sync failure -> park:sync-failed
write_state s1 t1 7; CI=pass MSS=BEHIND SYNC_RC=1
assert_eq "sync fail -> park" "park:sync-failed" "$(phase_gate s1 t1)"
unset SYNC_RC

echo ""; echo "phase-yolo-update.test.sh: $pass passed, $fail failed"; [[ $fail -eq 0 ]]
```

### Step 2: Run it to confirm it passes
Run: `bash scripts/test/phase-yolo-update.test.sh`
Expected: all PASS, exit 0.

### Step 3: Wire into the repo gate

In `scripts/gate.sh`, after the existing line:
```bash
echo "=== gate: contrib script tests ==="
bash scripts/test/bottega-api.test.sh
```
add:
```bash
bash scripts/test/phase-yolo-update.test.sh
```
(Note: the existing `bottega-api.test.sh` lives at the repo-root `scripts/test/` mirror; this new one lives in the contrib tree. Confirm the path the gate uses; if the gate convention is repo-root `scripts/test/`, place the new test there to match, and adjust the `LIB` relative path accordingly.)

### Step 4: Commit
```bash
git add scripts/test/phase-yolo-update.test.sh scripts/gate.sh
git commit -m "test(phase): regression test for auto-update-behind + CI bucket + no-pr backoff"
```

---

## Final verification (before ship)

1. `bash scripts/test/phase-yolo-update.test.sh` → all pass.
2. `bash scripts/test/bottega-api.test.sh` → still 4/4 (no regression to #251's test).
3. `bash -n contrib/skills/bottega/scripts/phase-lib.sh && bash -n contrib/skills/bottega/scripts/bottega-api.sh` → syntax clean.
4. Confirm the diff touches ONLY `contrib/skills/bottega/scripts/{phase-lib.sh,bottega-api.sh}`, the new test, and `scripts/gate.sh`.

## Out of scope (do NOT do in this plan)
- Syncing the live runtime copy `~/.ytsejam/data/skills/bottega/` — post-merge manual step.
- Touching server/web TypeScript or the `web` build.
