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
