# Weed-workflow extensions — design

**Date:** 2026-06-15
**Status:** Approved, ready for write-plan
**Author:** Mentat + Brian (brainstorm session)
**Branch family:** `feat/weed-ship-filing` (PR-A), `feat/weed-cron-skill` (PR-B), no branch for PR-C (schedule registration)

## Problem

The weed workflow today is a two-skill loop (find-weeds → pull-weeds) with one human gate at each end. find-weeds plants ≤5 issues; pull-weeds produces gate-green PRs; a human merges each. The bed cap and the human merge are deliberate friction — they're how the system stays safe.

Two pieces of friction don't pay their way:

1. **Minor findings from `/review` are dropped.** `/develop`'s review pass classifies findings as Critical / Important / Minor. Critical and Important block the task and force fixes. Minor gets reported in the per-task tail and effectively dies — they leak into `observations.md` at `/ship` time if Brian remembers, or vanish with the session otherwise. They're real-but-out-of-scope work: lint, doc gaps, test debt, narrowable `as any`s. Exactly the shape of a weed.

2. **`/pull-weeds` is a manual invocation.** A small fix that a model can write, gate, and PR — but only when Brian remembers to run it. The bed sits full for days. When run, the work happens autonomously, which proves the work *was* autonomous-able all along; the wait was pure latency.

## Design — two changes, one queue

Both changes drop into the existing `pull-weeds` gate-then-PR-open machinery without expanding its trust surface.

### Two preserved properties

- **Every merge to main is a human decision.** Cron files-and-gates only; never merges. (Shape A from Q2)
- **Writes to the weed bed pause for confirmation.** /ship-time filing uses a batched approve gate, same shape as the existing `scope: global` patterns gate. (Shape B from Q5)

### Decision log

The brainstorm settled six load-bearing questions. Locks preserved here so the implementation plan can reference rather than re-derive:

- **Q1 (coupling)**: A — loosely coupled. /develop-filed weeds and find-weeds-filed weeds share one queue, treated identically. Cron-puller pulls from that queue.
- **Q2 (cron blast radius)**: A — files-and-gates only. Cron stops at gate-green-PR-open; Brian merges. C (`weed:auto` taxonomy fast-lane) deferred as v2; trigger to revisit logged in `projects/ytsejam/observations.md` 2026-06-15.
- **Q3 (cron cadence)**: A — recurring cron, self-bounded. `0 8 * * 1-5` (8am EDT weekdays). On cap overflow (>5 open): pick newest 5 by `createdAt`, proceed — never abort the pull just because Brian filed by hand.
- **Q4 (filter gate location)**: C — file at `/ship` time, batched. Branches that don't ship don't pollute. `/review` and `/develop` don't need to know about weeds.
- **Q5 (gate ceremony)**: B — batch confirm, one decision per /ship run. Same shape as the existing `scope: global` gate.
- **Q6 (cron scope)**: A — ytsejam-only MVP. Multi-project = schedule another cron later, not a generalization-now job.

## Change A — /ship batches Minor findings → weed-file gate

**Where:** `~/.ytsejam/data/skills/ship/SKILL.md` Step 2 ("Route the Per-Task Consequences"), seed at `server/skills/ship/SKILL.md`.

**What it adds:** a new sub-step between the existing "Lessons" and "Blockers" routing — call it "Minor findings → weed candidates." Same shape as the adjacent `scope: global` decisions gate.

### Flow

1. Collect all Minor-severity entries from the per-task report tails on this branch. Section name TBD at write-plan time — confirm against the current quality-reviewer prompt at `~/.ytsejam/data/skills/develop/quality-reviewer-prompt.md`. (See "One claim most likely to be wrong" below.)

2. **Filter pass** — one cheap model call. Suggest `github-copilot/gpt-5-mini` or similar fast/cheap; confirm at write-plan time. Inputs:
   - The list of Minor findings (verbatim from tails)
   - The find-weeds taxonomy definition verbatim ("small, safe, named fix, no behavior change, no design discussion needed")
   - The open-weed-titles list (`gh issue list --label weed --state open --json title`)

   Output: structured list, one entry per Minor finding, classified `weed-candidate: yes | no` plus a one-line `reason`.

3. **Dedupe pass** (belt-and-suspenders): after filter, run exact-title-substring check against open weeds. Drop matches automatically, note in the report ("dropped 1 candidate as duplicate of #X").

4. **Drop the `no`s silently.** They get the existing `observations.md` routing — no regression.

5. **Present the `yes`es as a batch-approve gate**, modeled on `scope: global`:

   ```
   Weed candidates from this branch's Minor findings — these would file as `weed` issues:

     1. lint: unused import in server/src/foo.ts:42 — fix: delete line
     2. test gap: server/src/bar.ts:118 has no error-path coverage — fix: add throw-test
     3. doc: README mentions removed env var YTSEJAM_OLD — fix: drop the bullet

   File all? Skip numbers (e.g. "skip 2"). Cancel filing (e.g. "none"):
   ```

6. **On confirmation**, for each kept candidate:
   ```bash
   gh issue create --label weed --title "<finding title>" --body "<weed body template, with originating-task breadcrumb>"
   ```
   Body template matches find-weeds existing template, plus one added line: `_Found by /ship from <task name> in <branch>_` (provenance for debugging if a bad weed shows up).

7. **Report**: `Filed N weed issues: #X #Y #Z`. The pre-existing `observations.md` routing still runs for dropped-Minor findings — nothing is lost, they just don't become issues.

### Non-goals (Change A)

- **No find-weeds 5-cap enforcement on /ship-filed weeds.** Brian explicitly approved (Q5): filing yourself shouldn't be auto-stopped by the cap. find-weeds itself still respects the cap on its own runs.
- **No /develop-time filing.** Q4 chose /ship-time. Branches that don't ship don't pollute.
- **No retro-filing for branches already shipped before this lands.** Forward-only.
- **No reviewer-prompt changes.** /review and /develop don't know about weeds (Q4-C loose coupling).

## Change B — cron-pull-weeds — daily ytsejam-only

**Where:** two artifacts.

1. **The cron schedule itself** — registered via the `schedule` tool with `cron: "0 8 * * 1-5"` (8am EDT weekdays). One-time registration; PR-C below.
2. **A new helper skill** — `~/.ytsejam/data/skills/cron-pull-weeds/SKILL.md` + matching seed at `server/skills/cron-pull-weeds/SKILL.md`. Triggered by the scheduled prompt (manual `/cron-pull-weeds` allowed for testing).

**Why a separate skill instead of "the cron prompt invokes /pull-weeds":** the cron-specific safety rules (YOLO-graceful-fail, no-merge-authority, mislabel-fallback-autonomous) belong in one named, auditable place. pull-weeds stays focused on the interactive use case. cron-pull-weeds is a thin wrapper that delegates the bulk of the work to /pull-weeds Phase 1-4 but enforces its own rules around the edges.

### Flow when cron fires

1. **Bed check:**
   ```bash
   gh issue list --repo bketelsen/ytsejam --label weed --state open --limit 5 --json number,title,createdAt
   ```
   - **0 open** → report "Weed bed empty, nothing to pull" and exit. No agent context spin-up beyond the bed-check.
   - **1-5 open** → proceed with all of them.
   - **6+ open** → pick newest 5 by `createdAt` (gh default order); list the unpicked ones in the final summary so they're visible.

2. **Run /pull-weeds Phase 1-4** exactly per spec, with **one hard divergence**: STOP at "PR open, gate green." Do NOT execute the `gh pr merge` step in Phase 3. This is the Shape A enforcement from Q2 — cron has no merge authority.

3. **Mislabel handling**: if any per-issue subagent reports "this isn't really a weed" (the existing Phase 2 fallback), execute the unlabel + comment per spec. Safe autonomous action — removes work from the cron's lane and routes it to brainstorm.

4. **Approval-mode handling**: cron runs in a fresh `new_session` context with no human attached. If a pull-weeds subagent tries to do something that would need approval in ASK mode (e.g. destructive cleanup the gate didn't catch), the cron skill says: **don't self-approve, fail gracefully**. Leave the worktree intact, log `cron-pull-weeds: subagent task #N hit an approval gate at <step>, parking — Brian to resolve manually`, exit. Worktree stays for forensics.

5. **Final report**: structured summary message into the new session — for each issue: # → branch → PR URL (or failure reason) → gate status. Plus the unpicked-overflow list if any. This is the digest Brian sees when he opens the conversation in the morning.

### Cron prompt (full text as registered)

```
Cron-driven weed pulling for ytsejam. Use the cron-pull-weeds skill.

1. Working dir: ~/projects/ytsejam.
2. Invoke /cron-pull-weeds. Follow the skill exactly.
3. Report the digest at end. Do NOT merge any PR — that's Brian's tap. Do NOT take destructive
   action unsupervised — fail gracefully if a subagent hits an approval gate.
```

Target: `new_session`.

### Non-goals (Change B)

- **No multi-project support.** YAGNI per Q6.
- **No `weed:auto` taxonomy.** Deferred per Q2. Revisit trigger: ≥5 weed PRs/day, ≥10 min/week pure merge-tapping.
- **No event-driven polling.** Q3 chose simple recurring cron. The "wasted run on empty bed" cost is negligible (one `gh` call).
- **No merge authority for cron, ever.** This is the load-bearing safety property.

## Edge cases

| # | Case | Handling |
|---|---|---|
| E1 | /ship filter duplicates an open weed | Filter prompt includes open-weed-titles list; belt-and-suspenders exact-substring dedupe before the approve gate |
| E2 | /develop branch produces 0 Minor findings | /ship sub-step becomes "no Minor findings, skipping weed gate" — no empty prompt |
| E3 | Cron fires while Brian's actively dev'ing in another session | Cron uses `origin/main` (not local main); branch-name collision avoided by `weed/<issue-#>-...` convention (verify in write-plan) |
| E4 | Cron fires while ytsejam is being deployed | Cron runs against `~/projects/ytsejam` git state, independent of `~/.ytsejam/current` symlink swap. No race. |
| E5 | Cron-filed PR fails CI after Brian merges manually | Out of scope — normal bad-merge scenario, `git revert` |
| E6 | Filter classifies a Minor as `yes` that's actually subtle | Bad weed in queue → gate catches the fix (no PR opens) OR Brian declines to merge the PR. Worst case: bad weed sits unpulled forever. Same failure mode as a bad find-weeds finding today. |
| E7 | Cron job lost (server restart) | Brian runs `/pull-weeds` manually. Cron is convenience, not system of record. |
| E8 | Bed has 10 weeds, cron pulls newest 5 | Next cron picks the original "oldest 5" (now the only remaining). System self-drains over multiple runs. |

## Rollout — three PRs

### PR-A: `/ship` Minor-findings weed-file gate

- **Branch**: `feat/weed-ship-filing`
- **Touches**: `~/.ytsejam/data/skills/ship/SKILL.md` + `server/skills/ship/SKILL.md` seed
- **Closes**: action item "file `weed` issues for code-review Minor findings during /develop runs" (currently in `projects/ytsejam/action-items.md` High priority, added 2026-06-15)
- **Tests**: dry-run by triggering /ship on a small branch with synthetic Minor findings; verify batch-approve prompt renders correctly; on "go" issues file with correct labels and body templates
- **Gate**: `bash scripts/gate.sh` green + manual smoke (file 2 fake weeds, verify they appear in `gh issue list --label weed`)
- **Independent of PR-B/PR-C** — Brian can manually `/pull-weeds` against the bed Change A populates

### PR-B: `cron-pull-weeds` skill

- **Branch**: `feat/weed-cron-skill`
- **Touches**: `~/.ytsejam/data/skills/cron-pull-weeds/SKILL.md` + `server/skills/cron-pull-weeds/SKILL.md` seed; Skills table in agent persona (skills.md doc + any rendered manifest)
- **Closes**: action item "cron-driven autonomous weed-pulling" (currently in `projects/ytsejam/action-items.md` High priority, added 2026-06-15)
- **Tests**: manually invoke `/cron-pull-weeds` against current ytsejam queue; cover (a) empty-bed exit, (b) 1-weed full path, (c) mislabel-fallback path (file a synthetic non-weed labeled `weed`, verify cron unlabels)
- **Gate**: gate green + manual smoke as above
- **Independent of PR-A** — can ship and work against find-weeds-filed weeds only

### PR-C: cron schedule registration

- **Not a PR** — one-liner `schedule({cron: "0 8 * * 1-5", target: "new_session", prompt: <as above>, label: "ytsejam cron-pull-weeds"})` Brian or Mentat invokes in a session
- **Depends on PR-B merged AND deployed via `bash deploy/sync-skills.sh --yes`** — otherwise cron fires into a fresh session that doesn't know the skill
- **Verification**: `list_schedules` after registration, confirm next-fire is the expected next-weekday 8am EDT (= 12:00 UTC)

### Ordering

A and B independently mergeable. C waits on B + sync-skills activation. If you want A first (Minor findings leaking now is the only loss currently active), ship A first; B and C follow in any order.

## One claim most likely to be wrong

The exact section header that quality-review subagent reports use for Minor findings. The /ship collection step needs the right grep — I have not yet read `~/.ytsejam/data/skills/develop/quality-reviewer-prompt.md` or the spec-reviewer prompt to confirm whether it's `## Minor`, `## Minor Issues`, `## Other findings`, or whether Minor findings exist in both spec-review and quality-review report shapes. **Confirm at write-plan time** before writing the collection logic in PR-A.

Adjacent risk: the per-task "report tail" structure that /ship's Step 2 reads from is described in the ship skill as `## Decisions / ## Patterns Discovered / ## Lessons / ## Blockers / ## Context for Continuation` — Minor findings aren't currently listed there. Either (a) the ship skill's Step 2 description is stale and findings ARE in tails, or (b) findings live somewhere else entirely (e.g. only inline in `delegate` responses) and /ship needs a new collection mechanism. Verify before plan-writing.

## References

- `projects/ytsejam/action-items.md` — High priority entries 2026-06-15 (both items this design addresses)
- `projects/ytsejam/observations.md` 2026-06-15 — Shape C deferral with revisit trigger
- `~/.ytsejam/data/skills/find-weeds/SKILL.md` — the planting half of the existing workflow
- `~/.ytsejam/data/skills/pull-weeds/SKILL.md` — the pulling half (Phase 1-4 cron-pull-weeds delegates to)
- `~/.ytsejam/data/skills/ship/SKILL.md` — the Step 2 "Route the Per-Task Consequences" Change A extends
- `~/.ytsejam/data/skills/develop/quality-reviewer-prompt.md` — confirm Minor finding section header here at write-plan time
