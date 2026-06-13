---
name: maintain-docs
description: Create or update AI-facing repo documentation under docs/agents/ — keeps docs/agents/OVERVIEW.md (Purpose / Architecture / Key Patterns / Configuration) current with the code, with dedicated subsystem docs linked from it, and ensures AGENTS.md has a breadcrumb to it. Doc-only, gated, one PR. Use to refresh agent docs, write/update OVERVIEW, or after a chunk of code change.
triggers: [maintain docs, update docs, agent docs, docs/agents, refresh documentation, OVERVIEW.md]
---

# maintain-docs

Keep the repo's **AI-facing documentation** current. The home is `docs/agents/`: `OVERVIEW.md`
is the entry point a future agent (or subagent, or human) reads to understand the codebase, with
dedicated docs for complex subsystems linked from it. You don't touch code — only docs — and you
ship the update as one gated PR.

**Announce at start:** "I'm using the maintain-docs skill."

`docs/agents/` is environment-neutral repo canon (auto-loaded into agents via the `AGENTS.md`
breadcrumb — see Phase 1). It's the same directory the `lessons` skill writes theme files into;
this skill owns the `OVERVIEW.md` spine.

## Phase 0 — Skip checks

- If a docs PR is already open (a branch like `docs/agents-*`), stop: "A docs PR is already
  open (#N). Merge or close it before regenerating." Don't stack docs PRs.
- Optional staleness gate: if nothing has changed since the last `maintain-docs` commit
  (`git log --oneline --grep "maintain-docs" -1` → compare to HEAD), note "docs current, nothing
  to do" and stop — unless the user explicitly asked for a refresh.

## Phase 1 — Worktree + ensure the AGENTS.md breadcrumb

```bash
cd <repo-root>
git worktree add /tmp/docs-agents -b docs/agents-$(date +%Y%m%d)
cd /tmp/docs-agents
[ -f package.json ] && ln -s <repo-root>/node_modules ./node_modules   # if Node
```

Ensure `AGENTS.md` (create it if absent) contains a breadcrumb to the agent docs. The breadcrumb
is the load-bearing link — `AGENTS.md` is auto-loaded into every agent's context, so the
breadcrumb is how anyone discovers `docs/agents/`. Ensure a block like this exists (add it if
missing; leave it if present):

```markdown
## Agent documentation

AI-facing docs for this repo live in `docs/agents/`. Start with
[`docs/agents/OVERVIEW.md`](docs/agents/OVERVIEW.md) — purpose, architecture, key patterns,
and configuration — and follow its links to subsystem docs. Read the relevant doc before
working in that area.
```

If `AGENTS.md` exists but has no such breadcrumb, append the block. If it exists and already
points at `docs/agents/OVERVIEW.md`, leave it. Commit this as its own small commit if it changed.

## Phase 2 — Write/update the docs (delegate)

`mkdir -p docs/agents`. Then delegate the doc work to a subagent (model
`github-copilot/claude-opus-4.8` — writing/reasoning work; a subagent cannot delegate further).
Brief it to:

1. Read the codebase to understand current structure, purpose, key patterns. Optionally read
   recent context: `git log --oneline -20`, the most recent files in `docs/plans/`, and any
   open/recent issues for what changed.
2. If `docs/agents/OVERVIEW.md` exists, read it AND every doc it links to, then UPDATE them to
   match the current code — **preserve accurate content, update only what's outdated.** If it
   doesn't exist, create it.
3. `docs/agents/OVERVIEW.md` is the entry point and MUST cover:
   - **Purpose** — what this repo does and its role (2-3 sentences)
   - **Architecture** — key directories, modules, how they fit together
   - **Key Patterns** — important conventions, data flow, design decisions
   - **Configuration** — key config values and env vars
4. For complex subsystems, create dedicated `docs/agents/<subsystem>.md` files (one subject each)
   and link them from OVERVIEW.md. Keep OVERVIEW.md concise (~200–500 lines); sub-docs can be longer.
5. **Do NOT make any code changes. Docs only.** Commit (commit-before-report) with a `docs:`
   message. Report what was created/updated.

(Write the doc content for an AI reading it as codebase context — architecture, patterns, and
decision rationale — not a user-facing guide.)

## Phase 3 — Gate + PR

After the subagent reports, from the worktree:
1. Verify the branch advanced: `git -C /tmp/docs-agents log main..HEAD --oneline`.
2. **Run `bash scripts/gate.sh`** (else the project's `quality gate:` command). It MUST pass —
   a docs-only change should pass trivially, but the gate is the iron law; no PR on a red gate.
3. Push + PR:
   ```bash
   git push -u origin docs/agents-<date>
   gh pr create --repo <owner/repo> --title "docs: update docs/agents for <repo>" \
     --body "Refreshes docs/agents/OVERVIEW.md (+ subsystem docs) to match current code. Doc-only." --base main
   ```
4. Report the PR URL.

## Phase 4 — Cleanup

After the PR is open (or merged): `git worktree remove /tmp/docs-agents`.

## Red Flags

**Never:**
- Make a code change — this skill is doc-only. (If a doc reveals a code bug, file a `weed` issue or note it; don't fix it here.)
- Open a PR on a failed gate.
- Regenerate from scratch when an OVERVIEW.md exists — UPDATE it, preserving accurate content.
- Stack a second docs PR while one is open.
- Skip the AGENTS.md breadcrumb — without it the docs/agents/ tree is undiscoverable to agents.

## Integration

**Writes:** `docs/agents/OVERVIEW.md` + subsystem docs + the `AGENTS.md` breadcrumb.
**Pairs with:** `lessons` (writes theme files into the same `docs/agents/` the breadcrumb covers).
**Uses:** `delegate`, `gh` CLI, git, the gate.
