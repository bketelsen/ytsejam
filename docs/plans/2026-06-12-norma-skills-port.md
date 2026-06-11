# Plan: Port the norma-* dev-workflow skills to ytsejam

**Status:** APPROVED 2026-06-11 — Brian answered all 5 open questions + 3 corrections (below). Ready to build, one skill at a time, spine first. Nothing lands without per-skill review of each `SKILL.md`.
**Type:** skill port (USER skills, NOT seeded). Output is markdown skill bundles in `~/.ytsejam/data/skills/<name>/` — no ytsejam server code.
**Research:** `/tmp/norma-skills-port-findings.md` (subagent 019eb808) — substance sound; its storage-mapping (M2) and "no ytsejam cog domain" claims are SUPERSEDED here (it read a stale clone `~/projects/cog/memory`, since moved to `~/archive/cog`; the live store is `~/.chapterhouse/memory` and `projects/ytsejam` exists).
**Source:** `/home/bjk/.chapterhouse/skills/norma-*` (Chapterhouse). Dispatch-target agents at `/home/bjk/.chapterhouse/agents/{coder,general-purpose,designer}.agent.md` — confirmed TINY generic-role prompts (no nesting, no real persona weight; `@coder` ≈ "be a careful engineer"). So the named-agent distinction is cosmetic: the substantive per-task instructions live in norma-develop's `implementer-prompt.md` + reviewer prompts, which fold into the `delegate` task body.

## Decisions (Brian, 2026-06-11)
- **Q1 Naming: DROP `norma-` prefix** → `develop`, `ship`, `brainstorm`, `write-plan`, `review`, `lessons`, `find-weeds`, `pull-weeds`.
- **Q2 Manifests: TAILS** (structured report tails). Brian: "vaguely remember better luck with a durable manifest, but start with tails and evolve if needed." → D4 is tails; revisit later if the loop loses state.
- **Q3 Worktrees: `/tmp/<branch>`** — fine as-is, not worth changing. (Brian floated `$DATA/.worktrees/<project>` but said tmp is fine.)
- **Q4 Cadence: ONE SKILL AT A TIME**, Brian reviews each `SKILL.md`.
- **Q5 Specs: live in the REPO** (not a cog-wiki page). So brainstorm/review's "spec" = a doc in `docs/plans/` (e.g. the design doc).
- **No nested dispatch ever existed** in the source (Brian confirmed); agents were named but minimal. Port preserves the prompt CONTENT, drops the agent NAMES.

---

## 0. What & why

Port Brian's proven Chapterhouse dev-workflow skill suite (the one ytsejam itself was built with) into ytsejam, removing tools/ideas that don't exist here. These skills shape how well we build everything going forward — so: **faithful-first** (preserve each skill's working essence, especially `brainstorm` which is the favorite), change only what the environment forces, and flag every deviation for veto.

Install as **USER skills** (directory bundles under `~/.ytsejam/data/skills/<name>/SKILL.md`), NOT seeded into `server/skills/`. They're Brian's personal workflow, not ytsejam's own pipeline skills.

Naming: **drop the `norma-` prefix** (consistent with `create-gate`). So `norma-develop` → `develop`, etc. (Open Q1 below — confirm.)

---

## 1. The seven up-front decisions (decide ONCE, apply across all skills)

These collapse every per-skill rewrite into mechanical work. **This is the section to review hardest** — everything downstream follows from it.

### D1 — Delegation: anonymous `delegate`, main-agent-orchestrated, no nesting
Chapterhouse used `delegate_to_agent(@coder)` / `(@general-purpose)` with named agents and (apparently) nested dispatch. **ytsejam has one tool `delegate({task, label, context, model})`, no named agents, and SUBAGENTS CANNOT DELEGATE FURTHER.**
- Role is communicated in the `task` prompt body ("You are the implementer for task N…" / "You are the spec-compliance reviewer…"), not an agent name.
- The **main agent** runs the implement→spec-review→quality-review loop by calling `delegate` repeatedly (sequential where ordered, parallel where independent). Reviewer dispatch is NEVER done by the implementer subagent.
- Every implementer/reviewer prompt body gets a defensive line: *"You cannot delegate further — do the work yourself."*
- Model is chosen via `model: "provider/modelId"`. **Leave exact model strings as `<TODO: pick current model>`** — the report's examples are stale; Brian fills from the live picker.

### D2 — Storage: three-way split (Brian's corrected model — SUPERSEDES the research)
**The wiki is NOT dropped.** ytsejam has no separate `wiki_update` tool and no Chapterhouse `pages/` path — but it HAS a wiki tier under the cog memory root (`wiki/…`), fully reachable via the normal cog tools (`cog_read`/`cog_write`/`cog_append`/`cog_patch`/`cog_search` against `wiki/...` paths — verified). So "porting the wiki" = **keep writing/reading the wiki, just through cog at the `wiki/` path** instead of `wiki_update` at `pages/`.

| What | Where | How |
|---|---|---|
| **Heavy canonical plan files + specs** (per-feature) | **the project repo** | `<repo>/docs/plans/YYYY-MM-DD-<slug>.md`, committed as canon. **Specs live here too (Q5)** — a spec is a section of, or a sibling `-design.md` to, the plan doc. |
| **Durable decisions / research / cross-cutting narrative** | **cog wiki tier** | `cog_write`/`cog_append`/`cog_patch` to `wiki/projects/<slug>/<page>.md` (e.g. `wiki/projects/<slug>/decisions.md`). This is the real wiki — same content norma wrote, different tool path. |
| **Working state / pointers / lessons / dev-log** | **cog domain files** | `cog_append`/`cog_write` to `projects/<slug>/{hot-memory,observations,dev-log}.md` |

Mechanical swaps everywhere: `wiki_update pages/projects/<slug>/X.md` → `cog_write`/`cog_append("wiki/projects/<slug>/X.md", …)`; `cog_edit` → `cog_patch`. The DISTINCTION that matters: a *plan/spec* (big, per-feature, canonical) goes to the **repo**; a *decision/research note* (durable narrative) goes to the **cog wiki**; a *pointer/lesson* goes to **cog domain files**. Hits `brainstorm`, `write-plan`, `develop`, `review`, `ship`.

### D3 — Gate: `scripts/gate.sh` + cog hot-memory note (already canonical via create-gate)
Drop `projects_rules <slug>` and `rules.md`/`gate_script`-frontmatter everywhere. Replace with: run `bash scripts/gate.sh` if present; else read `projects/<slug>/hot-memory.md` for the `quality gate:` line. Hits `develop`, `ship`, `pull-weeds`.

### D4 — Manifests: report tails (DECIDED — Q2)
Chapterhouse's `_manifests/task-NN.md` files bridged "subagent writes file → later step reads file." ytsejam returns the subagent's final message verbatim to the parent, which **collapses that bridge**. So: the implementer prompt requires the subagent to END its report with `## Decisions / ## Patterns Discovered / ## Lessons / ## Blockers / ## Context for Continuation`; the main agent reads those from the report text and routes them (per D2). Per-task `## Blockers` check still runs in the loop. **Brian's note: he vaguely recalls better luck with a durable manifest — so this is the START; if the loop loses state across long sprints, evolve to subagent-written `task-NN.md` files in the `/tmp/<branch>/` worktree. Build tails first.**

### D5 — Worktrees: `/tmp/<branch>` out-of-repo + commit-before-report (DECIDED — Q3)
Use the pattern proven across this session's dev: isolated worktree under `/tmp/<branch>`, branch off `main`, **subagent commits an early WIP checkpoint the moment its owned set compiles and commits-before-report**, orchestrator re-verifies via `git log base..HEAD` + fsck before trusting a truncated report. Keep the node_modules symlink trick (ytsejam is Node). Bake the commit-before-report mandate into every implementer prompt. (Brian floated `$DATA/.worktrees/<project>` as an alternative but confirmed `/tmp` is fine — not worth the change.)

### D6 — `triggers:` frontmatter on every ported skill
ytsejam routes skills onto the system-prompt table from a `triggers: [...]` array (Chapterhouse skills only have name+description). Every ported skill gets one. Suggested triggers per skill are in the research (§2.x).

### D7 — Cog-domain existence: NO defensive skip needed (corrects the research)
The research said "projects/ytsejam may not be a registered domain, skip cog writes defensively" — that was from reading the stale clone. The live store HAS `projects/ytsejam` and all the active domains. **No defensive skip.** The real rule: these skills operate on whatever project = the session's working dir; if a *new* project isn't yet a cog domain, the skill says "run `/cog` to register it first" (one red-flag line), not "silently skip."

---

## 2. Scope

**Port (8 skills):** `brainstorm`, `write-plan`, `develop` (+ 3 bundled reviewer prompts), `review`, `ship`, `lessons`, `find-weeds` (+REFERENCE.md), `pull-weeds` (+REFERENCE.md).
**Drop:** `norma-setup-skills` (+5 bundled files) — it configures consumer skills (`to-issues`/`triage`/`tdd`/`grill-with-docs`/…) that aren't being ported; its one universal fact ("GitHub via gh") is just assumed. Remove its cross-link from `brainstorm`.
**Already done:** `create-gate` (reference pattern). `write-a-skill` already exists in ytsejam (don't port the Chapterhouse one).

## 3. Port order (topological — from the dependency graph)

Each skill ported + reviewed + verified before the next where there's a dependency. Independent ones can interleave.

1. **lessons** (leaf; only `delegate` + git)
2. **develop** (central; OWNS the 3 reviewer prompt templates; needs lessons)
3. **review** (references develop's reviewer templates)
4. **ship** (needs lessons; routes report tails per D2/D4)
5. **write-plan** (hands off to develop)
6. **brainstorm** (favorite — hands off to write-plan; port faithfully)
7. **find-weeds** (independent; parallel-delegate showcase)
8. **pull-weeds** (independent; uses the gate, already in place)

(Build mechanics per skill: dir bundle in `~/.ytsejam/data/skills/<name>/`, dedupe norma-develop's duplicated body, add triggers, apply D1–D7, then verify via the live `/skill <name>` tool that it loads + reads right. No deploy needed — user skills load fresh.)

## 4. Per-skill deltas (the specific edits; full inventory in research §2)

- **lessons** — `delegate_to_agent`→`delegate` for synthesis; drop `projects_list` (use session cwd); keep `.github/instructions/<theme>.md` output (real Copilot convention) + Copilot co-author trailer. Verdict CLEAN.
- **develop** — biggest edit. Dedupe doubled body. Rewrite 3 prompts (implementer/spec/quality) to anonymous `delegate` with in-prompt role + "can't delegate further" + commit-before-report (D5). Plan read from `docs/plans/` (D2). Gate per D3. Manifests→report tails (D4). Add the explicit red flag: implementer never dispatches a reviewer. Verdict HARD (surface area, not no-equivalent).
- **review** — thin wrapper on develop's two reviewer prompts; spec path → `docs/plans/<...>` / latest plan; `@coder`→`delegate` for fixes. Verdict CLEAN.
- **ship** — Step 1 gate per D3. Step 2 manifest-routing reads report tails (D4) and routes per D2 (decisions→cog wiki `wiki/projects/<slug>/decisions.md` OR `projects/<slug>/observations.md` `[decision]`; global patterns→`cog_patch cog-meta/patterns.md`; lessons→invoke `lessons`; blockers→`gh issue create`; continuation→rewrite `projects/<slug>/hot-memory.md`). Step 8 wiki update → `cog_append projects/<slug>/dev-log.md` + a cog-wiki shipped note. PR `## Spec` link → repo `docs/plans/`. Verdict MODERATE.
- **write-plan** — kill wiki write; plan → repo `docs/plans/YYYY-MM-DD-<slug>.md` only (D2). Worktree per D5. Manifests per D4. Handoff prose → `develop`. Verdict MODERATE.
- **brainstorm** (FAVORITE — faithful port) — keep the Socratic design dialogue intact. Only: spec write → repo `docs/plans/YYYY-MM-DD-<slug>-design.md` (Q5: specs in repo; this half is already ytsejam-shaped); "check project wiki" → `cog_read("wiki/projects/<slug>/...")` (the wiki IS kept, via cog) + `cog_read projects/<slug>/hot-memory.md` + `git log` + README/AGENTS; drop the setup-skills cross-link; `@coder` mention → `delegate`. Verdict CLEAN. **Review this one most carefully — it's the keystone of Brian's workflow; port faithfully, minimal touch.**
- **find-weeds** — parallel `delegate` (2 different reasoning models, `model:` param, TODO strings); drop `get_agent_result` (results arrive as `[Task ...]` messages inline); drop explicit CONTEXT.md read (harness auto-loads AGENTS.md/CLAUDE.md per the context-files feature); `gh issue create`/`gh label list` keep. Verdict MODERATE.
- **pull-weeds** — parallel `delegate` per issue (+ "can't delegate further"); gate per D3; worktrees per D5 + keep node_modules symlink; **drop the SQL `todos`/`todo_deps` tracking → a `/tmp/<sprint>-todos.md` table** (no kanban in ytsejam); memory writes already cog-shaped (D7 — no defensive skip). Verdict MODERATE.

## 5. Decisions resolved (was "open questions")

All five answered by Brian 2026-06-11 — see the Decisions block at the top. Summary: drop `norma-` prefix (Q1); report-tails for manifests, evolve to durable if needed (Q2); `/tmp/<branch>` worktrees (Q3); one skill at a time with per-skill review (Q4); specs live in the repo `docs/plans/` (Q5). Plus: no nested dispatch ever existed; wiki is KEPT (via cog at `wiki/` path), not dropped. `setup-skills` confirmed DROP.

## 6. Non-goals
- No ytsejam server code (pure skill markdown).
- Not porting the consumer skills (`to-issues`/`triage`/`tdd`/`grill-with-docs`/`diagnose`/etc.) — separate later decision; nothing in this set depends on them once `setup-skills` is dropped.
- Not seeding into `server/skills/` — these are user skills.
