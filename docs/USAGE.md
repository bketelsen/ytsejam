# ytsejam usage

Table of contents:

- [§0 Before you read](#0-before-you-read)
- [§1 tl;dr — ytsejam in 60 seconds](#1-tldr--ytsejam-in-60-seconds)
- [§2 The tour](#2-the-tour)
  - [§2.1 Sessions](#21-sessions)
  - [§2.2 Working directories](#22-working-directories)
  - [§2.3 Models](#23-models)
  - [§2.4 Tools the agent has](#24-tools-the-agent-has)
  - [§2.5 Skills — the catalog](#25-skills--the-catalog)
  - [§2.6 Subagents (delegate)](#26-subagents-delegate)
  - [§2.7 Schedules](#27-schedules)
  - [§2.8 Memory in 5 minutes](#28-memory-in-5-minutes)
  - [§2.9 The web UI](#29-the-web-ui)
- [§3 How I actually use it — the opinions](#3-how-i-actually-use-it--the-opinions)
  - [§3.1 The north star: ytsejam is a harness, not a chat app](#31-the-north-star-ytsejam-is-a-harness-not-a-chat-app)
  - [§3.2 The harness-check](#32-the-harness-check)
  - [§3.3 The operating cadence](#33-the-operating-cadence)
  - [§3.4 What NOT to ask it to do](#34-what-not-to-ask-it-to-do)
  - [§3.5 Self-modification footnote](#35-self-modification-footnote)
- [§4 Glossary + further reading](#4-glossary--further-reading)

## §0 Before you read

This is the friend-handoff doc for ytsejam: what to do once it is already running, how to think about sessions and tools and memory, and which habits make it useful day to day. It is not the install guide; use [README.md](../README.md) for prerequisites, deployment, configuration, security, backup, and troubleshooting. It is not the memory deep dive; `MEMORY.md` is where the cog model, domains, tiers, and maintenance cookbook live. It is not the repo guide for AI agents editing ytsejam; that starts in [docs/agents/](agents/OVERVIEW.md). Read this once front-to-back if you are new, then use the table of contents when you need a reminder. The `▸ *Skip if you don't care about X*` markers are honest: they mark depth, not required reading, and the doc still works if you skip every one of them.

## §1 tl;dr — ytsejam in 60 seconds

ytsejam is a web-based personal AI assistant: you open it in a browser, talk to it in sessions, and it runs on your machine as a `systemd --user` service instead of living inside somebody else's chat product. It has persistent cross-session memory, so useful facts can survive beyond the tab you said them in. It can do real work through tools: read and edit files, run shell commands, search the web, fetch pages, inspect a repo, and use the memory system. It can delegate long-running work to background subagents, keep chatting while they run, and report back when they finish. It can also wake itself on schedules, which turns reminders and recurring maintenance into prompts to your future assistant instead of calendar noise.

The five things that matter:

**Sessions** are the durable conversation threads; each one has its own transcript, working directory, model choice, and history you can come back to later.

**Tools** are the assistant's hands; when it needs facts from disk, the web, a shell, a schedule, or memory, you will see tool calls in the stream instead of magic.

**Skills** are markdown playbooks the assistant loads on demand; they are the cheap, opinionated way to teach it a repeatable workflow without adding server code.

**Subagents** are background tasks for work that should not block the main chat: research this, audit that, run the boring sweep, then come back with a report.

**Memory** is the cross-session layer that lets the assistant carry forward stable facts, open loops, project context, and patterns instead of treating every session as day zero.

Open the UI, sign in with your token, send a message. Everything below this is depth.

## §2 The tour

This section is the walking tour: the nouns you see in the UI, what they
mean on disk, and how to avoid the common foot-guns. Read the takeaway
at the top of each subsection; open the depth only when you need it.

### §2.1 Sessions

A session is a durable conversation thread. On disk, the truth is a
JSONL transcript under `~/.ytsejam/data/sessions/`; the sqlite database
is only a rebuildable index for fast lists and filters.

The sessions list is your inbox of threads. Archive hides a session
without deleting it, auto-titles make new threads readable after the
first exchange, and JSONL means you can grep your own history when the
UI is not enough.

▸ *Skip if you don't care about session internals.*

The session row carries more than chat text. Each session can have its
own model, its own working directory, its own unread/running/compacting
state, and its own sidecar archive flag. Those sidecars matter: archive
is a soft delete, not a delete endpoint, and unarchive just appends
another event saying the session is visible again.

Long sessions are meant to be resumed. Open an old session, read the
last few turns, and continue; the transcript is still there. When
context gets tight, ytsejam can compact the earlier conversation and
keep going instead of forcing you to start over. The rule of thumb:
resume when the same thread is still useful, start fresh when the task
has changed and the old context would mostly distract.

Persona is mostly global today: the Settings dialog edits
`persona/persona.md`, and that applies from the next turn. For a
one-session override, say it plainly at the top of the thread — for
example, "for this session, be a skeptical reviewer" — and the
instruction lives in that session's transcript. If you find yourself
repeating the same override, make it a skill or fold it into persona.

Because JSONL is truth, you are not locked into the UI. You can back up
`~/.ytsejam/data`, grep `sessions/*.jsonl`, or rebuild the sqlite index
by restarting. If deleting `index.db` would lose the thing you care
about, that thing was stored in the wrong place.

### §2.2 Working directories

Every session has an effective working directory. The shell and file
tools — `bash`, `read`, `write`, `edit`, `ls`, `grep`, and `find` —
resolve relative paths against it.

Set the working directory when you want the assistant to work in a repo
or project folder. ytsejam also auto-loads `AGENTS.md` and `CLAUDE.md`
from that directory's ancestor chain into the system prompt, so the
right repo guidance follows the session.

▸ *Skip if you don't care about cwd plumbing.*

In the chat composer, use the folder button at the lower left. It opens
the working-directory dialog. Enter an absolute path to an existing
directory; the server validates it, stores it as a per-session JSONL
sidecar, and rebuilds the cwd-bound tools live. The next turn also
refreshes context-file ancestry, so changing directories mid-session is
allowed.

Set a workdir before you ask for file edits, repo searches, tests, or
shell commands. If you do not set one, the default is the data dir,
which is fine for general chat and memory work but usually wrong for
coding. For multi-repo work, either use absolute paths in the prompt or
keep separate sessions per repo; separate sessions are cleaner.

`YTSEJAM_CONTEXT_FILES` controls the context-file behavior. It defaults
to `true`, which loads `AGENTS.md`/`CLAUDE.md` from `~/.pi/agent` and
from the session workdir's ancestor chain. Set it to `false` only when
those files are misleading or too noisy for the way you use ytsejam.

### §2.3 Models

The model picker changes the model for the current session. The default
comes from `YTSEJAM_DEFAULT_MODEL`, and the picker only shows models
backed by credentials ytsejam can actually use.

Use cheaper models for shuffling, cleanup, summaries, and low-risk
mechanical work. Use the smarter model for design, debugging, ambiguous
edits, and anything where a wrong answer is expensive.

▸ *Skip if you don't care about model routing.*

Model references are `provider/modelId`, for example `anthropic/...` or
another provider exposed by the pi-ai catalog. Credentials decide what
appears: provider API keys such as `ANTHROPIC_API_KEY` and
`OPENAI_API_KEY` enable those providers, while `~/.pi/agent/auth.json`
can expose OAuth-backed pi CLI models. Environment API keys win over
OAuth where both are present.

A session's model choice is durable. Switching models in Settings
patches the current session; it does not rewrite your global default and
it does not change every old thread. That is the behavior you usually
want: one messy debugging thread can run hot without making every
reminder expensive.

Delegated subagents have their own default, `YTSEJAM_SUBAGENT_MODEL`,
which falls back to `YTSEJAM_DEFAULT_MODEL`. The `delegate` tool also
accepts a per-task `model` override, so a parent assistant can say: run
this cheap sweep on the small model, but run this design review on the
strong model. Bad model names fail early at the tool call instead of
halfway through the task.

### §2.4 Tools the agent has

Tools are the assistant's hands. When it needs the filesystem, shell,
web, schedules, background workers, or memory, it calls a tool and you
see that call in the message stream.

The short version: assume tools are powerful, visible, and run with the
ytsejam process's permissions. For the full implementer surface, see
[docs/agents/tools.md](agents/tools.md).

▸ *Skip if you don't care about tool-call mechanics.*

| Tool | What it does |
| --- | --- |
| `bash` | Runs `bash -c` in the session's working directory, with stdout/stderr and exit code returned. |
| `read` / `write` / `edit` | Reads text files, writes files, or replaces one exact unique text occurrence. |
| `ls` / `grep` / `find` | Lists directories, searches file contents with recursive regex, or finds files by glob. |
| `web_search` | Uses Brave Search; requires `BRAVE_API_KEY`. |
| `web_fetch` | Fetches a URL and converts readable HTML to text. |
| `delegate` | Starts a background subagent task and returns immediately with a task id. |
| `schedule` | Creates one-shot or recurring prompts that wake the assistant later. |
| `cog_*` | Reads, writes, searches, patches, and audits persistent memory. |

Tool calls render as collapsible cards inside the assistant's message.
The header tells you the tool name and whether it is running, errored,
or done. Open the card to see the arguments and the result. For `bash`,
the important details are the command, output, and exit code. For
file/search tools, check the path and remember that relative paths mean
"relative to this session's working directory."

Reading tool results is part of using the system well. If the agent says
it ran tests, open the `bash` card and look for the exit code. If it
says it edited a file, the `edit`/`write` call tells you exactly which
path it touched. This is not just transparency; it is the audit trail
that makes an agent with shell access sane.

### §2.5 Skills — the catalog

A skill is a markdown playbook the agent loads on demand. Skills are how
ytsejam teaches repeatable workflows — design, develop, review, memory
maintenance, browser work — without adding server code.

Invoke one explicitly with `/name`, or just describe the task and let
trigger words route it. This table is the source of truth for installed
skill descriptions.

▸ *Skip if you don't care about the skill catalog.*

| Group | Skill | Purpose | Invoke when |
| --- | --- | --- | --- |
| dev-workflow | `brainstorm` | Explore requirements and design before implementation. | starting any creative work: features, components, behavior changes |
| dev-workflow | `write-plan` | Break an approved design into bite-sized tasks; create the worktree. | after brainstorm produces an approved design |
| dev-workflow | `develop` | Execute a plan: fresh implementer per task plus two-stage review. | running an implementation plan task by task |
| dev-workflow | `review` | Two-pass code review: spec compliance, then quality. | manually before merging, or via develop after each task |
| dev-workflow | `ship` | Verify gate, route reports to memory, merge/PR/keep/discard, cleanup. | implementation done, ready to wrap up the branch |
| dev-workflow | `lessons` | Capture a lesson from a fix cycle into `docs/agents/<theme>.md`. | after any fix-cycle in develop; or on demand |
| code-hygiene | `find-weeds` | Scan a codebase for small safe fixes; file up to 5 GitHub issues. | code hygiene pass, "find things to clean up" |
| code-hygiene | `pull-weeds` | Resolve open `weed`-labeled issues with one gated PR each. | clearing the weed backlog |
| docs | `maintain-docs` | Update AI-facing repo docs under `docs/agents/`. | refresh agent docs, update `OVERVIEW.md` |
| docs | `write-a-skill` | Author a new agent skill: structure, triggers, progressive disclosure. | creating a new skill |
| docs | `create-gate` | Create a gate script for a project. | "create a gate", "set up the gate for X" |
| browser | `agent-browser` | Drive a real browser: snapshot/ref, click/fill, screenshots. | any web interaction, form filling, data extraction |
| OS | `snow-nbc` | Snow Linux atomic OS updates via nbc/bootc. | install/update snosi OS image |
| OS | `snow-updex` | Snow Linux system extensions: Docker, dev tools, Incus. | enable/disable optional snowloaded software |
| memory pipeline | `cog` | Bootstrap or reconfigure memory domains. | first-time setup, adding a domain |
| memory pipeline | `housekeeping` | Memory maintenance — archive, prune, temporal sweep, rebuild indexes. | weekly, or more in a token burst, before `/reflect` |
| memory pipeline | `reflect` | Mine recent activity for patterns; 3-gate consolidation. | weekly, in the same session as `/housekeeping` |
| memory pipeline | `evolve` | Monthly architecture audit of the memory system. | monthly |
| memory pipeline | `foresight` | Cross-domain strategic scan to produce one forward-looking nudge. | weekly or on demand |
| memory pipeline | `history` | Deep memory search and narrative reconstruction. | "when did I", "what happened with", timeline questions |
| memory pipeline | `pkb-research` | Long-running research file for a single question. | start or extend research on a single topic |
| domain-routing | `personal` | Family, home, day-to-day. | trigger words: family, kids, home, car, finance |
| domain-routing | `work` | Employer, job, colleagues, career. | trigger words: work, job, employer, meeting |
| domain-routing | `projects` | Side projects and open source, as a parent domain. | trigger words: project, side project, repo, ship |
| domain-routing | `ytsejam` | The substrate this agent runs on. | trigger words: ytsejam, harness, substrate |
| domain-routing | `pkb` | Personal knowledge base — research, synthesis. | trigger words: pkb, research, paper, blog |
| domain-routing | `infra` | Hosts, appliances, daemons. | trigger words: infra, truenas, systemd, daemon |
| domain-routing | `truenas-mcp` | TrueNAS MCP server project. | trigger words: truenas-mcp, mcp |

*Regenerate this table when adding or removing a skill — the source of truth is the skill set installed in `~/.ytsejam/data/skills/`.*

Memory-pipeline skills are *narrated* in [MEMORY.md](MEMORY.md#17-the-pipeline--narrative) §1.7 — this catalog has their names; MEMORY tells you when and why to run them.

To write your own skill, use [`write-a-skill`](#25-skills--the-catalog).
A skill can be a flat `~/.ytsejam/data/skills/<name>.md` file or a
bundle at `~/.ytsejam/data/skills/<name>/SKILL.md`. Give it frontmatter
with `name`, `description`, and `triggers`, then write the playbook like
you would hand instructions to a careful coworker.

There are seeded skills and user skills. Seeded skills live in the repo
under `server/skills/` and are copied into the data dir only if missing.
User skills live in `~/.ytsejam/data/skills/`, and the user-dir copy
wins. That precedence is intentional: you can customize a live skill
without waiting for a build, a deploy, or a repo change.

### §2.6 Subagents (delegate)

Use a subagent for work that would block the chat: long research,
multi-step implementation, audits, sweeps, or anything where you want a
report later instead of watching every tool call inline.

You can ask naturally: "delegate this and tell me when done." The
assistant calls `delegate`, a background task starts, you keep chatting,
and a `[Task ...]` message lands in the parent session when it
completes, fails, times out, or is interrupted.

▸ *Skip if you don't care about background-task details.*

Delegation is in-process but separate. The subagent gets its own JSONL
session and its own harness, while the parent chat remains usable. The
task prompt must be self-contained because the subagent does not see the
whole parent conversation. Good delegation prompts include the goal,
exact paths, acceptance criteria, and what the final report should
contain.

Two knobs keep subagents bounded: `YTSEJAM_TASK_CONCURRENCY` (default
`4`) is the max number running at once, and `YTSEJAM_TASK_TIMEOUT_MIN`
(default `15`) is the per-task timeout. Extra tasks queue. Timed-out
tasks are recorded as failed and reported back instead of hanging
forever.

Model routing works here too. `YTSEJAM_SUBAGENT_MODEL` sets the default
for delegated work, and the `delegate` call can override the model per
task. The Tasks dialog shows task status and lets you open the
transcript view, which is the subagent's real conversation. You can
cancel pending or running tasks from the UI; cancellation is
event-sourced first, so the task will not later notify as if it finished
normally.

One sharp edge: subagents inherit the parent session's working directory
for file/shell tools, and they cannot delegate further. If the task
needs files outside that workdir, put absolute paths in the
instructions.

### §2.7 Schedules

Schedules are prompts to the future assistant. They can be one-shot with
`at` or recurring with five-field `cron`; cron times are server-local
time.

A scheduled prompt arrives later as a `[Scheduled task ...]` message. It
arrives without the rest of your present-moment context, so write it as
a complete instruction to your future self.

▸ *Skip if you don't care about scheduler details.*

You usually create schedules by asking: "tomorrow at 9, remind me to..."
or "every Monday morning, ask me to run housekeeping." The assistant
calls `schedule` with either an ISO timestamp (`at`) or a cron
expression (`cron`). It can also call `list_schedules` and
`cancel_schedule`; the Settings dialog shows existing schedules and
provides Cancel buttons for active ones.

The target matters. `this_session` injects into the current session,
which is useful when the future prompt is part of an ongoing thread.
`new_session` starts a fresh session, which is better for stand-alone
reminders or recurring maintenance. If in doubt, use `new_session`;
stale old context is worse than a clean prompt.

Cron syntax is the standard five-field shape: minute, hour, day of
month, month, day of week. Keep it boring unless you enjoy debugging
time math. Also remember the server-local-time rule: if ytsejam runs on
a box in a different timezone than your laptop, the box wins.

### §2.8 Memory in 5 minutes

The assistant has persistent memory across sessions. The bare minimum:
tell it what is worth remembering, let it write memory, and run the
maintenance cadence instead of treating memory as magic.

Memory is organized into domains such as `personal`, `work`,
`projects/<sub>`, `infra`, and `pkb`. Each domain has hot memory that is
loaded under every conversation, warm files loaded on demand, and a
glacier archive for old material.

▸ *Skip if you don't care about memory yet.*

Hot memory is the tiny working set: under every conversation, capped at
about 50 lines, rewritten freely. Warm memory is the larger domain
material — observations, action items, entities, indexes, threads, wiki
pages — that the agent reads when the domain activates. Glacier is the
read-only archive for material that should remain searchable without
staying hot.

The opinionated cadence is weekly: run `/housekeeping`, then run
`/reflect` in the same session. Housekeeping archives and prunes first;
reflect then mines the cleaned state for patterns. Monthly, run
`/evolve` to audit the memory architecture itself. `/foresight`,
`/history`, and `/cog` are on-demand tools for nudges, reconstruction,
and domain setup.

You do not have to do the file work yourself. Ask the agent to run the
cadence and it will use the memory tools. Your job is to be clear when
something should survive: "remember this," "log this in work," "add an
action item," or "this belongs in the ytsejam domain."

Everything below this section about memory is in [MEMORY.md](MEMORY.md) — go there when you want depth.

### §2.9 The web UI

The UI is deliberately small: sessions on the left, messages in the
center, composer at the bottom, Settings and Tasks one click away. The
transcript is the main object; everything else exists to keep the
transcript understandable.

You can watch tool calls, task cards, compaction, schedules,
archive/unarchive, model changes, and working-directory changes without
leaving the browser.

▸ *Skip if you don't care about UI affordances.*

The sidebar lists active sessions with title, preview, relative update
time, and state dots for running, unread, or compacting sessions. "New
chat" starts a fresh thread. The archive button hides a session without
deleting it, and "Show archived" opens the reversible archive panel.

The message stream renders markdown, thinking blocks, tool-call cards,
task cards, and compaction summaries. When context fills, the agent
compacts at an idle boundary; you see a pulsing compaction pill at the
top of the chat and a compacted summary in the transcript afterward.
Tool cards are collapsed by default: open them when you want arguments,
output, or errors.

The Settings dialog owns persona, the current session's model picker,
and the schedules list. The Tasks button opens the tasks tab/dialog with
background subagent status; task cards also let you view the subagent
transcript. The composer sends on Enter, inserts a newline with
Shift+Enter, and the working-directory folder button opens the cwd
editor. In the cwd editor, Enter saves and Escape closes.

Messages have hover/touch affordances: relative timestamps appear near
the bubble, the full timestamp is in the tooltip, and the copy button
copies the human-facing text of that message. Tool JSON is intentionally
not copied by that button; if you need it, open the tool card and select
the details directly.
