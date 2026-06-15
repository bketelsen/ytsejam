# cron-pull-weeds Skill Implementation Plan (PR-B)

> Execute with the `develop` skill, task-by-task.

**Goal:** Add a `cron-pull-weeds` skill that wraps `/pull-weeds` Phase 1-4 with cron-specific safety rules (YOLO-graceful-fail, no-merge-authority, mislabel-fallback-autonomous), seeded as a dir-bundle skill so it survives reseed.

**Spec:** `docs/plans/2026-06-15-weed-workflow-extensions-design.md` (Change B, "cron-pull-weeds — daily ytsejam-only")

**Architecture:** Skill is a thin wrapper around the existing `/pull-weeds` skill. It runs the same Phase 1-4 flow but enforces three cron-specific rules: (1) STOP at "PR open, gate green" — do not `gh pr merge`; (2) handle bed-overflow by picking newest 5 and reporting the rest; (3) on approval-gate trip or any blocker, fail gracefully (leave worktree intact, log, exit) rather than self-approve. The cron schedule itself (PR-C) is registered separately after this PR lands and is activated via `sync-skills.sh`.

**Tech Stack:** Markdown skill file; no code; `gh` CLI; existing `/pull-weeds` skill machinery.

**Worktree:** `/tmp/feat-weed-cron-skill`

**Branch:** `feat/weed-cron-skill`

---

## Decision log

Q-decisions from the brainstorm that shape this plan:
- **Q2**: Shape A — cron files-and-gates only. Cron has NO merge authority. (Enforced by Task 1 Step 2 of the skill body.)
- **Q3**: Self-bounded recurring cron, pick-newest-5 on overflow. (Enforced by Task 1 Step 1 bed-check logic.)
- **Q6**: ytsejam-only MVP. Skill hard-codes `bketelsen/ytsejam` repo + `~/projects/ytsejam` working dir for clarity; multi-project = schedule another cron, not a generalization. (Documented in skill body.)

## Baseline (verified at worktree create)

- Branch: `feat/weed-cron-skill` off `38a8745` (main, includes design doc).
- `bash scripts/gate.sh` PASSED (web 158/158, server 689/689, lint+typecheck clean).
- `node_modules` installed via `env -u NODE_ENV npm install --include=dev --ignore-scripts` + `npx patch-package`.

## Task 1: Write the cron-pull-weeds skill body

**Files:**
- Create: `server/skills/cron-pull-weeds/SKILL.md` (the canonical seed in the repo)

### Step 1: Verify skill dir convention

Existing dir-bundled skills use the `<name>/SKILL.md` layout. Confirm:

```bash
ls server/skills/pull-weeds/ server/skills/find-weeds/
```

Expected: `SKILL.md` (and optionally `REFERENCE.md`). Both pull-weeds and find-weeds use the bundle layout — `cron-pull-weeds` matches.

### Step 2: Write the skill file

Path: `server/skills/cron-pull-weeds/SKILL.md`

Full body:

```markdown
---
name: cron-pull-weeds
description: Cron-driven weed pulling for ytsejam. Files+gates only — never merges. Wraps /pull-weeds Phase 1-4 with cron-specific safety rules for unsupervised operation.
triggers: [cron-pull-weeds, cron pull weeds, scheduled weed pull, autonomous weeds]
---

# cron-pull-weeds

Autonomous weed-pulling driven by the scheduler. Wraps `/pull-weeds` Phase 1-4 exactly,
with three cron-specific divergences:

1. **STOP at gate-green-PR-open.** NEVER `gh pr merge` — that's Brian's tap.
2. **On bed overflow (>5 open), pick newest 5 and proceed.** Never abort because the
   cap was exceeded — that's self-defeating if Brian filed weeds by hand.
3. **On approval-gate trip or unrecoverable blocker, fail gracefully.** Leave the worktree
   intact, log the blocker, exit. Do NOT self-approve destructive actions.

**Announce at start:** "I'm using the cron-pull-weeds skill."

**Scope:** ytsejam only. Multi-project support is YAGNI — schedule a second cron when a second
project starts using this workflow.

## Phase 1 — Bed check

```bash
cd ~/projects/ytsejam
gh issue list --repo bketelsen/ytsejam --label weed --state open \
  --limit 5 --json number,title,createdAt
```

- **0 open** → report "Weed bed empty — nothing to pull" and exit. No agent spin-up beyond
  this check.
- **1-5 open** → proceed with all of them.
- **6+ open** → `gh` default order is newest-first, so the `--limit 5` already returned the
  newest 5. Note in the summary: "Bed has N open; pulled newest 5; unpicked: #X, #Y, ...".
  Get the unpicked list explicitly:

  ```bash
  gh issue list --repo bketelsen/ytsejam --label weed --state open \
    --json number,title --jq '.[5:]'
  ```

## Phase 2 — Delegate one fix per issue

Use `/pull-weeds` Phase 2 dispatch template (`pull-weeds/REFERENCE.md`) verbatim, with one
modification to the per-issue brief: **REMOVE the "Push + PR" step's `gh pr merge` instruction
if present, and ADD the stop-after-PR-open line.**

The per-issue subagent's job ends at: branch pushed, PR opened with `Closes #NNN`, gate green.
Subagent does NOT merge.

(`pull-weeds/REFERENCE.md` Step 6 already only does push + `gh pr create`, not merge — merge is
handled by `/pull-weeds` Phase 3. So the per-issue brief doesn't need modification; just don't
invoke Phase 3.)

Independent issues (touching disjoint files): dispatch in parallel.
Issues touching shared files: serialize, second after first PR opens (NOT after merges — cron
doesn't merge).

## Phase 2.5 — Rebase gate

**Skip Phase 2.5 entirely.** Phase 2.5 exists in `/pull-weeds` because every merge invalidates
the bases of remaining PRs. Cron never merges, so bases stay valid relative to the `main` they
were branched from. (Brian's manual merges after cron will invalidate the remaining PR bases —
that's the human merge-time decision; cron doesn't pre-rebase for it.)

If `main` has moved between subagent dispatch and PR-open (Brian or another agent merged
something concurrently), the subagent's gate ran against fresh `origin/main` at dispatch time
and re-runs at PR open, so the PR will at worst show as "behind base" — Brian rebases at merge
time per his normal workflow.

## Phase 3 — REPLACED: no merging

The interactive `/pull-weeds` Phase 3 merges PRs sequentially with rebase gating between
merges. **cron-pull-weeds skips Phase 3 entirely.**

Instead: **collect status per issue** for the digest.

```bash
for N in <issue numbers pulled>; do
  pr_url=$(gh pr list --repo bketelsen/ytsejam --search "Closes #$N" \
    --json url --jq '.[0].url // "none"')
  echo "Issue #$N → $pr_url"
done
```

## Phase 4 — Digest report

End the conversation with a structured digest message:

```markdown
## cron-pull-weeds digest YYYY-MM-DD

**Bed state at start:** N open weeds (pulled M)

### Results

- #214 "<title>" → PR https://github.com/bketelsen/ytsejam/pull/XXX (gate: green)
- #215 "<title>" → PR https://github.com/bketelsen/ytsejam/pull/YYY (gate: green)
- #216 "<title>" → BLOCKED: <reason>
- #217 "<title>" → MISLABEL: unlabeled `weed`, commented "<reason>" — needs design pass

### Unpicked (bed overflow)

- #220 "<title>"
- #221 "<title>"

### Next action

Brian: review PRs above and merge each if the diff looks right.
```

If 0 weeds were pulled, just say so:

```markdown
## cron-pull-weeds digest YYYY-MM-DD

Weed bed empty. Nothing to pull. Next fire: <next cron time per `list_schedules`>.
```

## Approval-gate fallback

If a per-issue subagent reports it hit an approval gate (the `gh` CLI prompted for confirm,
a `delegate`-level approval would be needed for a destructive action, etc.):

1. **Do not self-approve.** Mark the issue BLOCKED in the digest.
2. **Leave the worktree intact** at `/tmp/<branch-name>` for forensics.
3. **Log specifically what tripped:** `"Issue #N: subagent hit approval gate at <step
   description> in <file/command>. Worktree preserved at /tmp/<branch>. Brian: investigate."`
4. **Continue with other issues** — one blocker doesn't stop the rest of the batch.

## Mislabel fallback

If a per-issue subagent reports "this isn't actually a weed — it needs a design discussion"
(per pull-weeds Phase 2 fallback), execute the unlabel + comment per the pull-weeds spec:

```bash
gh issue edit <N> --remove-label weed
gh issue comment <N> --body "Removed \`weed\` label after cron-pull-weeds attempt: <reason from subagent>. This needs a design pass — please brainstorm before fixing."
```

Mark MISLABEL in the digest. Safe autonomous action — removes work from the cron's lane.

## Rules

1. **NEVER `gh pr merge`** — that's Brian's tap.
2. **NEVER take a destructive action that would need approval in ASK mode** — fail gracefully.
3. **NEVER abort the whole batch because the bed has >5 open** — pick newest 5.
4. **ALWAYS run the gate before opening any PR** (delegated to /pull-weeds — same iron law).
5. **ALWAYS produce a digest**, even if 0 weeds were pulled.
6. **ALWAYS leave worktrees intact on failure** — never destroy forensic state unprompted.
```

### Step 3: Verify the skill file parses (frontmatter + body)

```bash
head -10 server/skills/cron-pull-weeds/SKILL.md
```

Expected: starts with `---\n`, has `name`, `description`, `triggers` keys, closes with `---\n`,
then a `# cron-pull-weeds` H1.

```bash
yq '.' server/skills/cron-pull-weeds/SKILL.md 2>&1 || echo "(yq not present — manual eyeball)"
```

If `yq` is present, the YAML block parses without error. If not, eyeball the frontmatter
manually — `name`, `description` (non-empty), `triggers` (non-empty list).

### Step 4: Verify the skill drift gate sees the new file

```bash
bash scripts/check-skills-drift.sh server/skills ~/.ytsejam/data/skills 2>&1
```

Expected: exit 1 with `── cron-pull-weeds/SKILL.md ──` (the seed exists, the live copy does
not). This is EXPECTED and confirms the drift gate will catch the missing live copy at deploy
time. The PR-3-of-cog-cleanup `cog.md` drift may also still be present if `sync-skills.sh`
hasn't run yet — that's not this PR's problem.

### Step 5: Verify gate

```bash
bash scripts/gate.sh
```

Expected: PASS. No test count change (markdown-only).

### Step 6: Commit

```bash
git add server/skills/cron-pull-weeds/SKILL.md
git commit -m "feat(skills): add cron-pull-weeds skill for autonomous weed-pulling

Wraps /pull-weeds Phase 1-4 with cron-specific safety rules:
- STOP at gate-green-PR-open; never merge (Brian's tap)
- Bed overflow: pick newest 5, never abort
- Approval-gate trip: fail gracefully, leave worktree intact
- Mislabel detection: unlabel + comment per pull-weeds Phase 2 fallback

Closes-design-for: weed-workflow extensions Change B.

Refs: docs/plans/2026-06-15-weed-workflow-extensions-design.md"
```

---

## Task 2: Update the Skills table in skills.md

**Files:**
- Modify: `docs/agents/skills.md` (the well-written reference doc the AGENTS.md breadcrumb points to)

### Step 1: Read the current Skills table

```bash
grep -n "^| " docs/agents/skills.md | head -30
```

Find the table location. The table lists skill name → purpose → invoke-when.

### Step 2: Add cron-pull-weeds row

Add a row in alphabetical order (between `create-gate` and `develop`):

```markdown
| cron-pull-weeds | Cron-driven weed pulling for ytsejam. Files+gates only — never merges. Wraps /pull-weeds Phase 1-4 with cron-specific safety rules for unsupervised operation. | user types /cron-pull-weeds, or fired by the scheduled cron (target: new_session) |
```

### Step 3: Verify the table renders

```bash
grep "cron-pull-weeds" docs/agents/skills.md
```

Expected: one match in the table.

### Step 4: Verify gate

```bash
bash scripts/gate.sh
```

Expected: PASS. Markdown-only.

### Step 5: Commit

```bash
git add docs/agents/skills.md
git commit -m "docs(agents): list cron-pull-weeds in skills.md table"
```

---

## Task 3: Pre-PR sweep

### Step 1: Confirm full gate green

```bash
bash scripts/gate.sh
```

Expected: PASS.

### Step 2: Confirm scope is exactly two files

```bash
git diff --stat main..HEAD
```

Expected: exactly two files:
- `server/skills/cron-pull-weeds/SKILL.md` (new)
- `docs/agents/skills.md` (modified)

Anything else is scope creep — investigate and revert.

### Step 3: Verify commit count

```bash
git log main..HEAD --oneline
```

Expected: exactly two commits — Task 1 then Task 2.

### Step 4: Verify the drift gate shows the expected new-file drift

```bash
bash scripts/check-skills-drift.sh server/skills ~/.ytsejam/data/skills 2>&1 || true
```

Expected: exit 1, output mentions `cron-pull-weeds/SKILL.md`. This is the expected pre-deploy
state — the operator's `sync-skills.sh --yes` post-merge will resolve.

If `cog.md` ALSO shows in the drift output, that's the still-pending PR-3-of-cog-cleanup
activation; not this PR's concern.

### Step 5: Check rebase status against origin/main

```bash
git fetch origin main
git log origin/main..HEAD --oneline
```

Expected: only the two feature commits. If any unfamiliar commits show, surface them before
shipping (the 745d287-pattern from earlier this session).

### Step 6: Hand back to /ship

The branch is ready. Invoke `/ship` for push + PR + merge + worktree cleanup.

## One claim most likely to be wrong

**The "skip Phase 2.5 entirely" decision in the skill body.** My reasoning: cron never merges,
so no merge invalidates remaining PRs' bases. BUT: if cron dispatches 5 subagents in parallel
and they all branch from the same `origin/main` at dispatch time, then before any subagent
finishes Brian could land an unrelated commit on `origin/main` via another session — making
ALL 5 weed PRs based on a stale main. The subagent's local gate at PR-open time runs against
the worktree's snapshot (which is still the original `origin/main`), not the new `origin/main`,
so the gate passes but the PR shows as "behind base" on GitHub.

This may be fine: Brian's manual merge can rebase + re-gate then. Or it may be confusing:
Brian opens his morning digest, all 5 PRs show "Update branch" warnings on the GH UI.

**Verify at write-plan or first-cron-run time:** does the per-issue subagent re-pull
`origin/main` before opening its PR, or is its push relative to its dispatch-time base? If the
former, Phase 2.5 is genuinely unneeded. If the latter, the cron may want to add a lightweight
rebase-against-origin-main step before push (NOT a full rebase gate — just a `git pull --rebase
origin main`) to keep the digest clean.

## Verification before shipping (manual smoke)

After merge + `sync-skills.sh --yes` activation, before PR-C registers the schedule:

1. Empty-bed path:
   ```
   /cron-pull-weeds
   ```
   Expected: "Weed bed empty — nothing to pull" digest, exit clean.

2. 1-weed path: file a synthetic weed:
   ```bash
   gh issue create --repo bketelsen/ytsejam --label weed \
     --title "weed: smoke test (delete after cron-pull-weeds run)" \
     --body "## Weed\nSmoke test for cron-pull-weeds. Make this trivially fixable: add a blank line at the end of CHANGELOG.md if not present.\n\n## Fix\nAppend a trailing newline to CHANGELOG.md."
   ```
   Then:
   ```
   /cron-pull-weeds
   ```
   Expected: PR opens, gate green, digest reports PR URL. Brian: close the PR + issue manually
   (it was a smoke test).

3. Mislabel path: file a synthetic non-weed labeled `weed`:
   ```bash
   gh issue create --repo bketelsen/ytsejam --label weed \
     --title "weed: smoke test mislabel (delete after run)" \
     --body "## Weed\nRefactor the entire memory module to use a different storage backend.\n\n## Fix\nReplace sqlite with Postgres."
   ```
   Then:
   ```
   /cron-pull-weeds
   ```
   Expected: digest reports MISLABEL, issue is unlabeled `weed` with a comment, no PR.
