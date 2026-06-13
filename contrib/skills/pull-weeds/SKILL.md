---
name: pull-weeds
description: Pull the weeds — resolve open `weed`-labeled GitHub issues with one gated PR each. Dispatches a fix per issue in an isolated worktree, runs the gate before every PR, one PR per issue. Small safe fixes only (the issues find-weeds filed). Use for "pull weeds", "clear the weed backlog", "fix the hygiene issues".
triggers: [pull weeds, clear weeds, fix weeds, weed backlog, resolve weed issues]
---

# pull-weeds

Clear the weed bed: take the open `weed` issues (the small, safe fixes `find-weeds` filed) and
resolve each with one gated PR. The gate is the iron law — no PR opens on a failed gate.

**Announce at start:** "I'm using the pull-weeds skill."

This is the companion to `find-weeds`. Scope is the SAME as find-weeds: small/safe gardening
only (missing tests, duplication, lint, type gaps, dead code, simplifiable code, TODOs, stale
docs). If an issue turns out to need a structural/behavioral change, it was mislabeled — STOP,
unlabel it `weed`, and tell the user it needs a `brainstorm`/`develop` pass instead.

## Phase 1 — Gather the weeds

```bash
gh issue list --repo <owner/repo> --label weed --state open --json number,title,labels,body
```

- Take the open `weed` issues (there are at most 5 by the find-weeds cap).
- **Read every issue body** before dispatching — never brief a subagent on a title alone.
- Flag any pair touching the same files → serialize those (do the second after the first
  merges); everything else can run in parallel.
- Keep a simple in-message checklist (issue # | branch | task status | depends-on). No external
  tracker — a markdown list in this conversation is the ledger.

## Phase 2 — Dispatch a fix per issue

One `delegate` call per issue (parallel for independent ones; hold serialized pairs). Implementer
model `github-copilot/gpt-5.5`. Full brief template: [REFERENCE.md](REFERENCE.md). Baked into
every brief:
- Isolated worktree under `/tmp/<branch>` off main; node_modules symlink for Node projects.
- **Commit an early WIP checkpoint once it compiles, and commit-before-report.** A subagent
  cannot delegate further — it does the whole fix itself.
- **Run `bash scripts/gate.sh` before committing/opening the PR. The gate MUST pass — no PR on a
  failed gate.** (If there's no `scripts/gate.sh`, read `projects/<slug>/hot-memory.md` for the
  `quality gate:` line.)
- One PR per issue, `Closes #NNN`, conventional commit + the Copilot co-author trailer.
- Do not touch files outside the issue's scope.

After each report: verify the branch advanced (`git -C /tmp/<branch> log main..HEAD --oneline`)
before trusting it.

## Phase 3 — Merge

As fixes complete, watch CI and merge:
```bash
gh pr view <N> --json statusCheckRollup,mergeable -q '{mergeable, checks:[.statusCheckRollup[]|{name,conclusion}]}'
```
1. First green PR: `gh pr merge <N> --squash` (the `weed` issue closes via `Closes #NNN`).
2. That advances main → remaining PRs may need `gh pr update-branch <N>` before merging; wait for CI to rerun, merge sequentially.
3. After a merge, dispatch the next serialized dependency if one was waiting (from fresh main).

## Phase 4 — Wrap up

No release cut — weeds are hygiene, not a shipped feature; the merged PRs are the deliverable.
- Brief the user: which weed issues closed (with PR #s), any that failed the gate and were left
  open, any that turned out to be non-weeds (unlabeled + flagged for a design pass).
- Optional: `cog_append("projects/<slug>/dev-log.md", "- YYYY-MM-DD: pulled N weeds (#a,#b,…)")`.
- The weed bed should now be clearer — `find-weeds` can plant again up to the cap.

## Red Flags

**Never:**
- Open a PR on a failed gate (the gate is the iron law).
- Trust a subagent's report without verifying the branch advanced.
- Let a weed PR make a structural/behavioral change — if the issue needs that, it's not a weed;
  unlabel it and route to `brainstorm`.
- Dispatch a dependent issue before its dependency merges (worktrees diverge → rebase hell).
- Cut a release as part of pulling weeds (out of scope).

## Integration

**Pairs with:** `find-weeds` (it files the issues this resolves). **Uses:** `gh` CLI, git, the gate.
