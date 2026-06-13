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
trigger words route it. This table mirrors the installed skill set —
regenerate it from `~/.ytsejam/data/skills/` when skills change.

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

## §3 How I actually use it — the opinions

You saw the surface in §2. §3 is the less-neutral part: how I actually
run the thing, and the habits that keep it useful instead of theatrical.

### §3.1 The north star: ytsejam is a harness, not a chat app

ytsejam is a harness for using tools well. Chat is the foreground; the
work is what the agent does with bash, files, web, delegate, schedule,
and memory.

If you find yourself treating it like a chatbot, you are using it wrong.

▸ *Skip if you don't care about the north star.*

A chat app optimizes for the next reply. ytsejam optimizes for the work
around the reply: reading the repo before editing it, checking a file
instead of guessing, leaving a transcript, handing long work to a
subagent, waking up next Monday, and carrying forward enough memory that
the next session is not day zero.

Most chat apps do not have real work persistence: no owned cwd, shell,
durable JSONL transcript, scheduled prompts, background workers, or
maintained cross-session memory. They are good at conversation. ytsejam
is trying to be good at letting an agent *do* things while you can still
audit what happened.

So the main object is not the message bubble. The main object is the
harness: model routing, tools, skills, delegation, schedules, memory, and
transcripts wrapped into one loop. The UI stays small because the send
button is not the point. The point is whether the agent can see the right
context, use the right tool, and leave behind a trail you can resume.

This is also the hot-memory principle for ytsejam itself: ytsejam is the
final shape of the harness, not a snapshot of this month's interesting
agent wrapper. New parts are judged by whether they make *this* harness
better, not whether they mimic the next product demo.

Read §2 as the map of what exists. Read §3 as the reason those parts
exist in that shape.

### §3.2 The harness-check

Every new feature, skill, and tool gets one question: does this make the
harness better at letting the agent use tools, or is it just another
shiny thing to maintain?

Skills are cheap. Helper-heavy skills cost more. Server-side TypeScript
is expensive. Bias hard in that order.

▸ *Skip if you don't care about feature discipline.*

The cheapest durable improvement is usually a skill: a markdown playbook
that changes behavior without making the server more complicated. A
helper-heavy skill is the next step up: scripts, templates, generated
artifacts, or data-dir conventions. Sometimes that is right, but now you
have more moving parts and more ways for the workflow to rot.

Server code is the expensive move. Anything in `server/src/` means type
surfaces, tests, deployment, restart behavior, compatibility, and future
maintenance. It may be exactly right. It just has to earn the cost.

The gate I use is blunt: **Justify-server-change gate.** If a plan
touches `server/src/`, add an extra step where you name what this lets
the harness *do* that a skill could not do. Not what it makes prettier.
Not what would be neat. What it enables the agent to do with tools,
memory, schedules, sessions, or delegation that was otherwise blocked.

Good answers sound like: expose a safe tool surface; preserve a transcript
edge case; make scheduled prompts reliable; give subagents bounded
cancellation; remove a manual step from recurring unattended work. Weak
answers sound like: another app has this; the UI would be nicer; the
model might like it. Those can become skills, docs, prompts, or memory
patterns. They do not automatically earn server code.

The same check applies to substrate-swap urges. New harness candidates
show up constantly. Evaluate them as components inside ytsejam first: a
better browser tool, model route, search primitive, or local worker. Do
not start by replacing the substrate; that throws away the boring
accumulated shape that makes the harness useful.

This is not anti-change. It is pro-compounding. Skills compound because
they are cheap. Memory compounds because it is durable. Server changes
compound only when they improve the harness instead of feeding the urge
to rebuild it.

### §3.3 The operating cadence

Steady state is deliberately boring: weekly `/housekeeping`, then
`/reflect` in the same session; monthly `/evolve`; `/foresight` weekly
or when you actually want a nudge.

The anti-pattern is running every skill every day. Theatrical. Does not
work.

▸ *Skip if you don't care about cadence opinions.*

Memory maintenance needs signal, and signal takes time to accumulate. Run
`/reflect` every day in normal life and you mostly ask it to mine noise:
one-off notes, half-finished thoughts, and clusters that have not had
time to prove they are real.

That is why the weekly pair exists. `/housekeeping` cleans first: done
items, archive candidates, stale temporal hints, indexes. Then `/reflect`
looks at the cleaned state and asks what patterns survived. Same session
matters because the second step should see what the first just changed.

The idle window matters too. Consolidation is useful after the system has
had time to be boring: observations accumulate, threads repeat, action
items get done, and then the pipeline has something real to compress.
Force it daily and you starve it of the signal it is supposed to find.

Monthly `/evolve` audits the memory architecture itself: domains, routing,
file shape, and accumulated drag. That is not a daily question. Run it
constantly and you invite churn in the thing that should make everything
else stable.

`/foresight` is lighter. I like it weekly, or on demand when I am stuck,
changing domains, or about to plan a new push. Treat it as one forward-
looking nudge, not as an oracle.

There is one caveat: heavy work bursts are different. In a shipping burst,
research blitz, or multi-day implementation push, the rate can go higher
because observation volume is higher. Full burst-cadence rules in
[MEMORY.md §2.2](MEMORY.md#22-the-burst-cadence-caveat). The cadence rule
here is the steady state; the burst is the exception.

So: boring weekly pair, boring monthly audit, occasional foresight. The
point is not to perform maintenance. The point is to let memory get
better without turning memory into the job.

### §3.4 What NOT to ask it to do

Here is the honest list: do not throw everything at ytsejam just because
it can talk back confidently. Use it for narrow, verifiable,
asynchronous, deferred work.

The boundary is what makes it useful. If the task cannot tolerate a
transcript, delay, or verification step, it probably does not belong
here.

▸ *Skip if you don't care about the uncomfortable safety list.*

Do not ask it to handle anything where you would be embarrassed to share
the transcript. ytsejam transcript-logs what you ask. That is a feature
for auditability, but if the record would be a problem, do not put it in
the record.

Do not ask it to handle time-critical work. The agent is not always
running. Schedules fire only when the service is up. Background tasks
can queue, fail, time out, or wait behind other work. There is no SLA. If
a missed minute matters, use a system designed for missed minutes.

Do not ask it to make decisions where wrong answers hurt: medical,
legal, financial, safety-critical, or anything adjacent. The model can
sound calm and certain while being wrong. It will confidently lie. Use it
to organize questions, summarize documents you verify, or prepare a
checklist for a professional conversation. Do not outsource the decision.

Do not ask it for real-time data it cannot fetch. If the web tools can
reach a source, the agent can cite and inspect that source. If the data
requires a live feed, privileged API, current market tick, private
portal, or human-only context it does not have, it will either fail or
make something up unless you constrain it hard.

Do not ask it to do work you cannot verify yourself. This is the silent
error trap. In domains you do not understand, you cannot tell a correct
result from a plausible or subtly broken one. Use ytsejam to learn,
scaffold, draft, search, compare, and produce artifacts you can inspect.
Do not use it as your only judge.

Be careful with destructive operations too. If work deletes files,
rewrites history, cancels services, moves money, changes access, or
sends messages as you, stage it first and inspect the plan. The
transcript is an audit trail, not a force field.

The positive version is simple: ytsejam is excellent at work that is
asynchronous, inspectable, bounded, and recoverable. Research this and
cite sources. Audit this repo and report. Draft the plan. Run the test
and show me the exit code. Sweep memory. Prepare tomorrow's prompt.
Those are the shapes where the harness earns its keep.

### §3.5 Self-modification footnote

ytsejam is the substrate the agent runs on. Source edits are safe because
they do not affect the live process until rebuild plus restart, but a
deploy kills the live session.

Cutover is deliberate. Brian restarts the harness; the harness does not
casually restart itself mid-conversation.

▸ *Skip if you don't care about self-hosting the substrate.*

This shape is inherited from the predecessor. omnius had the same basic
pattern: the agent could edit the code for the thing it was running on,
but edits were inert until the human chose the cutover. That is a
settled operating pattern, not a ytsejam quirk.

The safe boundary matters for development work. A worktree-isolated
subagent can edit `server/src/` all day and nothing happens to the live
service. The change has to be reviewed, merged, deployed, and picked up
by a restart before the running assistant changes behavior.

That means source-level self-modification is less spooky than it sounds.
The live process is built from whatever was deployed at its last start.
The repo can move ahead of it; the worktree can move ahead of main. The
assistant does not suddenly become the code it just wrote.

A concrete example: I just rebased onto main with a Phase 6 change, but
I am still talking to the live process built from last week's main. It
will pick up my change only after the next rebuild, deploy, and restart.

The dangerous command is not "edit the source." The dangerous command is
"restart the service I am currently using" without meaning to cut over.
If a task needs deploy, make it explicit, expect the live session to die,
and let Brian decide when that interruption is worth it.

## §4 Glossary + further reading

- **AGENTS.md** — Repo-local instructions for AI agents, auto-loaded from the working directory ancestor chain when context files are enabled.
- **archive (session)** — A reversible hide operation for a session; the JSONL transcript remains the source of truth.
- **bootc/nbc** — The atomic OS image/update path used by Snow Linux workflows; see the `snow-nbc` skill in [§2.5](#25-skills--the-catalog).
- **brainstorm (skill)** — The dev-workflow skill for exploring requirements and design before implementation.
- **CLAUDE.md** — Another repo-local context file name ytsejam can auto-load alongside `AGENTS.md`.
- **cog memory** — ytsejam's markdown-backed persistent memory system; use [MEMORY.md](MEMORY.md) for depth.
- **compaction** — The process of summarizing earlier context when a long session gets too large to keep in the model window.
- **cwd / working directory** — The per-session directory that relative file, search, and shell tools resolve against; see [§2.2](#22-working-directories).
- **delegate** — The tool that starts a background subagent task and reports back into the parent session.
- **develop (skill)** — The dev-workflow skill that executes an implementation plan task-by-task with review gates.
- **domain (memory)** — A folder and routing unit in cog memory, such as `personal`, `work`, `infra`, or `projects/ytsejam`.
- **foresight** — The memory-pipeline skill that produces one cross-domain forward-looking nudge.
- **gate.sh** — A project's verification script, usually run before commit, merge, or handoff.
- **glacier** — The read-only archive tier for old memory material that should remain searchable without staying hot or warm.
- **harness** — The whole loop that lets the agent use models, tools, files, memory, schedules, and subagents as one system.
- **hot memory / warm memory / glacier** — The three memory tiers: always-loaded working set, on-demand domain files, and read-only archive.
- **housekeeping** — The weekly memory-maintenance skill that prunes, archives, sweeps stale markers, and rebuilds indexes.
- **idle window (memory pipeline)** — The quiet stretch between work bursts where accumulated observations become useful consolidation signal.
- **JSONL** — Newline-delimited JSON; ytsejam stores session transcripts this way so they are append-only and grep-able.
- **persona** — The global assistant instructions edited in Settings and applied from the next turn.
- **pi-harness** — The broader local-agent harness lineage ytsejam belongs to, centered on tool use, memory, and durable transcripts.
- **plan (doc)** — A task breakdown document, usually under `docs/plans/`, that turns an approved design into implementable steps.
- **reflect (skill)** — The weekly consolidation skill that mines cleaned memory for durable patterns.
- **schedule** — A one-shot or recurring future prompt delivered into a session when the service is running.
- **session** — A durable conversation thread with its own transcript, model choice, working directory, and state.
- **skill** — A markdown playbook the agent loads on demand; see [§2.5](#25-skills--the-catalog) for the catalog.
- **snosi** — Snow Linux's image/update ecosystem as used by the Snow OS skills.
- **snowloaded** — Optional Snow Linux system-extension software managed by Snow workflows such as `snow-updex`.
- **ssot (SSOT)** — Single source of truth: the discipline that one fact lives in one canonical place and other files link to it.
- **subagent** — A background worker with its own transcript, started by `delegate`, used for work that should not block the main chat.
- **task (delegated)** — A bounded unit of background work run by a subagent and reported back to the parent session.
- **tour (this doc)** — The §2 walkthrough of ytsejam's visible surface: sessions through the web UI.
- **transcript** — The append-only JSONL record of a session or subagent task.
- **warm memory** — Domain memory loaded on demand, such as observations, action items, entities, indexes, threads, and wiki pages.
- **ytsejam** — This self-hosted personal AI assistant harness.
- **YTSEJAM_*** — Environment-variable convention for ytsejam server configuration, such as models, data paths, context files, task limits, and memory paths.

### Further reading

1. [MEMORY.md](MEMORY.md) — the memory reference; use it when you need depth on memory.
2. [docs/agents/OVERVIEW.md](agents/OVERVIEW.md) — the architecture map; use it when you need to understand what's wired where.
3. [docs/agents/skills.md](agents/skills.md) — the skill-runtime reference; use it when you want to write your own.
