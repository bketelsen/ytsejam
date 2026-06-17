# Bottega Sequence Shepherd — Implementation Plan

> Execute with the `develop` skill, task-by-task.

**Goal:** Add a client-side DAG runner ("sequence shepherd") to the existing `bottega` skill that fires a multi-task phase in dependency order, parking at each merge barrier, and — only under a per-run autonomous opt-in — auto-merges PRs that clear a 6-point safety gate.

**Spec:** `docs/plans/2026-06-17-bottega-sequence-shepherd-design.md`

**Architecture:** Zero Bottega changes. A YAML phase file + a JSON state file (SSOT) drive an idempotent `tick` that the `schedule` tool re-fires (~5 min) into a new session. Each tick: reconcile real Bottega/PR status → advance PRs (gate+merge if autonomous) → launch tasks whose deps are merged → write state, reschedule or finish. All mutating steps are guarded by the state file so a double-fire is harmless. The gate's `scripts/gate.sh` check runs **inside the bottega container** via `incus exec`.

**Tech Stack:** Bash (extends `contrib/skills/bottega/scripts/bottega-api.sh`), `jq` (state JSON), `yq`-or-fallback-parser (phase YAML), `gh` (PR merge), `incus exec` (container gate), the harness `schedule` tool (self-firing tick), `git merge-base` (stale-base gate #6).

**Worktree:** /tmp/bottega-sequence-shepherd

**Branch:** bottega-sequence-shepherd

---

## Conventions for this plan

This is **bash + skill-doc** work, not TypeScript — so the TDD "failing test" step is replaced by a **concrete verification command** per task (a dry-run invocation against a fixture state file or the real container, asserting observable output/exit). Each task ends by appending to a shell-based verification harness at `contrib/skills/bottega/test/phase.bats`-style checks — but since the repo has no bats, we use a plain `contrib/skills/bottega/test/verify-phase.sh` that runs assertions and exits non-zero on failure. The ytsejam `scripts/gate.sh` (npm workspaces) does not cover bash; `verify-phase.sh` is the shepherd's own gate and must pass before each commit.

**File map (everything lives under `contrib/skills/bottega/`):**
- `scripts/bottega-api.sh` — extend with the `phase` dispatch + helpers (MODIFY)
- `scripts/phase-lib.sh` — new: pure-ish functions (parse, state read/write, the 6-gate, tick steps) sourced by `bottega-api.sh` (CREATE)
- `test/verify-phase.sh` — new: the shepherd's verification harness (CREATE)
- `test/fixtures/` — new: sample phase YAML + state JSON for tests (CREATE)
- `SKILL.md` — document the phase feature (MODIFY)

---

## Task 1: Phase-file parse (YAML → normalized JSON)

**Files:**
- Create: `contrib/skills/bottega/scripts/phase-lib.sh`
- Create: `contrib/skills/bottega/test/fixtures/phase-sample.yaml`
- Create: `contrib/skills/bottega/test/verify-phase.sh`

#### Step 1: Write the fixture phase file
Create `test/fixtures/phase-sample.yaml`:
```yaml
phase: "Add rate limiting"
project: 1
autonomous: false
tasks:
  - key: schema
    title: "Add rate_limit columns + migration"
    brief: "Add columns"
  - key: middleware
    title: "Rate-limit middleware"
    brief: "Middleware"
    after: [schema]
  - key: docs
    title: "Document rate-limit config"
    brief: "Docs"
    after: [schema]
```

#### Step 2: Write `phase_parse` in `phase-lib.sh`
Implement `phase_parse <yaml-file>` → emits normalized JSON to stdout:
```bash
#!/usr/bin/env bash
# phase-lib.sh — sequence shepherd: parse / state / gate / tick. Sourced by bottega-api.sh.
# All functions are prefixed `phase_`. No global side effects on source.

# phase_parse <file> -> normalized phase JSON {phase,project,autonomous,tasks:{key:{key,title,brief,after[]}}}
phase_parse() {
  local f="$1"
  [ -f "$f" ] || { echo "phase file not found: $f" >&2; return 2; }
  if command -v yq >/dev/null 2>&1; then
    # yq (mikefarah) converts YAML->JSON; then jq normalizes tasks[] -> map keyed by .key
    yq -o=json '.' "$f" | jq '
      {phase, project, autonomous: (.autonomous // false),
       tasks: ( (.tasks // []) | map({(.key): {key, title, brief, after: (.after // [])}}) | add // {} )}'
  else
    echo "yq not found — install mikefarah yq (phase YAML needs it)" >&2
    return 3
  fi
}
```
> Decision: require `yq` (mikefarah) rather than hand-rolling a YAML parser — the design's "~15-line parser" fallback is YAGNI if `yq` is present; we assert its presence with a clear error. (Confirm yq availability in Step 4; if absent on the host, the fallback becomes its own follow-up task, not v1 scope.)

> **Amendment (2026-06-17, during develop):** the two-stage review of this task surfaced a latent foot-gun — `phase_parse` accepts any task `key` and emits it as a JSON object key, but downstream tick logic uses dot-literal jq paths (`.tasks.<key>.after[0]`) that silently resolve to `null` for a non-identifier key. Closed at the parse boundary: **task keys must match `^[a-z0-9_-]+$`**; any violation → exit **4**, one stderr line per offending key, no stdout JSON. Crucially, detection is **count-based** (`jq '[…|select(test(…)|not)]|length' > 0`), NOT shell string-emptiness of a newline-joined list — an empty-string key (`key: ""`) collapses such a list to `""` and slips a `[ -n "$bad" ]` test (a confirmed false-negative). Full exit-code contract: `0` ok · `2` missing file · `3` yq absent · `4` invalid key. Tests added: `phase-badkey.yaml` (dotted→4), `phase-emptykey.yaml` (empty→4), `phase-okkey.yaml` (`my_task-1`→0). Final commits: `70ef659` (guard) + `c2ad4f6` (empty-key/count-based). Good-path output byte-identical throughout.

#### Step 3: Write the verification harness `test/verify-phase.sh` with the first assertion
```bash
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

echo "---"; [ "$fails" -eq 0 ] && echo "verify-phase: ALL PASS" || { echo "verify-phase: $fails FAILED"; exit 1; }
```

#### Step 4: Run the harness — confirm parse works (and yq is present)
Run: `command -v yq && bash contrib/skills/bottega/test/verify-phase.sh`
Expected: yq path prints; all 6 parse checks `ok`; `verify-phase: ALL PASS`. If `yq` is absent, STOP and report — it's a host-dep decision.

#### Step 5: Commit
```bash
chmod +x contrib/skills/bottega/scripts/phase-lib.sh contrib/skills/bottega/test/verify-phase.sh
git add contrib/skills/bottega/scripts/phase-lib.sh contrib/skills/bottega/test/
git commit -m "feat(shepherd): phase-file YAML->JSON parse + verification harness"
```

---

## Task 2: State file — init, read, write, atomic update

**Files:**
- Modify: `contrib/skills/bottega/scripts/phase-lib.sh` (add state functions)
- Modify: `contrib/skills/bottega/test/verify-phase.sh` (add state assertions)

#### Step 1: Write state functions in `phase-lib.sh`
```bash
PHASE_DIR="${PHASE_DIR:-$HOME/.bottega/phases}"   # overridable for tests

phase_state_path() { echo "$PHASE_DIR/$1.json"; }

# phase_state_init <slug> <parsed-json> <scheduleId> -> writes initial state, all tasks pending
phase_state_init() {
  local slug="$1" parsed="$2" sched="${3:-}"
  mkdir -p "$PHASE_DIR"
  local p; p="$(phase_state_path "$slug")"
  echo "$parsed" | jq --arg sid "$sched" '{
    phase, project, autonomous, scheduleId: $sid,
    tasks: (.tasks | map_values({key, after, taskId: null, state: "pending", pr: null, reason: null})),
    log: []
  }' > "$p"
  echo "$p"
}

phase_state_read() { cat "$(phase_state_path "$1")"; }

# phase_state_write <slug> <json> — atomic (tmp+mv) so a crash mid-write never corrupts SSOT
phase_state_write() {
  local slug="$1" json="$2" p t
  p="$(phase_state_path "$slug")"; t="$(mktemp "${p}.XXXX")"
  echo "$json" | jq '.' > "$t" && mv "$t" "$p"
}

# phase_log <slug> <msg> — append-only audit line with timestamp
phase_log() {
  local slug="$1" msg="$2" j
  j="$(phase_state_read "$slug" | jq --arg m "$(date -Is): $msg" '.log += [$m]')"
  phase_state_write "$slug" "$j"
}

# phase_task_set <slug> <key> <jq-assignment> — mutate one task, atomic
phase_task_set() {
  local slug="$1" key="$2" assign="$3" j
  j="$(phase_state_read "$slug" | jq --arg k "$key" ".tasks[\$k] |= ($assign)")"
  phase_state_write "$slug" "$j"
}
```

#### Step 2: Add state assertions to `verify-phase.sh`
```bash
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
```

#### Step 3: Run harness
Run: `bash contrib/skills/bottega/test/verify-phase.sh`
Expected: all Task-1 + Task-2 checks `ok`; `ALL PASS`.

#### Step 4: Commit
```bash
git add contrib/skills/bottega/scripts/phase-lib.sh contrib/skills/bottega/test/verify-phase.sh
git commit -m "feat(shepherd): JSON state file — init/read/atomic-write/log/task-set"
```

---

## Task 3: Reconcile step (real Bottega + PR status → state truth)

**Files:**
- Modify: `contrib/skills/bottega/scripts/phase-lib.sh` (add `phase_reconcile`)
- Modify: `contrib/skills/bottega/test/verify-phase.sh` (add reconcile assertions with a mocked API)

#### Step 1: Write `phase_reconcile` — depends on two injectable lookups so it's testable
```bash
# These default to the live skill calls but are overridable for tests (dependency injection via env fn names).
# _phase_task_status <taskId> -> echoes a Bottega task JSON (must expose .pr_agent_complete, .workflow_blocked, .status, .pr number)
# _phase_pr_status <taskId> -> echoes {state, mergeable, ciStatus} or {exists:false}
phase_reconcile() {
  local slug="$1" j key tid st
  j="$(phase_state_read "$slug")"
  for key in $(echo "$j" | jq -r '.tasks | keys[]'); do
    tid="$(echo "$j" | jq -r ".tasks[\"$key\"].taskId")"
    st="$(echo "$j" | jq -r ".tasks[\"$key\"].state")"
    # only reconcile non-terminal, already-created tasks
    case "$st" in merged|parked|failed|pending) continue;; esac
    [ "$tid" = "null" ] && continue
    local ts; ts="$("${PHASE_TASK_STATUS_FN:-_phase_task_status_live}" "$tid")"
    local blocked pr_done; blocked="$(echo "$ts" | jq -r '.workflow_blocked // 0')"; pr_done="$(echo "$ts" | jq -r '.pr_agent_complete // 0')"
    if [ "$blocked" = "1" ]; then phase_task_set "$slug" "$key" '.state="parked" | .reason="workflow_blocked"'; continue; fi
    if [ "$pr_done" = "1" ]; then
      local prnum; prnum="$(echo "$ts" | jq -r '.pr_number // .pr // empty')"
      phase_task_set "$slug" "$key" ".state=\"pr_open\" | .pr=$([ -n "$prnum" ] && echo "$prnum" || echo null)"
    fi
  done
}
```
> Note: `_phase_task_status_live` / `_phase_pr_status_live` wrap the existing `bottega-api.sh` GETs; defined in Task 6 wiring. Reconcile is pure over its injected lookups, so tests stub them.

#### Step 2: Add reconcile assertions with stubbed status fns
```bash
# Task 3: reconcile (stub the Bottega lookups)
export PHASE_DIR="$(mktemp -d)"
phase_state_init recon "$J" "" >/dev/null
phase_task_set recon schema '.taskId=6 | .state="running"'
phase_task_set recon middleware '.taskId=7 | .state="running"'
_phase_task_status_live() { case "$1" in 6) echo '{"pr_agent_complete":1,"pr_number":231,"workflow_blocked":0}';; 7) echo '{"pr_agent_complete":0,"workflow_blocked":1}';; esac; }
export -f _phase_task_status_live
phase_reconcile recon
check "reconcile: schema -> pr_open" '[ "$(phase_state_read recon | jq -r .tasks.schema.state)" = "pr_open" ]'
check "reconcile: schema pr=231"     '[ "$(phase_state_read recon | jq -r .tasks.schema.pr)" = "231" ]'
check "reconcile: middleware parked (blocked)" '[ "$(phase_state_read recon | jq -r .tasks.middleware.state)" = "parked" ]'
rm -rf "$PHASE_DIR"; unset PHASE_DIR
```

#### Step 3: Run harness
Run: `bash contrib/skills/bottega/test/verify-phase.sh`
Expected: reconcile checks `ok`; `ALL PASS`.

#### Step 4: Commit
```bash
git add contrib/skills/bottega/scripts/phase-lib.sh contrib/skills/bottega/test/verify-phase.sh
git commit -m "feat(shepherd): reconcile step — Bottega/PR status -> state (injectable lookups)"
```

---

## Task 4: The 6-point autonomous merge gate (the riskiest surface — test hardest)

**Files:**
- Modify: `contrib/skills/bottega/scripts/phase-lib.sh` (add `phase_gate` + helpers)
- Modify: `contrib/skills/bottega/test/verify-phase.sh` (add gate assertions, esp. #6 stale-base)

#### Step 1: Write `phase_gate <slug> <key>` → echoes `pass` or `park:<reason>`
Implements ALL SIX checks in order; ANY fail → `park:<reason>` (never merge on doubt). Gate #1 runs `scripts/gate.sh` IN THE CONTAINER; gate #6 is the mechanical `git merge-base` stale-base/sibling-revert check.
```bash
# Injectable for tests: PHASE_GATE_CONTAINER_FN, PHASE_GATE_CI_FN, PHASE_GATE_MERGEBASE_FN
# Container gate: fetch PR branch into a throwaway worktree IN the container, run scripts/gate.sh, return exit.
_phase_container_gate_live() {  # <pr-branch> -> exit 0 pass / non-zero fail
  local br="$1"
  incus exec bottega -- su - code -c "
    set -e; cd ~/projects/ytsejam
    git fetch origin --quiet '$br' 2>/dev/null || git fetch origin --quiet
    wt=\$(mktemp -d); git worktree add -q \"\$wt\" 'origin/$br' 2>/dev/null || { rm -rf \"\$wt\"; exit 90; }
    ( cd \"\$wt\" && bash scripts/gate.sh ) ; rc=\$?
    git worktree remove --force \"\$wt\" 2>/dev/null; rm -rf \"\$wt\"; exit \$rc
  "
}

# Gate #6: files this PR changed ∩ files main gained since the task branch forked. Non-empty -> park.
_phase_stale_base_live() {  # <pr-branch> -> echoes intersecting files (empty = safe)
  incus exec bottega -- su - code -c "
    cd ~/projects/ytsejam; git fetch origin --quiet 2>/dev/null
    base=\$(git merge-base origin/main 'origin/$1' 2>/dev/null) || exit 0
    comm -12 \
      <(git diff --name-only \"\$base\" 'origin/$1' | sort -u) \
      <(git diff --name-only \"\$base\" origin/main | sort -u)
  "
}

phase_gate() {
  local slug="$1" key="$2" j tid pr br
  j="$(phase_state_read "$slug")"
  tid="$(echo "$j" | jq -r ".tasks[\"$key\"].taskId")"
  pr="$(echo "$j" | jq -r ".tasks[\"$key\"].pr")"
  [ "$pr" = "null" ] && { echo "park:no-pr"; return; }
  # resolve PR branch (live: gh; test: stub)
  br="$("${PHASE_PR_BRANCH_FN:-_phase_pr_branch_live}" "$pr")"
  # #2 CI + #3 MERGEABLE + #4 clean termination (from PR/task status)
  local ci mergeable blocked; read -r ci mergeable blocked < <("${PHASE_PR_META_FN:-_phase_pr_meta_live}" "$pr" "$tid")
  [ "$blocked" = "1" ] && { echo "park:workflow_blocked"; return; }
  [ "$ci" = "pass" ] || { echo "park:ci-$ci"; return; }
  [ "$mergeable" = "MERGEABLE" ] || { echo "park:not-mergeable($mergeable)"; return; }
  # #6 stale-base (mechanical, cheap — do before the expensive container gate)
  local clash; clash="$("${PHASE_STALE_BASE_FN:-_phase_stale_base_live}" "$br")"
  [ -n "$clash" ] && { echo "park:stale-base-overlap[$(echo "$clash" | tr '\n' ',' )]"; return; }
  # #1 container gate (expensive — last)
  if ! "${PHASE_CONTAINER_GATE_FN:-_phase_container_gate_live}" "$br"; then echo "park:gate-red"; return; fi
  # #5 intent-match is the human's judgment in default mode; in autonomous mode v1 we trust gate+stale-base
  echo "pass"
}
```
> Gate #5 (intent-match) is explicitly *judgment, no allowlist* per design. In v1 autonomous mode the mechanical backstops (#1 gate, #6 stale-base, #2 CI, #3 mergeable) carry the merge decision; the design's incident (#230) is caught by #6, not #5. This is documented in SKILL.md as the known limit.

#### Step 2: Gate assertions — drive every fail path + the pass path with stubs
```bash
# Task 4: gate — exercise each rejection + the pass
export PHASE_DIR="$(mktemp -d)"
phase_state_init g "$J" "" >/dev/null
phase_task_set g schema '.taskId=6 | .state="pr_open" | .pr=231'
export PHASE_PR_BRANCH_FN=_t_branch;     _t_branch() { echo "feat/schema"; }; export -f _t_branch
# all-green path
export PHASE_PR_META_FN=_t_meta_ok;      _t_meta_ok() { echo "pass MERGEABLE 0"; }; export -f _t_meta_ok
export PHASE_STALE_BASE_FN=_t_stale_no;  _t_stale_no() { echo ""; }; export -f _t_stale_no
export PHASE_CONTAINER_GATE_FN=_t_gate_ok; _t_gate_ok() { return 0; }; export -f _t_gate_ok
check "gate: all green -> pass"          '[ "$(phase_gate g schema)" = "pass" ]'
# CI red
export PHASE_PR_META_FN=_t_meta_cired;   _t_meta_cired() { echo "fail MERGEABLE 0"; }; export -f _t_meta_cired
check "gate: CI red -> park"             '[[ "$(phase_gate g schema)" == park:ci-* ]]'
# not mergeable
export PHASE_PR_META_FN=_t_meta_conf;    _t_meta_conf() { echo "pass CONFLICTING 0"; }; export -f _t_meta_conf
check "gate: conflict -> park"           '[[ "$(phase_gate g schema)" == park:not-mergeable* ]]'
# stale-base overlap (the #230 protection) — meta ok again
export PHASE_PR_META_FN=_t_meta_ok
export PHASE_STALE_BASE_FN=_t_stale_yes; _t_stale_yes() { printf "server/src/x.ts\n"; }; export -f _t_stale_yes
check "gate: stale-base overlap -> park" '[[ "$(phase_gate g schema)" == park:stale-base-overlap* ]]'
# container gate red — stale clear again
export PHASE_STALE_BASE_FN=_t_stale_no
export PHASE_CONTAINER_GATE_FN=_t_gate_red; _t_gate_red() { return 1; }; export -f _t_gate_red
check "gate: container gate red -> park" '[ "$(phase_gate g schema)" = "park:gate-red" ]'
rm -rf "$PHASE_DIR"; unset PHASE_DIR
```

#### Step 3: Run harness
Run: `bash contrib/skills/bottega/test/verify-phase.sh`
Expected: all 6 gate checks `ok` (pass path + 5 park paths); `ALL PASS`.

#### Step 4: Commit
```bash
git add contrib/skills/bottega/scripts/phase-lib.sh contrib/skills/bottega/test/verify-phase.sh
git commit -m "feat(shepherd): 6-point autonomous merge gate (container gate.sh + merge-base stale-base check)"
```

---

## Task 5: Launch-ready + advance-PRs + one full tick

**Files:**
- Modify: `contrib/skills/bottega/scripts/phase-lib.sh` (add `phase_launch_ready`, `phase_advance_prs`, `phase_tick_once`)
- Modify: `contrib/skills/bottega/test/verify-phase.sh` (add a full-tick assertion over stubs)

#### Step 1: Write the three functions
```bash
# ready set = pending tasks whose every `after` dep is merged
phase_launch_ready() {
  local slug="$1" j key
  j="$(phase_state_read "$slug")"
  for key in $(echo "$j" | jq -r '.tasks | keys[]'); do
    local st; st="$(echo "$j" | jq -r ".tasks[\"$key\"].state")"
    [ "$st" = "pending" ] || continue
    # every dep merged?
    local unmet; unmet="$(echo "$j" | jq -r --arg k "$key" '
      .tasks as $t | $t[$k].after[]? | select(($t[.].state // "pending") != "merged")' | head -1)"
    [ -n "$unmet" ] && continue
    # create + kickoff via injectable; mark running with returned id
    local title brief proj newid
    title="$(echo "$j" | jq -r ".tasks[\"$key\"].title // \"$key\"")"
    proj="$(echo "$j" | jq -r '.project')"
    newid="$("${PHASE_CREATE_FN:-_phase_create_live}" "$proj" "$key" "$title")"
    [ -n "$newid" ] && [ "$newid" != "null" ] || { phase_task_set "$slug" "$key" '.state="failed" | .reason="create-failed"'; continue; }
    "${PHASE_KICKOFF_FN:-_phase_kickoff_live}" "$newid" >/dev/null 2>&1 || true
    phase_task_set "$slug" "$key" ".taskId=$newid | .state=\"running\""
    phase_log "$slug" "launched $key as task $newid"
  done
}

# advance: for each pr_open, run gate; autonomous+pass -> merge -> merged; else leave/park
phase_advance_prs() {
  local slug="$1" j key auto
  j="$(phase_state_read "$slug")"; auto="$(echo "$j" | jq -r '.autonomous')"
  for key in $(echo "$j" | jq -r '[.tasks|to_entries[]|select(.value.state=="pr_open")|.key][]'); do
    [ "$auto" = "true" ] || continue   # default mode never merges
    local verdict; verdict="$(phase_gate "$slug" "$key")"
    if [ "$verdict" = "pass" ]; then
      local pr; pr="$(phase_state_read "$slug" | jq -r ".tasks[\"$key\"].pr")"
      if "${PHASE_MERGE_FN:-_phase_merge_live}" "$pr"; then
        phase_task_set "$slug" "$key" '.state="merged"'; phase_log "$slug" "merged $key (pr $pr)"
      else
        phase_task_set "$slug" "$key" '.state="parked" | .reason="merge-failed"'
      fi
    else
      phase_task_set "$slug" "$key" ".state=\"parked\" | .reason=\"$verdict\""; phase_log "$slug" "parked $key: $verdict"
    fi
  done
}

# one tick = reconcile -> advance -> launch -> (caller writes state already via mutators) -> report terminal?
phase_tick_once() {
  local slug="$1"
  phase_reconcile "$slug"
  phase_advance_prs "$slug"
  phase_launch_ready "$slug"
  # return 0 if all terminal (caller cancels schedule), 1 if work remains
  local remaining; remaining="$(phase_state_read "$slug" | jq -r '[.tasks[]|select(.state|IN("pending","created","running","pr_open"))]|length')"
  [ "$remaining" -eq 0 ]
}
```

#### Step 2: Full-tick assertion — schema merges, middleware+docs launch, then middleware opens PR
```bash
# Task 5: full tick over stubs (autonomous run)
export PHASE_DIR="$(mktemp -d)"
phase_state_init t "$(echo "$J" | jq '.autonomous=true')" "" >/dev/null
# create returns predictable ids; kickoff noop; gate passes; merge ok
ID=10; export PHASE_CREATE_FN=_t_create; _t_create() { echo $((ID++)); }; export -f _t_create
export ID
export PHASE_KICKOFF_FN=_t_kick; _t_kick() { :; }; export -f _t_kick
# Tick 1: only schema is ready (no deps) -> launches schema
phase_tick_once t || true
check "tick1: schema running"  '[ "$(phase_state_read t | jq -r .tasks.schema.state)" = "running" ]'
check "tick1: middleware still pending (dep unmet)" '[ "$(phase_state_read t | jq -r .tasks.middleware.state)" = "pending" ]'
# Simulate schema reaching pr_open then gate-pass merge on tick 2
phase_task_set t schema '.pr=231'
_phase_task_status_live() { echo '{"pr_agent_complete":1,"pr_number":231,"workflow_blocked":0}'; }; export -f _phase_task_status_live
export PHASE_PR_BRANCH_FN=_t_branch; _t_branch(){ echo b; }; export -f _t_branch
export PHASE_PR_META_FN=_t_meta; _t_meta(){ echo "pass MERGEABLE 0"; }; export -f _t_meta
export PHASE_STALE_BASE_FN=_t_sb; _t_sb(){ echo ""; }; export -f _t_sb
export PHASE_CONTAINER_GATE_FN=_t_cg; _t_cg(){ return 0; }; export -f _t_cg
export PHASE_MERGE_FN=_t_merge; _t_merge(){ return 0; }; export -f _t_merge
phase_tick_once t || true
check "tick2: schema merged"   '[ "$(phase_state_read t | jq -r .tasks.schema.state)" = "merged" ]'
check "tick2: middleware launched (dep met)" '[ "$(phase_state_read t | jq -r .tasks.middleware.state)" = "running" ]'
check "tick2: docs launched too (parallel)"  '[ "$(phase_state_read t | jq -r .tasks.docs.state)" = "running" ]'
# idempotency: re-running tick must not re-create or re-merge
B="$(phase_state_read t)"; phase_tick_once t || true
check "tick3: idempotent (no state churn on merged/running)" '[ "$(phase_state_read t | jq -r .tasks.schema.taskId)" = "$(echo "$B" | jq -r .tasks.schema.taskId)" ]'
rm -rf "$PHASE_DIR"; unset PHASE_DIR
```

#### Step 3: Run harness
Run: `bash contrib/skills/bottega/test/verify-phase.sh`
Expected: all tick checks `ok` — especially **tick2 dependency release** (middleware+docs launch only after schema merges) and **tick3 idempotency**. `ALL PASS`.

#### Step 4: Commit
```bash
git add contrib/skills/bottega/scripts/phase-lib.sh contrib/skills/bottega/test/verify-phase.sh
git commit -m "feat(shepherd): launch-ready + advance-PRs + idempotent phase_tick_once"
```

---

## Task 6: Live wiring in `bottega-api.sh` + self-scheduling + SKILL.md

**Files:**
- Modify: `contrib/skills/bottega/scripts/bottega-api.sh` (source phase-lib; add `phase` dispatch; define the `*_live` lookups)
- Modify: `contrib/skills/bottega/SKILL.md` (document the feature)

#### Step 1: Define the `_live` lookups + `phase` dispatch in `bottega-api.sh`
After the existing helpers, source the lib and add the live wrappers (each wraps an existing `api`/`gh` call):
```bash
. "$(dirname "${BASH_SOURCE[0]}")/phase-lib.sh"

_phase_task_status_live() { api GET "/api/tasks/$1" | task_obj; }
_phase_pr_branch_live()   { api GET "/api/tasks/$(_phase_taskid_for_pr "$1")/pull-request" | jq -r '.headRefName // .branch // empty'; }
# meta: "ci mergeable blocked" — derive from PR + task status
_phase_pr_meta_live() {  # <pr> <taskId>
  local pr="$1" tid="$2" prj tj
  prj="$(api GET "/api/tasks/$tid/pull-request")"
  tj="$(api GET "/api/tasks/$tid" | task_obj)"
  echo "$(echo "$prj" | jq -r '.ciStatus.status // "unknown"') $(echo "$prj" | jq -r '.mergeable // "UNKNOWN"') $(echo "$tj" | jq -r '.workflow_blocked // 0')"
}
_phase_create_live()  { create_task "$1" "$3" "(brief carried in phase file)"; }   # reuse existing create
_phase_kickoff_live() { api POST "/api/tasks/$1/agent-runs" "$(jq -n '{agentType:"planification"}')" >/dev/null; }
_phase_merge_live()   { gh pr merge "$1" --repo bketelsen/ytsejam --squash --delete-branch; }
# container gate + stale-base already defined as *_live in phase-lib.sh
```
> Note for implementer: the existing `create` subcommand logic must be refactored into a callable `create_task <proj> <title> <brief>` function so `_phase_create_live` reuses it (DRY) — do this refactor as part of this step, keeping the `create)` case calling the new function so existing behavior is unchanged. The brief per task comes from the phase file's `brief:` (resolve `@file` through the existing doc-verify guard).

#### Step 2: Add the `phase` dispatch (the user-facing verbs)
```bash
  phase)
    sub="${1:-}"; shift || true
    case "$sub" in
      run)   # run <file> [--autonomous]
        file="$1"; auto=false; [ "${2:-}" = "--autonomous" ] && auto=true
        slug="$(basename "$file" | sed 's/\.[^.]*$//')"
        parsed="$(phase_parse "$file")" || exit $?
        [ "$auto" = true ] && parsed="$(echo "$parsed" | jq '.autonomous=true')"
        # register the self-firing tick FIRST so its id lands in state
        sid="$(_phase_schedule_register "$slug")"
        sp="$(phase_state_init "$slug" "$parsed" "$sid")"
        echo "phase '$slug' started (autonomous=$auto). state: $sp  schedule: $sid"
        phase_tick_once "$slug" && _phase_schedule_cancel "$sid"   # immediate first tick; cancel if already done
        bash "$0" phase status "$slug" ;;
      tick)  slug="$1"; phase_tick_once "$slug" && { sid="$(phase_state_read "$slug" | jq -r .scheduleId)"; [ -n "$sid" ] && _phase_schedule_cancel "$sid"; echo "phase $slug COMPLETE"; } || echo "phase $slug: work remains" ;;
      status) slug="$1"; phase_state_read "$slug" | jq -r '
        "phase: \(.phase)  autonomous: \(.autonomous)",
        (.tasks | to_entries[] | "  \(.key): \(.value.state)\(if .value.pr then "  pr#\(.value.pr)" else "" end)\(if .value.reason then "  [\(.value.reason)]" else "" end)")' ;;
      cancel) slug="$1"; sid="$(phase_state_read "$slug" | jq -r .scheduleId)"; [ -n "$sid" ] && _phase_schedule_cancel "$sid"; echo "phase $slug cancelled (PRs left as-is)" ;;
      *) echo "usage: $0 phase {run <file> [--autonomous]|tick <slug>|status <slug>|cancel <slug>}" >&2; exit 2 ;;
    esac ;;
```

#### Step 3: Schedule register/cancel — bridge to the harness `schedule` tool
The shepherd's tick is re-fired by the harness `schedule` tool, which the **agent** owns (not the bash script). Document the contract: `phase run` PRINTS the schedule request for the agent to execute; the script cannot call the harness tool directly.
```bash
# The bash layer cannot invoke the harness `schedule` tool. It emits a directive the agent acts on.
_phase_schedule_register() {  # echoes a placeholder id; the AGENT replaces it by scheduling a cron that runs `phase tick <slug>` into a new session every ~5 min
  echo "PENDING-AGENT-SCHEDULE"
}
_phase_schedule_cancel() { echo "AGENT: cancel schedule $1" >&2; }
```
> This is the honest seam: the SKILL.md instructs the agent that after `phase run`, it MUST register a `schedule` (cron `*/5 * * * *`, target new_session, prompt = "run `bottega-api.sh phase tick <slug>` and report if COMPLETE/parked") and write that schedule's real id into the state via `phase_task_set`-style patch. The final tick tells the agent to cancel it. v1 keeps the scheduler in the agent's hands, not buried in bash — matches how the harness works.

#### Step 4: Write the SKILL.md section
Add a `## Phase sequences (multi-task dependency runner)` section to `SKILL.md` covering: the phase-file YAML shape (with the `key`/`after`/`brief` fields), the two launch modes (`phase run` parks at barriers; `--autonomous` auto-merges through the gate), the 6-point gate (emphasis: gate #1 runs in the container, #6 is the stale-base protection from the #230 incident), the agent's scheduling responsibility (register cron after `run`, cancel on COMPLETE), the `status`/`cancel` verbs, and **the escape hatch**: "when the chain is tightly coupled (later steps need earlier steps' code in the same branch), use ONE big Bottega task with a 'do A then B then C' brief instead — the shepherd is for independently-mergeable PRs."

#### Step 5: Verify the dispatch end-to-end (dry, against a fixture — no real tasks created)
Run:
```bash
# parse + status path works against a fixture, with create/kickoff stubbed so nothing real is created
PHASE_DIR="$(mktemp -d)" \
PHASE_CREATE_FN=true PHASE_KICKOFF_FN=true \
bash contrib/skills/bottega/scripts/bottega-api.sh phase status nonexistent 2>&1 | grep -q "No such file\|phase:" && echo "dispatch reachable"
bash contrib/skills/bottega/test/verify-phase.sh
```
Expected: `verify-phase: ALL PASS` (all prior tasks still green after the refactor), and the `phase` dispatch is reachable. Then run the full ytsejam gate to confirm no repo regression: `bash scripts/gate.sh` → exit 0.

#### Step 6: Commit
```bash
git add contrib/skills/bottega/scripts/bottega-api.sh contrib/skills/bottega/SKILL.md
git commit -m "feat(shepherd): live wiring (phase run/tick/status/cancel) + agent-owned scheduling + SKILL.md"
```

---

## Final verification (before ship)

1. `bash contrib/skills/bottega/test/verify-phase.sh` → `ALL PASS` (every task's checks).
2. `bash scripts/gate.sh` → exit 0 (ytsejam repo unregressed — the change is skill-only, must not touch server/web/ltm).
3. `bash -n` on both shell files (syntax).
4. Re-read the diff: only `contrib/skills/bottega/` files touched (+ the 2 prior commits' design/retarget). Nothing in `server/`, `web/`, `ltm/`.
5. Sync the live skill copy: the host's `~/.ytsejam/data/skills/bottega/` is the runtime copy — note in ship that it must be re-synced from `contrib/` after merge (or document the sync command), else the new `phase` verbs won't be live.

## Known limits (documented, not bugs)
- Gate #5 (intent-match) is human judgment; autonomous v1 leans on the mechanical gates (#1/#2/#3/#6). The #230-class revert is caught by #6, not #5.
- Scheduling lives in the agent (harness `schedule` tool), not the bash script — `phase run` emits the directive; the agent registers/cancels the cron. This is the honest seam between a bash skill and an agent-owned tool.
- `yq` (mikefarah) is required for phase-file parsing; absence is a clear error, not a silent fallback (the ~15-line YAML parser is a follow-up only if a yq-less host appears).
- The phase brief's `@file` resolution reuses the existing doc-verify guard; per-task briefs are read from the phase file at launch.

---

## Amendment — what the build actually produced (2026-06-17)

All 6 tasks shipped on branch `bottega-sequence-shepherd` (base→`38dcc6e`, 22 commits ahead of main). Deltas from the reference code above, recorded for the next reader:

- **Task 4 lesson published** (`4cb58a1`, `docs/agents/testing.md` "Adversarially Probe Stubbed-Out Helper Bodies") — the 6-point gate's live-helper bodies were stub-injected for tests; the lesson is to adversarially probe such stubbed bodies. Task 4 also hardened the gate beyond the reference: F1 caller-side branch-name charset allowlist, F2 strict 3-token meta parse (`^[01]$` on blocked), F3 capture-each-diff-then-`comm` in `_phase_stale_base_live`.
- **Task 5 jq-injection fix** — `phase_task_set_str <slug> <key> <field> <value>` binds values via `--arg` (never weaves a verdict/reason/upstream string into a jq PROGRAM); the reference's `.reason="$verdict"` was injectable. Reads are rc-guarded; `phase_tick_once` guards the final read against an integer-expr crash; vestigial `created` state dropped.
- **Task 5 chatty-gate fix** (`a438f7f`, lesson `4755c32` `docs/agents/tooling.md` "A Captured Status Token Is Poisoned By A Child's Stdout") — `phase_gate` runs the container gate WITHOUT capturing its stdout, so a chatty-but-passing `gate.sh` leaked its `=== gate: PASSED ===` lines into `phase_gate`'s stdout, and `phase_advance_prs`'s exact-equality `[ "$verdict" = "pass" ]` would false-park EVERY autonomous merge. Fix: reduce verdict to its LAST line + require gate rc==0. Without this the autonomous feature was dead-on-arrival.
- **Task 6 corrections to the reference** — the plan's `_phase_pr_branch_live` called an UNDEFINED `_phase_taskid_for_pr`; the build defines a real pr→tid resolver (scan `/api/tasks` for matching `.pr_number`). `_phase_pr_meta_live` guards every api/jq read (reference left them unguarded) and emits exactly 3 tokens, fail-closed. A PR-number sink guard (`^[0-9]+$`) was added to `phase_advance_prs` before the live `gh pr merge` (defense-in-depth; the only phase-lib.sh edit in Task 6). `create)` was refactored DRY into `create_task` (emits id only; CLI messaging preserved). Per-task `brief` could NOT thread through the frozen `(proj,key,title)` create signature → v1 seeds brief from title (`# ponytail:`); richer `@file` briefs are a follow-up.
- **Scheduling seam** — the bash layer cannot call the harness `schedule` tool; `phase run` emits `PENDING-AGENT-SCHEDULE` and SKILL.md instructs the AGENT to register a `*/5` cron (new_session) running `phase tick <slug>` and cancel it on COMPLETE.
- **Harness** grew to 84 checks; runs clean-env (`env -i`) with `gh`/`incus`/`curl` shadowable — a leak-sentinel run confirmed ZERO live calls fire during tests.

### NOT YET DONE (post-build, operator-gated)
- **Live smoke-test** — one real `phase` tick against the container culminating in a real `gh pr merge` of a throwaway PR. Deliberately NOT run by any subagent; operator + assistant run it together. Container `origin/main` has moved (4+ real Bottega PRs merged) — re-read the live main head at smoke-test time; gate #6 (stale-base) compares against current main.
- **Skill sync** — after merge, re-sync the runtime copy `~/.ytsejam/data/skills/bottega/` from `contrib/` (else the `phase` verbs aren't live).
- **Merge of this branch** — ALWAYS the operator's call.
