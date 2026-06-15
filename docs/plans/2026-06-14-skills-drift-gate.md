# Skills Drift Gate Implementation Plan

> Execute with the `develop` skill, task-by-task.

**Goal:** Add a deploy-time drift check that aborts when a release's seeded skills differ from the live runtime copies, so the `COPYFILE_EXCL` "user-dir wins" contract can't silently swallow a seed change (the failure mode that bit PR #138 across a 3-day window).

**Spec:** This plan (no separate design doc — the audit report from subagent task `019ec89e` 2026-06-14 is the design analysis; recommendation (E) was approved with `plan-with-defaults` defaults baked in below).

**Architecture:** Two small bash artifacts. (1) `scripts/check-skills-drift.sh` — a stateless diff utility that compares a release's `server/skills/{*.md,*/SKILL.md}` against the live `~/.ytsejam/data/skills/` for **seeded names only**. Exits 0 if no drift; exits 1 with a loud report if drift exists (no rollback action — fail-loud only). (2) Two thin call sites: `deploy.sh` invokes it as a hard abort between section 2 (build done) and section 3 (symlink swap), respecting `ALLOW_SKILL_DRIFT=1` to override; `deploy/sync-skills.sh --yes` copies the seeded files from the latest release dir over the live ones, named-seeds only (dir-bundles untouched). Bash-only, no new runtime dependencies, matches the existing `scripts/test/*.test.sh` pattern for regression coverage.

**Tech Stack:** bash, diff, find, the existing `scripts/test/` harness pattern (exit codes + stdout/stderr assertions, no external test runner).

**Worktree:** /tmp/skills-drift-gate

**Branch:** feat/skills-drift-gate

**Approved defaults (plan-with-defaults):**
1. **Trigger point:** in `deploy.sh`, between section 2 (build verified) and section 3 (symlink swap). Release is built but not live — safest abort point; rollback is "throw away the release dir."
2. **Override mechanism:** `ALLOW_SKILL_DRIFT=1` env var. CI-friendly, audit-trail-friendly. No interactive prompt (deploy is sometimes piped from automation).
3. **Sync command shape:** separate script `deploy/sync-skills.sh`. Default is dry-run (prints diff, exits 0). `--yes` flag commits the copy. Reads seeded names from the latest release dir (`~/.ytsejam/current/server/skills/`).
4. **Dir-bundle handling:** ignored in this PR. No seed bundles exist today (the audit confirmed `server/skills/UPSTREAM` and 7 flat seeds; all 17 dir-bundles are live-only). Wire only flat-seed diffs. If a future PR adds seed bundles, extend the gate then.
5. **Failure mode:** abort with exit 1. Drift report printed to stderr with seed path, live path, and `diff -u` excerpt.
6. **Coupling:** ship the drift gate alone in this PR. The `migrate-data.sh` dir-bundle gap (action item) is a separate concern (different script, different code path, different blast radius); fix it in its own PR.

---

### Task 1: Write the drift checker script

**Files:**
- Create: `scripts/check-skills-drift.sh`

#### Step 1: Write the script

Create `scripts/check-skills-drift.sh` with this content:

```bash
#!/usr/bin/env bash
# Compare seeded skills in a release dir against the live runtime skills dir.
#
# Surfaces the seed→live drift that the COPYFILE_EXCL seeder ignores by
# design (see server/skills/UPSTREAM and docs/agents/skills.md). When a PR
# updates a seeded skill but the live copy already exists, the seeder skips
# the copy and the new behavior never reaches runtime. This script makes
# that drift loud at deploy time so the operator decides explicitly.
#
# Usage:
#   bash scripts/check-skills-drift.sh <release-skills-dir> <live-skills-dir>
#
# Exit codes:
#   0  no drift on any seeded name (live missing is fine — seeder will copy it on next boot)
#   1  one or more seeded names have differing content live
#   2  bad arguments
#
# Scope: flat `<name>.md` seeds only. Dir-bundle seeds (`<name>/SKILL.md`)
# are not compared because none exist today; extend when one is added.

set -euo pipefail

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <release-skills-dir> <live-skills-dir>" >&2
  exit 2
fi

SEED_DIR="$1"
LIVE_DIR="$2"

[[ -d "$SEED_DIR" ]] || { echo "seed dir not found: $SEED_DIR" >&2; exit 2; }
[[ -d "$LIVE_DIR" ]] || { echo "live dir not found: $LIVE_DIR" >&2; exit 2; }

drift_count=0
drift_names=()

# Iterate over flat seed files only (dir-bundles intentionally skipped).
shopt -s nullglob
for seed_file in "$SEED_DIR"/*.md; do
  name="$(basename "$seed_file")"
  live_file="$LIVE_DIR/$name"

  # Live missing is fine — boot will seed it via COPYFILE_EXCL.
  [[ -f "$live_file" ]] || continue

  if ! diff -q "$seed_file" "$live_file" > /dev/null 2>&1; then
    drift_count=$((drift_count + 1))
    drift_names+=("$name")
  fi
done

if [[ $drift_count -eq 0 ]]; then
  echo -e "${GREEN}✓${NC} no seeded-skill drift between $SEED_DIR and $LIVE_DIR"
  exit 0
fi

# Loud report on stderr so it survives stdout capture.
{
  echo ""
  echo -e "${RED}✗ skill drift detected: $drift_count seeded skill(s) differ from live${NC}"
  echo ""
  echo "  seed dir: $SEED_DIR"
  echo "  live dir: $LIVE_DIR"
  echo ""
  for name in "${drift_names[@]}"; do
    echo -e "${YELLOW}── $name ──${NC}"
    diff -u "$LIVE_DIR/$name" "$SEED_DIR/$name" | head -40 || true
    echo ""
  done
  echo "Resolve before deploying:"
  echo "  1. Sync seeds → live:    bash deploy/sync-skills.sh --yes"
  echo "  2. Override (use sparingly): ALLOW_SKILL_DRIFT=1 deploy/deploy.sh"
  echo ""
} >&2

exit 1
```

Then `chmod +x scripts/check-skills-drift.sh`.

#### Step 2: Sanity-check the script runs

```bash
bash scripts/check-skills-drift.sh
```

Expected: exit 2, stderr `usage: ...`.

```bash
bash scripts/check-skills-drift.sh /tmp/nope /tmp/nope2
```

Expected: exit 2, stderr `seed dir not found: /tmp/nope`.

#### Step 3: Commit

```bash
git add scripts/check-skills-drift.sh
git commit -m "feat(deploy): add check-skills-drift.sh — fail-loud diff utility for seed→live drift"
```

---

### Task 2: Write the regression test for the checker

**Files:**
- Create: `scripts/test/check-skills-drift.test.sh`

#### Step 1: Write the test

Mirror the existing `check-doc-links.test.sh` style — bash-only, exit codes + stdout/stderr assertions, temp dirs:

```bash
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
mkdir -p "$WORK/c7"
run_case "no args → exit 2" 2 "usage:" "$WORK/c7" "$WORK/c7"  # this run is ignored since args present; do bare call below
out="$(mktemp)"; err="$(mktemp)"
set +e; bash "$CHECK_SCRIPT" >"$out" 2>"$err"; rc=$?; set -e
if [[ "$rc" == 2 ]] && grep -qF "usage:" "$err"; then pass=$((pass+1)); else echo "FAIL [no-args]: rc=$rc" >&2; fail=$((fail+1)); fi
rm -f "$out" "$err"

# Case 8: missing seed dir
run_case "missing seed dir → exit 2" 2 "seed dir not found" "/tmp/nope-$$-seed" "$WORK/c1/live"

# Case 9: missing live dir
run_case "missing live dir → exit 2" 2 "live dir not found" "$WORK/c1/seed" "/tmp/nope-$$-live"

echo ""
echo "passed: $pass"
echo "failed: $fail"
[[ $fail -eq 0 ]]
```

Note: Case 7's `run_case` line with non-empty args is a placeholder retained for symmetry but doesn't actually test no-args (the real no-args test is the bare bash call below it).

#### Step 2: Run the test, expect all-pass

```bash
bash scripts/test/check-skills-drift.test.sh
```

Expected: `passed: 10  failed: 0`, exit 0.

#### Step 3: Commit

```bash
git add scripts/test/check-skills-drift.test.sh
git commit -m "test(deploy): regression tests for check-skills-drift.sh"
```

---

### Task 3: Wire the drift check into `deploy.sh`

**Files:**
- Modify: `deploy/deploy.sh` (insert between section 2 build verification and section 3 symlink swap)

#### Step 1: Insert the drift check section

Open `deploy/deploy.sh`. After the existing line:

```bash
[[ -f "$RELEASE_DIR/server/src/index.ts" ]] || die "server entry missing: $RELEASE_DIR/server/src/index.ts"
```

And **before** the existing line:

```bash
# ─── 3. Swap symlinks atomically (save previous for rollback) ───
```

Insert this new section (with a blank line separator on each side):

```bash

# ─── 2b. Drift gate — seeded skills must match live before we go live ───
# Why: SkillsStore.seed() (server/src/skills.ts) is COPYFILE_EXCL — it copies a
# seed into the live data dir ONLY when the live file is missing. If a PR
# updates a seeded skill but the live copy already exists, the new behavior
# never reaches the runtime. This gate catches that drift before the symlink
# swap; the release dir is built and verified but not yet live, so abort is
# free (the prepared release just isn't activated).
LIVE_SKILLS_DIR="$YTSEJAM_HOME/data/skills"
RELEASE_SKILLS_DIR="$RELEASE_DIR/server/skills"

if [[ -d "$LIVE_SKILLS_DIR" ]]; then
  if ! bash "$SOURCE_DIR/scripts/check-skills-drift.sh" "$RELEASE_SKILLS_DIR" "$LIVE_SKILLS_DIR"; then
    if [[ "${ALLOW_SKILL_DRIFT:-0}" == "1" ]]; then
      warn "ALLOW_SKILL_DRIFT=1 set — proceeding past skill drift"
    else
      die "Refusing to deploy with skill drift. Run 'bash deploy/sync-skills.sh --yes' to sync seeds → live, or set ALLOW_SKILL_DRIFT=1 to override."
    fi
  fi
else
  log "No live skills dir yet — skipping drift gate (first deploy)"
fi
```

#### Step 2: Visually verify the diff

```bash
git diff deploy/deploy.sh
```

Confirm: only one hunk added; no other lines mutated; new section sits between the two existing markers.

#### Step 3: Smoke-test the gate manually (no real deploy)

Set up a mock scenario and run the check directly:

```bash
# Create a fake release dir that matches what deploy.sh would have
MOCK_RELEASE="$(mktemp -d)"
mkdir -p "$MOCK_RELEASE/server/skills"
cp "$HOME/.ytsejam/current/server/skills/"*.md "$MOCK_RELEASE/server/skills/"
echo "drift!" >> "$MOCK_RELEASE/server/skills/reflect.md"

# Now run the same call deploy.sh would run, expect exit 1
bash scripts/check-skills-drift.sh "$MOCK_RELEASE/server/skills" "$HOME/.ytsejam/data/skills"
```

Expected: exit 1, stderr contains `── reflect.md ──` and the override hint.

Cleanup: `rm -rf "$MOCK_RELEASE"`.

#### Step 4: Commit

```bash
git add deploy/deploy.sh
git commit -m "feat(deploy): gate deploy on seeded-skill drift between release and live"
```

---

### Task 4: Write `deploy/sync-skills.sh`

**Files:**
- Create: `deploy/sync-skills.sh`

#### Step 1: Write the script

```bash
#!/usr/bin/env bash
# Sync seeded skills from the current release dir over the live runtime dir.
#
# Resolves the drift that `check-skills-drift.sh` flags: copies each seeded
# `<name>.md` from the release seed dir over the matching live file. Live
# files that have no seed counterpart (generated domain skills, user-added
# dir-bundles, etc.) are NEVER touched.
#
# Usage:
#   bash deploy/sync-skills.sh           # dry-run (print what would change, exit 0)
#   bash deploy/sync-skills.sh --yes     # actually copy
#
# Reads from $YTSEJAM_HOME/current/server/skills (the active release's seed dir)
# Writes to $YTSEJAM_HOME/data/skills (the live runtime dir)
#
# Override paths via env vars:
#   YTSEJAM_HOME       deploy root        (default ~/.ytsejam)
#   SEED_DIR           seed source        (default $YTSEJAM_HOME/current/server/skills)
#   LIVE_DIR           live destination   (default $YTSEJAM_HOME/data/skills)

set -euo pipefail

YTSEJAM_HOME="${YTSEJAM_HOME:-$HOME/.ytsejam}"
SEED_DIR="${SEED_DIR:-$YTSEJAM_HOME/current/server/skills}"
LIVE_DIR="${LIVE_DIR:-$YTSEJAM_HOME/data/skills}"

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'
log()  { echo -e "${GREEN}▸${NC} $*"; }
warn() { echo -e "${YELLOW}▸${NC} $*"; }
die()  { echo -e "${RED}✗${NC} $*" >&2; exit 1; }

[[ -d "$SEED_DIR" ]] || die "seed dir not found: $SEED_DIR"
[[ -d "$LIVE_DIR" ]] || die "live dir not found: $LIVE_DIR"

APPLY=0
case "${1:-}" in
  --yes|-y) APPLY=1 ;;
  ""|--dry-run) APPLY=0 ;;
  -h|--help)
    echo "usage: $0 [--yes|--dry-run]"
    exit 0
    ;;
  *) die "unknown arg: $1 (try --yes or --dry-run)" ;;
esac

would_copy=0
shopt -s nullglob
for seed_file in "$SEED_DIR"/*.md; do
  name="$(basename "$seed_file")"
  live_file="$LIVE_DIR/$name"

  # Live missing: not drift, skip (boot will seed it).
  [[ -f "$live_file" ]] || continue

  # Identical: no work.
  diff -q "$seed_file" "$live_file" > /dev/null 2>&1 && continue

  would_copy=$((would_copy + 1))
  if [[ $APPLY -eq 1 ]]; then
    log "syncing $name"
    cp "$seed_file" "$live_file"
  else
    warn "would sync $name (use --yes to apply)"
  fi
done

if [[ $would_copy -eq 0 ]]; then
  log "no drift — nothing to sync"
elif [[ $APPLY -eq 1 ]]; then
  log "synced $would_copy seeded skill(s)"
else
  echo ""
  warn "dry-run: $would_copy seeded skill(s) would be synced; re-run with --yes to apply"
fi
```

Then `chmod +x deploy/sync-skills.sh`.

#### Step 2: Sanity-test against the live tree

```bash
bash deploy/sync-skills.sh
```

Expected: exit 0, stdout `no drift — nothing to sync` (the live tree is currently in-sync after today's manual copies; if any drift slipped in between then and now, the script will report it as a `would sync` line).

#### Step 3: Test the bad-arg path

```bash
bash deploy/sync-skills.sh --bogus
```

Expected: exit 1, stderr `unknown arg: --bogus`.

#### Step 4: Commit

```bash
git add deploy/sync-skills.sh
git commit -m "feat(deploy): add sync-skills.sh — dry-run by default, --yes copies seeds over drifted live files"
```

---

### Task 5: Document the new contract

**Files:**
- Modify: `docs/agents/skills.md` (add a section explaining the gate + sync flow)
- Modify: `deploy/README.md` (one-line cross-reference to the new scripts)
- Modify: `server/skills/UPSTREAM` (cross-reference the sync command)

#### Step 1: Update `docs/agents/skills.md`

Find the existing section that documents `SkillsStore.seed()` and the COPYFILE_EXCL behavior. Append a new subsection after it:

```markdown
## Drift gate (deploy-time)

The COPYFILE_EXCL seeding rule means a PR that updates a seeded skill (e.g.
`server/skills/reflect.md`) does NOT update the live copy at
`~/.ytsejam/data/skills/reflect.md` if the live file already exists. Without
a check, the new behavior never reaches the runtime and the release silently
"activates" stale code.

`deploy/deploy.sh` runs `scripts/check-skills-drift.sh` between the release
build and the symlink swap. If any seeded `<name>.md` differs from its live
counterpart, the deploy aborts with a `diff -u` excerpt per drifted file.

To resolve drift before deploying:

```bash
bash deploy/sync-skills.sh           # dry-run: list what would change
bash deploy/sync-skills.sh --yes     # apply: copy seeds over drifted live files
```

`sync-skills.sh` only touches seeded names. Generated domain-routing skills
(written by `/cog setup` to the live dir only) and user dir-bundles (e.g.
`brainstorm/SKILL.md`) are never compared and never copied — they have no
seed counterpart.

To override the gate without resolving the drift (e.g. when the live
divergence is intentional and the operator accepts the risk):

```bash
ALLOW_SKILL_DRIFT=1 bash deploy/deploy.sh
```

This is rare and should be justified in a commit message or follow-up note.
```

#### Step 2: Add a cross-reference to `deploy/README.md`

Find a reasonable spot near where `deploy.sh` is documented and add a one-line bullet:

```markdown
- `deploy/sync-skills.sh` — copy seeded skills from the active release dir
  over drifted live copies. Dry-run by default; pass `--yes` to apply. The
  drift gate inside `deploy.sh` will tell you when this is needed.
```

#### Step 3: Add a cross-reference to `server/skills/UPSTREAM`

Append at the end of the existing UPSTREAM file (which was just rewritten in #167):

```
Operator workflow to activate a seed change on a running instance without
restart:

  bash deploy/sync-skills.sh --yes

This is the supported sync path; the deploy-time drift gate will block any
release that has not been synced.
```

#### Step 4: Run doc-link check (precedent from the test harness)

```bash
bash scripts/check-doc-links.sh docs/agents/skills.md deploy/README.md
```

Expected: exit 0.

#### Step 5: Commit

```bash
git add docs/agents/skills.md deploy/README.md server/skills/UPSTREAM
git commit -m "docs(skills): document the deploy-time drift gate and sync-skills.sh workflow"
```

---

### Task 6: Final gate + push

#### Step 1: Run the full gate

```bash
bash scripts/gate.sh
```

Expected: `=== gate: PASSED ===`, 142 tests pass (the new bash-only test is run via `scripts/test/` not the vitest gate — confirm in step 2).

#### Step 2: Run the new bash regression test explicitly

```bash
bash scripts/test/check-skills-drift.test.sh
```

Expected: `passed: 10  failed: 0`, exit 0.

If the gate doesn't auto-run `scripts/test/*.test.sh`, that's a separate weed — log it but do not fix in this PR.

#### Step 3: Push the branch

```bash
git push -u origin feat/skills-drift-gate
```

#### Step 4: Open the PR

```bash
gh pr create --title "feat(deploy): skills drift gate — abort deploy when seeded skills differ from live" --body "[fill in from the PR template — Goal, Why, What, Verification, Rollback]" --base main
```

---

## Verification gates

- Each task ends with its own commit; per-task review (spec compliance + code quality) runs via the `develop`/`review` skill loop.
- Final gate is `bash scripts/gate.sh` + `bash scripts/test/check-skills-drift.test.sh`.
- Manual smoke (Task 3 Step 3) confirms the gate fires on a synthetic drift case before symlink swap.

## Rollback

Each task is its own commit; revert individual commits if a problem surfaces. Full PR rollback: `git revert <merge-commit>`.

## Out of scope

- `migrate-data.sh` dir-bundle gap (separate action item — different script, different surface).
- `server/src/config.ts` repo-CWD safety check (separate item — config-layer prevention vs. operational-layer gate).
- Auto-sync on deploy (rejected per recommendation E — would silently clobber user customizations).
- Dir-bundle drift detection (none exist as seeds today; extend the script when one is added).
