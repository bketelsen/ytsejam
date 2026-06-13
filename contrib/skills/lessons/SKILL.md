---
name: lessons
description: >
  Capture a lesson from a task fix cycle — synthesize what went wrong, propose a
  thematic docs/agents file entry, and commit on approval. Invoked by
  the develop skill after any fix cycle.
triggers: [lessons, capture lesson, fix-cycle lesson, lesson from fix, docs/agents]
---

# Lesson Capture from Fix Cycles

## Overview

After a fix cycle (spec/quality reviewer rejection + rework, or gate failure + fix commit),
synthesize the lesson and propose writing it to the project's `docs/agents/` directory.

**Announce at start:** "I'm using the lessons skill to capture this fix cycle."

## Inputs

Provided by the `develop` skill when invoking this skill:

- **Reviewer feedback** — what the reviewer said was wrong
- **Fix diff** — what changed between the bad and good commit
- **Task description** — what was being attempted

## Process

### Step 1: Synthesize the lesson

Use the `delegate` tool to run a synthesis subagent. Call:

    delegate({
      label: "Synthesize fix-cycle lesson",
      task: """You are a lesson synthesizer. Given the reviewer feedback, fix diff, and
    task description below, produce EXACTLY this format and nothing else:

    TITLE: <5–8 words, title case, no punctuation>
    THEME: <one of: testing, release-workflow, tooling, architecture, frontend, api, database, security — or a new single word if none fit>
    LESSON:
    <a concise 3–5 sentence paragraph: what to do, what to avoid, why. Write for a
    future agent reading this as project context. Be specific — name the files,
    commands, or patterns involved.>

    --- Reviewer feedback ---
    <paste>
    --- Fix diff ---
    <paste>
    --- Task description ---
    <paste>""",
      model: "github-copilot/claude-opus-4.8"
    })

The subagent's final message is returned to you verbatim; parse the TITLE / THEME / LESSON from it.

### Step 2: Determine the target file

Target path: `docs/agents/<theme>.md` inside the project's working directory.

The project is the current session's working directory — run git/file commands from there (`pwd` to confirm). Do not scan `~/projects/*`.

Most repos already carry an `AGENTS.md` breadcrumb pointing at `docs/agents/` (per the maintain-docs skill convention). If `AGENTS.md` does NOT mention `docs/agents/`, the lesson commit should also add a one-line breadcrumb under a `## Agent documentation` heading.

### Step 3: Present the proposal to the user

Show the proposed lesson and ask for approval:

    Fix cycle captured.

    Proposed lesson → docs/agents/<theme>.md:

    ## <TITLE>

    <LESSON paragraph>

    _Added: YYYY-MM-DD | Task: <first 60 chars of task description>_

    Commit this lesson? [yes / edit / skip]

Wait for user response:

- **yes** — proceed to Step 4
- **edit** — ask the user to provide revised text, re-show the proposal, ask again
- **skip** — say "Lesson skipped." and stop

### Step 4: Write the file

Check if `docs/agents/<theme>.md` exists in the project working directory.

**If the file does NOT exist**, create it with this header then append the lesson:

    # <Theme Title Case> — Project Lessons

    Lessons learned from failures and fix cycles.
    Auto-appended by the lessons skill.

    ## <TITLE>

    <LESSON paragraph>

    _Added: YYYY-MM-DD | Task: <first 60 chars of task description>_

**If the file already exists**, append the lesson section only:

    ## <TITLE>

    <LESSON paragraph>

    _Added: YYYY-MM-DD | Task: <first 60 chars of task description>_

### Step 5: Commit

Run from the project working directory:

    git add docs/agents/<theme>.md
    git commit -m "docs(lessons): add <theme> lesson from task fix cycle

    Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"

### Step 6: Report

    ✅ Lesson committed to docs/agents/<theme>.md

## Red Flags

- Never commit without user approval (yes or edited yes)
- Never skip synthesis — if the `delegate` tool is unavailable, ask the user to describe
  the lesson manually before writing
- If synthesis returns garbled output, show it raw and ask the user to edit before approving

## Integration

**Invoked by:**

- `develop` — after any task where a fix cycle occurred

**Invokes:**

- `delegate` — for the LLM synthesis subagent (a subagent cannot delegate further; this is a single leaf call)
