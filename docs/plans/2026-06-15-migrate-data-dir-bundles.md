# Plan: migrate-data.sh — handle dir-bundle skills

**Branch:** `migrate-data-dir-bundles`
**Worktree:** `/tmp/migrate-data-dir-bundles`
**Base:** `7d1da36` (main as of 2026-06-15)

## Context

`deploy/migrate-data.sh` walks skills only at `find -maxdepth 1 -type f -name '*.md'`. The live data dir has 17 dir-bundle skills (`brainstorm/SKILL.md`, `develop/SKILL.md`, `ship/SKILL.md`, `ponytail/SKILL.md`, `find-weeds/SKILL.md`, `pull-weeds/SKILL.md`, `pkb-research/SKILL.md`, etc) plus their bundled resource files (`REFERENCE.md`, `EXAMPLES.md`, scripts, schemas). Future migrations would silently drop ALL of them.

This is the same class of silent-drop hazard that just bit us with the seed→live drift gate. We have one running snapshot of skills today; if anyone needs to relocate `~/.ytsejam/data/`, the migration will look fine and 17 skills will quietly vanish.

## Goal

`migrate-data.sh skills/` step copies both flat `<name>.md` and dir-bundle `<name>/SKILL.md` (with the whole `<name>/` dir for bundled resources). Preserve the "missing only, existing left untouched" contract — never overwrite a destination skill.

## Scope (firmly bounded)

**In:** `deploy/migrate-data.sh` skills block (lines 67-78 region).
**Out:** drift gate, sync-skills.sh, config.ts default fix (separate item). No new env vars. No new flags. No behavioral change to flat skills already handled. Doc tweak ONLY if existing doc text becomes wrong after the change.

## Tasks

### Task 1 — extend migrate-data.sh skills block to handle dir bundles

**Surface:** `deploy/migrate-data.sh` lines 67-78 (or thereabouts; verify line numbers in worktree).

**Spec:**

After the existing flat-md loop, add a second pass that:
1. Finds every dir under `$SRC/skills` containing a `SKILL.md` (i.e. `find "$SRC/skills" -mindepth 1 -maxdepth 1 -type d` then filter to those containing `SKILL.md`).
2. For each, if `$DST/skills/<name>` does NOT already exist (matching the existing flat-md "missing only" contract), `cp -a "$SRC/skills/<name>" "$DST/skills/<name>"` (preserves entire bundle including REFERENCE.md, scripts/, schemas/, etc.).
3. Tracks the count separately and adds a second log line: `• skills/ (+N dir-bundles missing, existing left untouched)` matching the existing line shape.

**Constraints:**
- Use bash-portable constructs (no GNU-isms beyond what migrate-data.sh already uses).
- NUL-safe iteration (`find -print0` / `while IFS= read -r -d ''`) matching the existing flat loop's style.
- Use `cp -a` (not `cp -r`) to preserve mtimes — matches the existing flat-skill line `cp -a "$f" "$DST/skills/$base"`.
- The "missing only" check is on the dir name, not contents — if `$DST/skills/brainstorm/` exists, the bundle is treated as already present and skipped, even if it's missing files. This matches the existing flat-md contract and keeps the migration idempotent without doing per-file merging.

**Don't:**
- Don't rewrite the flat-md loop. Leave it. Add the dir-bundle loop after it.
- Don't `rsync` the parent dir wholesale — the action-item floated `rsync -a` as an option, but that would overwrite existing destination files, breaking the "existing left untouched" contract. Reject this option.
- Don't add a `--force` flag or any way to overwrite. Out of scope.
- Don't change the comment block at lines 65-67 (the `# (The release seeds...)` comment) unless its claim becomes wrong. (It probably stays accurate — it's about WHY we do this loop, not HOW.)

**Verification (implementer must run):**
1. Build a fake `$SRC/skills` fixture in `/tmp/migrate-test-src` with:
   - 2 flat skills (`a.md`, `b.md`)
   - 2 dir-bundle skills (`x/SKILL.md`, `x/REFERENCE.md`, `y/SKILL.md`)
   - 1 non-skill dir (`not-a-skill/` with random files, NO `SKILL.md`) — must be SKIPPED
2. Build an empty `$DST/skills` in `/tmp/migrate-test-dst-empty` → run migration → assert all 4 skills present, `not-a-skill/` absent.
3. Build a partially-populated `$DST/skills` in `/tmp/migrate-test-dst-partial` with `a.md` and `x/SKILL.md` (different content from src) → run migration → assert: `a.md` and `x/` content UNCHANGED (existing left untouched); `b.md` and `y/SKILL.md` ADDED.
4. Run case 3 twice — second run must be a no-op (idempotent).
5. Capture and paste the migrate-data.sh log output from each test, demonstrating the counts in the log lines are correct.

### Task 2 — final gate run

Run `scripts/gate.sh` from the worktree. Capture baseline first (`git stash`, run, capture; `git stash pop`, run, diff). Report PR-ready or what regressed.

## Out of scope (do NOT touch in this PR)

- `server/src/config.ts` default `./data` (separate low-pri item)
- drift gate / sync-skills.sh (already shipped #179)
- Any change to deploy.sh
- Any change to migrate-to-folded.sh (different migration with different rules)
- Adding tests for migrate-data.sh under `scripts/test/` — migrate-data.sh has no test suite today and starting one is a separate decision

## Stop conditions

- If a quality reviewer flags the "missing only" contract decision (skip dir if dir exists, even if missing files inside) as wrong, STOP and surface — that's a contract question, not a bug.
- If the flat-md loop turns out to ALREADY handle dir-bundles via some clever symlink or recursion I missed, STOP — re-check whether this PR is needed at all.

## Definition of done

- 1 commit on `migrate-data-dir-bundles`
- `scripts/gate.sh` green (no regressions from baseline)
- The 5-step verification in Task 1 demonstrated to pass with output captured in the task report
- PR opened against `main`
