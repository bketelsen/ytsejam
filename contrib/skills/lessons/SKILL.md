---
name: lessons
description: >
  Capture a lesson from a task fix cycle — synthesize what went wrong into a
  rule-shaped entry, dedupe against existing entries, and commit on approval.
  Most fix cycles produce a `_pending` note, not a published lesson; promotion
  happens on recurrence or explicit user opt-in.
triggers: [lessons, capture lesson, fix-cycle lesson, lesson from fix, docs/agents]
---

# Lesson Capture from Fix Cycles

## Why this skill exists

A lesson is useful only if a future agent **reads it before making the same mistake**. Every
entry should be a rule a reader can apply without re-reading the originating commit. A
paragraph of file:line citations is a lab note, not a lesson.

**Default outcome of this skill is a `_pending` note, not a published lesson.** Promotion to
the published file requires either a 3rd recurrence across distinct tasks, or the user
explicitly saying "publish".

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
      task: """You are a lesson synthesizer. Your output will be appended to a long-lived
    project doc that future agents grep before working in this area. Your single hardest
    constraint: the TITLE alone must change what a reader does next. If a reader could not
    state the rule from the title, you have failed.

    Produce EXACTLY this format and nothing else:

    TITLE: <an imperative rule, 4–8 words, title case, no punctuation. Examples:
    "Mutation-Test Defensive Try/Catch Assertions", "Trust File State Over Edit Success",
    "Normalize Whitespace Before Content-Addressed Dedup". NOT a description of the bug:
    "Auto-Commit Cadence Lost Increments" is BAD — the reader can't act on it.>

    THEME: <one of: testing, release-workflow, tooling, architecture, frontend, api,
    database, security — or a new single word if none fit>

    LESSON:
    <ONE to TWO sentences, ≤60 words total. State the rule and the consequence of breaking
    it. Generalize past the originating bug — if your sentences only make sense in the
    context of THIS PR, rewrite. End with ONE parenthetical citation in the form
    "(seen in: <file>:<line> — <8-word symptom>)". No second example, no extended
    rationale, no historical narrative.>

    Self-check before emitting (silently — do not include in output):
    1. Could a reader paste TITLE into a checklist and act on it? If no, rewrite.
    2. Does LESSON repeat what TITLE already said? If yes, cut.
    3. Is the citation parenthetical and ≤15 words? If no, trim.
    4. Would this rule have prevented a DIFFERENT bug too, not just this one? If no, you
       are writing a bug report — generalize or refuse with: REFUSE: too specific to
       generalize.

    If you cannot produce a generalizable rule, output exactly:
    REFUSE: too specific to generalize

    --- Reviewer feedback ---
    <paste>
    --- Fix diff ---
    <paste>
    --- Task description ---
    <paste>""",
      model: "github-copilot/claude-opus-4.8"
    })

The subagent's final message is returned to you verbatim.

- If the output begins with `REFUSE:`, report to the user: "Synthesis refused — this fix
  doesn't generalize. Skipping." and stop. Do not write anything.
- Otherwise parse TITLE / THEME / LESSON.

### Step 2: Determine the target file and dedupe

Target file: `docs/agents/<theme>.md` in the project working directory (`pwd` to confirm).

Before proposing, run these checks against `docs/agents/<theme>.md` if it exists:

1. **Duplicate title check** — `grep -i "^## " docs/agents/<theme>.md` and compare against
   the proposed TITLE. If a near-match exists (same key noun and verb), report to the user:

       Near-duplicate of existing entry: "<matched title>"
       Proposed: "<new title>"
       [skip / replace existing / add as new entry / edit]

   Default to `skip` unless the user explicitly says otherwise.

2. **File length check** — if the file already has ≥30 entries (`grep -c "^## " docs/agents/<theme>.md`),
   report to the user:

       docs/agents/<theme>.md has <N> entries (cap: 30). Prune before adding more, or
       say "force" to append anyway.

   Stop unless the user says `force`.

3. **Pending file check** — look in `docs/agents/_pending/<theme>.md` for prior occurrences
   of this rule (same key noun in title). Count them.

### Step 3: Route — pending vs published

- **First or second occurrence** (default): the entry goes to `docs/agents/_pending/<theme>.md`.
  Present:

      Pending lesson → docs/agents/_pending/<theme>.md (occurrence <N> of 3):

      ## <TITLE>

      <LESSON>

      _Added: YYYY-MM-DD | Task: <first 60 chars> | Occurrence: <N>_

      Commit as pending? [yes / publish-anyway / edit / skip]

- **Third or later occurrence**: route to the published file
  (`docs/agents/<theme>.md`) and present:

      Promoting to docs/agents/<theme>.md (3rd occurrence):

      ## <TITLE>

      <LESSON>

      _Added: YYYY-MM-DD | Task: <first 60 chars> | Promoted from _pending_

      Publish? [yes / edit / skip]

User responses:
- **yes** — proceed to Step 4 with the routed target.
- **publish-anyway** — write to the published file instead, with `_Added: ... | Task: ... | Direct-publish_`.
- **edit** — accept revised text, re-show, ask again.
- **skip** — say "Lesson skipped." and stop.

### Step 4: Write the file

`mkdir -p docs/agents/_pending` if writing to a pending file and the directory doesn't exist.

**If the target file does NOT exist**, create it with this header then append:

    # <Theme Title Case> — Project Lessons

    Rules learned from fix cycles. Each entry is a rule a reader can apply without
    re-reading the originating commit. Cap: 30 entries — prune oldest if exceeded.

    ## <TITLE>

    <LESSON>

    _Added: YYYY-MM-DD | Task: <first 60 chars>_

**If the file already exists**, append the entry section only (NEVER `cat >`; ALWAYS `cat >>`):

    ## <TITLE>

    <LESSON>

    _Added: YYYY-MM-DD | Task: <first 60 chars>_

For pending entries, the trailer is `_Added: YYYY-MM-DD | Task: ... | Occurrence: N_`.

### Step 5: Commit

    git add docs/agents/<theme>.md   # or docs/agents/_pending/<theme>.md

    # If pending → published promotion, also stage the pending-file edit that removes
    # the prior pending entries (replace with a single line: `# Promoted YYYY-MM-DD`).

    git commit -m "docs(lessons): <pending|publish> <theme> — <title>

    Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"

### Step 6: Report

    Pending → docs/agents/_pending/<theme>.md
    OR
    Published → docs/agents/<theme>.md (3rd occurrence promotion)

## Red Flags

- Never commit without user approval (yes or edited yes).
- Never `cat >` an existing lessons file — always `cat >>`. Heredoc-rewrite clobbers prior entries silently.
- Never accept a REFUSE response and then "rescue" it by hand-writing a lesson — the synthesis
  said it doesn't generalize; respect that.
- Never publish on the first occurrence unless the user explicitly says `publish-anyway`.

## Integration

**Invoked by:**

- `develop` — after any task where a fix cycle occurred (spec/quality reviewer ran more than
  once, OR the gate required a fix commit). The default path is pending; users curate.

**Invokes:**

- `delegate` — for the LLM synthesis subagent (a subagent cannot delegate further; this is a
  single leaf call).

## Reader-side contract (other skills must honor)

This skill is the WRITE half. For lessons to pay rent, the READ half must exist too:

- `develop` and `write-plan` should grep `docs/agents/<theme>.md` for keywords matching the
  task's scope before dispatching the implementer, and pass any hits into the implementer
  prompt's Context section. Without this, lessons are write-only sediment.

If you notice a future task that would have benefited from an existing lesson, mention it in
the lessons skill's report so the writer knows the reader-side is paying off.
