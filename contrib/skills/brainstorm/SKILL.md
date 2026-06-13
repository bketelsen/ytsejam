---
name: brainstorm
description: "You MUST use this before any creative work — creating features, building components, adding functionality, or modifying behavior. Explores requirements and design before implementation."
triggers: [brainstorm, design, explore, new feature, design doc, brainstorming, think through]
---

# Brainstorming Ideas Into Designs

## Overview

Help turn ideas into fully formed designs and specs through natural collaborative dialogue.

Start by understanding the current project context, then ask questions one at a time to refine
the idea. Once you understand what you're building, present the design and get user approval.

<HARD-GATE>
Do NOT invoke the write-plan skill, call `delegate`, or take any implementation action until you
have presented a design and the user has approved it. This applies to EVERY project regardless of
perceived simplicity.
</HARD-GATE>

## Anti-Pattern: "This Is Too Simple To Need A Design"

Every project goes through this process. A todo list, a single-function utility, a config change —
all of them. "Simple" projects are where unexamined assumptions cause the most wasted work. The
design can be short (a few sentences for truly simple projects), but you MUST present it and get approval.

## Checklist

You MUST complete each of these in order:

1. **Explore project context** — check the project's cog memory + wiki, recent commits, open issues, README
2. **Ask clarifying questions** — one at a time, understand purpose/constraints/success criteria
3. **Propose 2-3 approaches** — with trade-offs and your recommendation
4. **Present design** — in sections scaled to their complexity, get user approval after each section
5. **Write design doc** — save to the repo (see below)
6. **Transition to implementation** — invoke the write-plan skill

## Process Flow

```
Explore project context
  → Ask clarifying questions (one at a time)
    → Propose 2-3 approaches
      → Present design sections (get approval after each)
        → User approves? → no → revise → re-present
        → User approves? → yes → Write design doc → Invoke write-plan
```

**The terminal state is invoking the write-plan skill.** Do NOT call `delegate`, invoke `develop`,
or take any other implementation action. The ONLY thing you do after brainstorming is write the doc
and invoke `write-plan`.

## The Process

**Understanding the idea:**

- Explore project context first: `cog_read("projects/<slug>/hot-memory.md")` and the project's
  cog wiki (`cog_read`/`cog_search` over `wiki/projects/<slug>/...`), plus `git log --oneline -15`,
  open issues (`gh issue list`), and the `README.md` / `AGENTS.md`.
- Ask questions one at a time to refine the idea
- Prefer multiple choice questions when possible, but open-ended is fine too
- Only one question per message — if a topic needs more exploration, break it into multiple questions
- Focus on understanding: purpose, constraints, success criteria

**Exploring approaches:**

- Propose 2-3 different approaches with trade-offs
- Lead with your recommended option and explain why
- Present conversationally, not as a bulleted menu

**Presenting the design:**

- Once you understand what you're building, present the design
- Scale each section to its complexity: a few sentences if straightforward, up to 200-300 words if nuanced
- Ask after each section whether it looks right so far
- Cover: architecture, components, data flow, error handling, testing
- Be ready to go back and clarify if something doesn't make sense

## After the Design

**Documentation — the spec lives in the repo (it's the canonical spec the develop reviewers read):**

1. **Repo** (committed, version-controlled — canonical):
   - Path: `docs/plans/YYYY-MM-DD-<topic>-design.md`
   - `<topic>` matches the intended branch name (e.g. `add-config-parser`) so the design doc, the
     plan, and the branch travel as a set
   - Commit with message: `docs: add design doc for <topic>`
   - This is the canonical spec — the `develop` skill's reviewers check the implementation against it.

2. **Optional: cog wiki narrative** — if the design has durable cross-cutting value worth a
   browsable page, also `cog_write("wiki/projects/<slug>/<topic>.md", ...)`. The canonical spec stays
   the repo doc; the wiki page is narrative, not the source of truth.

**Implementation:**

- Invoke the `write-plan` skill to create a detailed implementation plan
- Do NOT invoke anything else. `write-plan` is the next step.

## Key Principles

- **One question at a time** — don't overwhelm with multiple questions
- **Multiple choice preferred** — easier to answer than open-ended when possible
- **YAGNI ruthlessly** — remove unnecessary features from all designs
- **Explore alternatives** — always propose 2-3 approaches before settling
- **Incremental validation** — present design in sections, get approval before moving on
- **Be flexible** — go back and clarify when something doesn't make sense
