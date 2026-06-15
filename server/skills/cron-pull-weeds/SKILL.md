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
