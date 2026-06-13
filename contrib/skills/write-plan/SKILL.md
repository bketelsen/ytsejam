---
name: write-plan
description: Use when you have an approved design — breaks work into bite-sized tasks, sets up an isolated git worktree, writes the plan to the repo, and hands off to the develop skill.
triggers: [write plan, implementation plan, plan tasks, task plan, write-plan]
---

# Writing Plans

## Overview

Write a comprehensive implementation plan and set up an isolated workspace. Assumes the design
has been approved and the design doc exists.

**Announce at start:** "I'm using the write-plan skill to create the implementation plan."

**Prerequisites:**
- Design doc in the repo at `docs/plans/YYYY-MM-DD-<topic>-design.md` (from the brainstorm skill)
- Confirmation from the user that the design is approved

## Part 1: Set Up the Worktree

Do this before writing the plan.

### Create the Worktree

Convention (ytsejam): an isolated worktree under `/tmp/<branch>`, branch off `main`.

```bash
BRANCH_NAME="feature/<slug>"        # or fix/<slug>
git worktree add "/tmp/$(basename "$BRANCH_NAME")" -b "$BRANCH_NAME"
cd "/tmp/$(basename "$BRANCH_NAME")"
```

(No `.worktrees/` directory selection or gitignore dance — `/tmp` is out-of-repo by construction,
so a worktree there can never be accidentally committed. There is no separate manifests directory:
per-task consequences travel as the structured tail of each implementer report, not files on disk.)

### Project Setup

Auto-detect and run from the worktree:

```bash
[ -f package.json ]      && npm install     # (or: ln -s <repo-root>/node_modules ./node_modules)
[ -f Cargo.toml ]        && cargo build
[ -f requirements.txt ]  && pip install -r requirements.txt
[ -f pyproject.toml ]    && poetry install
[ -f go.mod ]            && go mod download
```

### Verify Clean Baseline

Run the project's gate or test suite (`bash scripts/gate.sh` if present, else the test command).
If it fails: report the failures and ask whether to proceed or investigate first. Do not proceed
silently with a broken baseline.

## Part 2: Write the Plan

### Plan Document Header

**Every plan MUST start with this header:**

```markdown
# [Feature Name] Implementation Plan

> Execute with the `develop` skill, task-by-task.

**Goal:** [One sentence describing what this builds]

**Spec:** [repo path to the design doc, e.g. docs/plans/YYYY-MM-DD-<slug>-design.md]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

**Worktree:** /tmp/<branch>

**Branch:** [branch name]

---
```

### Bite-Sized Task Granularity

**Each step is one action (2-5 minutes):**
- "Write the failing test" — step
- "Run it to make sure it fails" — step
- "Implement the minimal code to make the test pass" — step
- "Run the tests and make sure they pass" — step
- "Commit" — step

### Task Structure

````markdown
### Task N: [Component Name]

**Files:**
- Create: `exact/path/to/file.ts`
- Modify: `exact/path/to/existing.ts` (lines ~123-145)
- Test: `tests/exact/path/to/test.ts`

#### Step 1: Write the failing test
[complete test code]

#### Step 2: Run test to verify it fails
Run: `npm test -- --grep "test name"`
Expected: FAIL with "[specific error]"

#### Step 3: Write minimal implementation
[complete implementation code]

#### Step 4: Run test to verify it passes
Run: `npm test -- --grep "test name"`
Expected: PASS

#### Step 5: Commit
```bash
git add [files]
git commit -m "feat: [description]"
```
````

### Remember
- Exact file paths always
- Complete code in plan (not "add validation")
- Exact commands with expected output
- DRY, YAGNI, TDD, frequent commits

## Part 3: Save the Plan (to the repo — it is canon)

The plan is heavy, per-feature, canonical → it lives in the **project repo**, committed.

- Path: `docs/plans/YYYY-MM-DD-<feature-name>.md` (`<slug>` matches the branch and the design doc — they travel as a set)
- Commit: `git add docs/plans/ && git commit -m "docs: add implementation plan for <feature>"`
- If a pre-commit hook (e.g. markdownlint) rejects the file, **fix the markdown to pass lint — do
  not fall back to session-only storage.** Common issues: use `### Step N:` headings not `**Step N:**`
  bold; blank lines around fenced code blocks. Run the linter locally to confirm before retrying.
- The repo commit is mandatory — session state is transient working notes, not the canonical plan.

(Optionally also drop a one-line pointer in `projects/<slug>/observations.md` — `- YYYY-MM-DD
[plan]: wrote docs/plans/<file>` — so cog has a breadcrumb. The plan body stays in the repo, not cog.)

## Part 4: Execution Handoff

After saving the plan:

```
Plan complete. Saved to repo: docs/plans/<filename>.md
Worktree ready at /tmp/<branch> — baseline <gate/tests> passing.

Execute now with the develop skill? [yes / I'll run it later]
```

**On yes:** invoke the `develop` skill, stay in this session — it dispatches a fresh implementer
per task + two-stage review. **On later:** the plan header already says to use `develop`; the
worktree is ready when they return.

## Red Flags

**Never:**
- Proceed with a failing baseline without asking
- Write a plan before the design is approved
- Give vague task descriptions ("add error handling") — always complete code
- Store the canonical plan only in session/cog — it belongs committed in the repo

**Always:**
- Worktree under `/tmp/<branch>` off main
- Auto-detect setup commands from project files
- Save the plan to the repo `docs/plans/` and commit it
- Report worktree path + baseline status in the handoff

## Integration

**Requires:** an approved design (from the `brainstorm` skill).
**Invokes:** `develop` (the handoff).
