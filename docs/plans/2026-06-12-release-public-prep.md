# Public Release Prep Implementation Plan

> Execute with the `develop` skill, task-by-task.

**Goal:** Make the ytsejam repo safe and adoption-ready for public release at github.com/bketelsen/ytsejam.

**Spec:** Three release-audit reports under `~/.ytsejam/data/release-audit/` (`01-pii-working-tree.md`, `02-git-history.md`, `03-install-runtime-docs.md`) plus the ground-truth re-grade against the 207-file tracked surface and the post-compaction re-check.

**Architecture:** Two publish-blockers fixed at the code/legal layer (loopback-by-default listener + MIT license), followed by a bounded docs cleanup (prereqs, security model, env-var reconciliation, troubleshooting/uninstall, doc-path/Brian-name polish). Each task is independently shippable; the gate runs at every commit. Credential rotation is operational and happens out-of-band, not as part of this branch.

**Tech Stack:** Node ≥22, TypeScript, Hono on `@hono/node-server`, systemd `--user`, Markdown docs.

**Worktree:** /tmp/release-public-prep

**Branch:** release/public-prep

**Baseline:** Gate green on commit `c935f1b` with `NODE_ENV= bash scripts/gate.sh` (the dev shell needs `NODE_ENV` unset because the running ytsejam service leaks `NODE_ENV=production` into agent bash sessions; npm otherwise skips devDeps).

**Notes on scope:**
- Excluded by design: rotating `BRAVE_API_KEY` and `YTSEJAM_AUTH_TOKEN`. These have been echoed into multiple gitignored JSONL transcripts, so rotation is required regardless of this branch — but it is a single 5-minute operational task Brian performs out of band, not a code change.
- Excluded by design: full code refactors. The audits found the deploy/install scripts and systemd unit unusually well-engineered; this branch is prose + a 5-LoC listener change + a license file, not architecture.
- Excluded by design: re-running the audits at the end of this plan. The `/ship` skill should re-run the three audit dispatches (the same prompts I already used) on the post-cleanup HEAD as the final pre-publish gate.

---

## Task 1: Loopback-by-default listener (security blocker)

**Why:** `server/src/index.ts:127` calls `serve({ fetch, port })` without `hostname`, so node-server binds `::`/`0.0.0.0`. Combined with single-shared-token auth + an agent `bash` tool, following the README quick-start currently yields a LAN-reachable RCE-as-a-service. README/install.sh/deploy README/runtime log all claim `localhost` — actively misleading.

**Files:**
- Modify: `server/src/index.ts` (lines ~127-130)
- Modify: `server/src/config.ts` (add `host` field reading `YTSEJAM_HOST`)
- Modify: `deploy/ytsejam.env.example` (document the new env var)
- Modify: `server/test/config.test.ts` (or wherever config defaults are tested — `grep -l "YTSEJAM_PORT" server/test/` first; if no test file exists for config, create `server/test/config.test.ts`)
- Test: `server/test/config.test.ts` — assert that `loadConfig({})` defaults `host` to `127.0.0.1` and `YTSEJAM_HOST=0.0.0.0` is honored

### Step 1: Find the config loader

Run: `grep -rn "YTSEJAM_PORT" server/src/ | head` to locate the config module. The host field belongs alongside `port` and `dataDir`. Read that file in full before editing.

### Step 2: Write the failing test for default host

If `server/test/config.test.ts` does not exist, create it. If it exists, add a new `describe("host")` block. The test:

```typescript
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js"; // adjust import path to match neighbors

describe("config — host", () => {
  it("defaults to 127.0.0.1 (loopback) when YTSEJAM_HOST is unset", () => {
    const env = { ...process.env };
    delete env.YTSEJAM_HOST;
    const cfg = loadConfig(env);
    expect(cfg.host).toBe("127.0.0.1");
  });

  it("honors an explicit YTSEJAM_HOST override (e.g. 0.0.0.0 behind a reverse proxy)", () => {
    const cfg = loadConfig({ ...process.env, YTSEJAM_HOST: "0.0.0.0" });
    expect(cfg.host).toBe("0.0.0.0");
  });
});
```

Adjust the `loadConfig` signature/call to match the actual implementation (it may take `process.env` implicitly — in that case use `process.env.YTSEJAM_HOST = ...` with a save/restore around the test).

### Step 3: Run the test to verify it fails

Run: `cd server && NODE_ENV= npx vitest run test/config.test.ts -t "host"`
Expected: FAIL — `cfg.host is undefined` or similar.

### Step 4: Add the `host` field to the config loader

In the config module, add `host: process.env.YTSEJAM_HOST ?? "127.0.0.1"` to the returned object (mirror the existing `port` line). Update the `Config` type/interface so `host: string` is declared.

### Step 5: Run the test to verify it passes

Run: `cd server && NODE_ENV= npx vitest run test/config.test.ts -t "host"`
Expected: PASS (both assertions).

### Step 6: Wire the host through to the listener

In `server/src/index.ts`, change:

```typescript
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`ytsejam listening on http://localhost:${info.port}`);
  console.log(`data dir: ${config.dataDir}`);
});
```

to:

```typescript
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  const displayHost = config.host === "0.0.0.0" || config.host === "::" ? "<all interfaces>" : config.host;
  console.log(`ytsejam listening on http://${displayHost}:${info.port}`);
  console.log(`data dir: ${config.dataDir}`);
  if (config.host === "0.0.0.0" || config.host === "::") {
    console.warn("ytsejam: listening on all interfaces — ensure a reverse proxy and auth review are in place before exposing to a network");
  }
});
```

(`info.address` from `@hono/node-server` is also acceptable in place of `config.host` for the log line; the version pinned in this repo populates it. Use whichever the surrounding code style prefers.)

### Step 7: Document the env var

In `deploy/ytsejam.env.example`, in the same "Path overrides" / network section as `YTSEJAM_PORT`, add:

```
# Listener hostname.
# Defaults to 127.0.0.1 (loopback-only). The HTTP listener authenticates with a
# single shared bearer token (YTSEJAM_AUTH_TOKEN) and exposes an agent with a
# `bash` tool — listening on a network interface without a reverse proxy and an
# auth review is a LAN-reachable RCE. Set to "0.0.0.0" only behind a reverse
# proxy you trust (and review the token model first).
#YTSEJAM_HOST=127.0.0.1
```

### Step 8: Run the full gate to verify nothing regressed

Run: `NODE_ENV= bash scripts/gate.sh`
Expected: PASSED.

### Step 9: Commit

```bash
git add server/src/index.ts server/src/config.ts server/test/config.test.ts deploy/ytsejam.env.example
git commit -m "feat(server): bind loopback by default; add YTSEJAM_HOST env

Listener was binding 0.0.0.0 implicitly while every doc and the runtime log
claimed 'localhost'. With single-shared-token auth and an agent bash tool,
following the README quick-start yielded a LAN-reachable RCE. Now defaults
to 127.0.0.1, honors YTSEJAM_HOST for reverse-proxy deployments, and the
startup log reports the real bound host with a warning when it's non-loopback."
```

---

## Task 2: MIT LICENSE + package.json metadata (legal blocker)

**Why:** No LICENSE file. `package.json` has `"private": true` and no `"license"` field. Defaults to all-rights-reserved — no one can legally use, fork, or contribute. Brian chose MIT.

**Files:**
- Create: `LICENSE`
- Modify: `package.json` (root)
- Modify: `server/package.json` and `web/package.json` (workspaces)

### Step 1: Create the LICENSE file

Create `LICENSE` at the repo root with the exact text of the OSI-canonical MIT License (https://opensource.org/license/mit) substituting the copyright line. Use the current year (`2026`) and `Brian Ketelsen`:

```
MIT License

Copyright (c) 2026 Brian Ketelsen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Step 2: Update root `package.json`

Open `package.json`. Remove the line `"private": true,`. Add `"license": "MIT"` in alphabetical order with the existing top-level keys. If a `"repository"` field is missing, add:

```json
"repository": {
  "type": "git",
  "url": "git+https://github.com/bketelsen/ytsejam.git"
},
"bugs": {
  "url": "https://github.com/bketelsen/ytsejam/issues"
},
"homepage": "https://github.com/bketelsen/ytsejam#readme",
```

### Step 3: Update workspace `package.json` files

The workspaces (`server/package.json` and `web/package.json`) currently say `"private": true,` because they are unpublished sub-packages. Leave that as-is (it prevents accidental `npm publish`), but ADD `"license": "MIT"` to each so license tooling sees a consistent answer at every layer.

### Step 4: Verify the gate still passes

Run: `NODE_ENV= bash scripts/gate.sh`
Expected: PASSED.

### Step 5: Commit

```bash
git add LICENSE package.json server/package.json web/package.json
git commit -m "feat: add MIT LICENSE and license metadata

Repo was implicitly all-rights-reserved (no LICENSE file, root
package.json marked '\"private\": true' with no license field). Adds the
OSI-canonical MIT text, removes 'private' at the root so the license
metadata is the authoritative answer, keeps 'private' on the unpublished
workspaces but adds '\"license\": \"MIT\"' to each. Sets repository, bugs,
and homepage to github.com/bketelsen/ytsejam."
```

---

## Task 3: README — Security model + Prerequisites + repo URL fix

**Why:** R1 (prereqs section missing — Node ≥22 only mentioned in agent-facing OVERVIEW), R3 (README L46 still says literal `git clone <repo-url>`), plus the README half of B1 (Security Model section explaining loopback default + token + bash-tool surface).

**Files:**
- Modify: `README.md`

### Step 1: Read the current README end-to-end

Run: `cat README.md`. Note the existing section order so new sections slot in naturally.

### Step 2: Fix the `<repo-url>` placeholder

In `README.md` around line 46, replace the literal `<repo-url>` with `https://github.com/bketelsen/ytsejam.git`. Confirm with: `grep -n '<repo-url>' README.md` returns nothing.

### Step 3: Add a Prerequisites section

Add a `## Prerequisites` section near the top of the README (just below the project description, before quick-start). Required content:

- Operating system: Linux (tested on Fedora-family snosi; Ubuntu/Debian likely work; macOS/Windows are not supported because the install is systemd `--user`-based).
- `systemd` with user services enabled. If running headless, enable lingering: `loginctl enable-linger "$USER"` (so the service survives logout).
- Node.js **≥ 22.0.0** — required for the built-in `node:sqlite` module the memory store relies on. Check with `node --version`.
- `git`, `npm`, and a Bourne-compatible shell.
- ~200 MB free disk for `node_modules`; long-running data lives under `~/.ytsejam/data` and grows with use.
- An LLM provider credential for runtime: one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, GitHub Copilot via `pi-ai`, or whatever providers `@earendil-works/pi-ai` supports — see `deploy/ytsejam.env.example` for the current list.

### Step 4: Add a Security model section

Add a `## Security model` section. Required content (prose, not the literal bullets):

- ytsejam **defaults to loopback (`127.0.0.1`)** — only processes on the same machine can reach it. Override with `YTSEJAM_HOST=0.0.0.0` only behind a reverse proxy you trust.
- Authentication is a **single shared bearer token** (`YTSEJAM_AUTH_TOKEN` in the env file). Anyone who has the token has full agent access. Treat it like an SSH key: rotate if leaked, never commit, never share over plaintext channels.
- The web UI talks to an **LLM agent that has a `bash` tool**. A reachable, token-known endpoint is therefore a remote shell on the host running ytsejam. Do not expose to the public internet. Do not run ytsejam as a different user than the one whose files you'd want the agent to be able to touch.
- The bundled subagent system, schedules, and tools (`web_fetch`, `bash`, `delegate`, file operations) run with the ytsejam process's privileges. See `docs/agents/tools.md` for the full tool surface and how each is registered.
- Outbound traffic: ytsejam calls whichever LLM provider you configure and the URLs your agent decides to fetch via `web_fetch`/`web_search`. There is no built-in egress filter.

### Step 5: Verify gate passes (no code changed but markdownlint is in the gate)

Run: `NODE_ENV= bash scripts/gate.sh`
Expected: PASSED.

### Step 6: Commit

```bash
git add README.md
git commit -m "docs(readme): add Prerequisites + Security model sections; fix repo URL

Prerequisites makes Node >=22 (for node:sqlite), systemd --user, and
linger explicit; Security model explains the loopback default, single
shared-token auth, and the bash-tool surface so adopters understand
what they are exposing if they change YTSEJAM_HOST. Replaces literal
<repo-url> placeholder with the real github.com/bketelsen/ytsejam URL."
```

---

## Task 4: Document YTSEJAM_MEMORY_DIR (env-var reconciliation, R2)

**Why:** `server/src/memory/store/paths.ts:7` reads `process.env.YTSEJAM_MEMORY_DIR`. It is documented only in plan docs (`docs/plans/2026-06-12-fold-cogmemory.md`, `docs/memory/FORMAT.md`) — not in `README.md`, `deploy/README.md`, or `deploy/ytsejam.env.example`. Adopters cannot discover it.

**Files:**
- Modify: `deploy/ytsejam.env.example`
- Modify: `deploy/README.md`

### Step 1: Add `YTSEJAM_MEMORY_DIR` to the env example

In `deploy/ytsejam.env.example`, in the "Path overrides" section near `YTSEJAM_DATA_DIR`, add:

```
# Memory store root. Defaults to "$YTSEJAM_DATA_DIR/memory".
# Override if you want the cog memory store on a different filesystem
# (e.g. a faster disk, or to share a memory tree across two ytsejam
# instances — though concurrent writers are not supported).
#YTSEJAM_MEMORY_DIR=/absolute/path/to/memory
```

### Step 2: Add `YTSEJAM_MEMORY_DIR` to deploy/README.md

In `deploy/README.md`, find the section that mentions `YTSEJAM_DATA_DIR` (likely under "Configuration" or "Runtime operations"). Add a one-paragraph note immediately after the `YTSEJAM_DATA_DIR` description:

> `YTSEJAM_MEMORY_DIR` — Override the location of the cog memory store. Defaults to `$YTSEJAM_DATA_DIR/memory`. Useful when keeping memory on a separate filesystem; concurrent writers are not supported, so two ytsejam instances should not share a memory dir.

### Step 3: Verify gate

Run: `NODE_ENV= bash scripts/gate.sh`
Expected: PASSED.

### Step 4: Commit

```bash
git add deploy/ytsejam.env.example deploy/README.md
git commit -m "docs(deploy): document YTSEJAM_MEMORY_DIR

The env var was read by the memory store loader but undocumented in
the env example or deploy README — only mentioned in implementation
plans. Adopters could not discover the override."
```

---

## Task 5: Migration script "skip if fresh install" hedge (R4)

**Why:** `deploy/migrate-data.sh` and `deploy/migrate-to-folded.sh` are upgrade tools, but a stranger reading the deploy dir might assume they're required setup steps and run them on a fresh install. They should refuse to run when there's no prior data.

**Files:**
- Modify: `deploy/migrate-data.sh`
- Modify: `deploy/migrate-to-folded.sh`
- Modify: `deploy/README.md`

### Step 1: Read both scripts

Run: `cat deploy/migrate-data.sh deploy/migrate-to-folded.sh`. Identify the source-of-migration path each one expects. For `migrate-data.sh` this is the old data dir argument; for `migrate-to-folded.sh` it's `~/.chapterhouse/memory` per the cog observation in audit #2.

### Step 2: Add a fresh-install guard to each script

At the top of `deploy/migrate-to-folded.sh` (after `set -euo pipefail` or equivalent), insert:

```bash
# Refuse to run on a fresh install — this script migrates a pre-existing
# ~/.chapterhouse/memory into the current ytsejam memory dir. If you are
# installing ytsejam for the first time, you do not need to run this.
LEGACY_SRC="${LEGACY_SRC:-$HOME/.chapterhouse/memory}"
if [ ! -d "$LEGACY_SRC" ]; then
  echo "migrate-to-folded.sh: no legacy memory dir at $LEGACY_SRC — nothing to migrate." >&2
  echo "  (This script is only needed when upgrading from a pre-fold install. Skip on fresh installs.)" >&2
  exit 0
fi
```

Adapt the variable name and existing pre-existing variable to match the actual script. Do the equivalent for `deploy/migrate-data.sh` — refuse if the source dir (the script's first argument or its default) does not exist.

### Step 3: Update `deploy/README.md`

Find the section that mentions either migration script. Add a leading note:

> **First-time installers do not need these scripts.** `migrate-data.sh` and `migrate-to-folded.sh` are only relevant when upgrading from an older ytsejam layout or from the historical `chapterhouse` data dir. They no-op safely on a fresh install.

### Step 4: Smoke-test the guards

Run each script with no legacy data present and confirm it exits 0 with the explanatory message:

```bash
LEGACY_SRC=/tmp/this-does-not-exist bash deploy/migrate-to-folded.sh
echo "exit: $?"
```

Expected: prints the "nothing to migrate" line, exits 0.

### Step 5: Verify gate

Run: `NODE_ENV= bash scripts/gate.sh`
Expected: PASSED.

### Step 6: Commit

```bash
git add deploy/migrate-data.sh deploy/migrate-to-folded.sh deploy/README.md
git commit -m "docs(deploy): mark migration scripts as upgrade-only; add fresh-install guard

Both scripts now refuse to run when their source directory is absent,
exit 0 with an explanatory message, and the deploy README leads its
migration section with 'first-time installers do not need these.'"
```

---

## Task 6: README — Troubleshooting + Uninstall + first-run smoke test (R5)

**Why:** Top R5 finding from audit #3. Adopters need a path from "service started" to "I know it works" and a way to clean up.

**Files:**
- Modify: `README.md`

### Step 1: Re-read the README

Run: `cat README.md`. Decide where the new sections sit (Troubleshooting and Uninstall typically near the end; smoke test inside the install section).

### Step 2: Add a first-run smoke test

In the install / quick-start section, after the `systemctl --user start ytsejam` step, add:

```markdown
### Verify it's running

Wait ~3 seconds for startup, then:

    curl -fsS http://127.0.0.1:9873/healthz && echo

Expected: a short JSON body and exit 0. If you see `Connection refused`,
check `journalctl --user -u ytsejam -n 50` for startup errors.

Then open `http://127.0.0.1:9873/` in a browser. The first request will
ask for the `YTSEJAM_AUTH_TOKEN` you set in `~/.ytsejam/ytsejam.env`.
```

(Verify the actual health endpoint path — `grep -rnE "/health" server/src/ | head` — adjust if it's `/health` or something else; if no health endpoint exists, use `curl -fsS http://127.0.0.1:9873/` and expect a 200.)

### Step 3: Add a Troubleshooting section

Add `## Troubleshooting` near the end. Cover at least:

- **`journalctl --user -u ytsejam -n 100`** — the canonical "what went wrong" command.
- **Service starts then exits with code 78** (`EX_CONFIG`) — missing required env (usually `YTSEJAM_AUTH_TOKEN`). Check `~/.ytsejam/ytsejam.env` exists and is readable.
- **`node: command not found`** in the journal — Node not on the systemd user PATH. The unit uses `/usr/bin/env node`; either symlink node into `/usr/bin` or edit the unit `ExecStart` to use the absolute path to your node binary.
- **`prompt is too long`** mid-conversation — the compaction kill switch (`YTSEJAM_COMPACTION_ENABLED=false`) is set, or compaction failed. See `deploy/README.md` runtime-operations.
- **Browser asks for token repeatedly** — token mismatch between browser cookie and env file; clear cookies and re-enter.
- **Port 9873 in use** — change `YTSEJAM_PORT` in the env file and restart.

### Step 4: Add an Uninstall section

Add `## Uninstall` after Troubleshooting:

```markdown
## Uninstall

    systemctl --user stop ytsejam
    systemctl --user disable ytsejam
    rm ~/.config/systemd/user/ytsejam.service
    systemctl --user daemon-reload

That removes the service. The installed release tree and data are
preserved:

    rm -rf ~/.ytsejam   # ALSO deletes all sessions, memory, schedules, tokens

Optionally `loginctl disable-linger "$USER"` if you enabled it just for
ytsejam.
```

### Step 5: Verify gate

Run: `NODE_ENV= bash scripts/gate.sh`
Expected: PASSED.

### Step 6: Commit

```bash
git add README.md
git commit -m "docs(readme): add first-run smoke test, Troubleshooting, Uninstall

Smoke test gives adopters a 'I know it works' moment immediately after
install. Troubleshooting covers the five most likely first-day failures
(missing token, node PATH, port in use, token mismatch, compaction-
disabled overflow). Uninstall is a complete tear-down recipe."
```

---

## Task 7: Misc README polish (R6 batch)

**Why:** Three small README items audit #3 flagged as medium: `loginctl enable-linger` not in install steps, `KEEP_RELEASES` undocumented, broken/stale internal links.

**Files:**
- Modify: `README.md`
- Modify: `deploy/ytsejam.env.example` (for `KEEP_RELEASES`)
- Modify: `deploy/README.md` (cross-check)

### Step 1: Find and document `KEEP_RELEASES`

Run: `grep -rn "KEEP_RELEASES" deploy/ server/src/`. Read the surrounding context to learn the default (likely 5 in `deploy.sh`). Add to `deploy/ytsejam.env.example`:

```
# How many old release directories to retain under ~/.ytsejam/releases/
# after a successful deploy. Older releases are auto-pruned so rollback
# has a small fixed history. Default: 5.
#KEEP_RELEASES=5
```

If `KEEP_RELEASES` is read by `deploy.sh` (a shell var, not an env at runtime), add a sentence in `deploy/README.md` instead under the deploy section. Read the script to decide which.

### Step 2: Add `loginctl enable-linger` to README install steps

In the install / quick-start section of `README.md`, before the `systemctl --user enable --now ytsejam` step, add:

```markdown
If you'll log out of the machine while ytsejam runs (typical for a
headless server), enable lingering so the user manager keeps your
service alive:

    loginctl enable-linger "$USER"
```

### Step 3: Audit + fix internal links

Run: `grep -nE '\]\([^)]+\)' README.md docs/ -r | grep -vE 'http|https' | head -40` to list all relative-path markdown links in the user-facing docs. Spot-check each — open the link target and confirm it exists. For each broken one, either fix the path or remove the link.

### Step 4: Verify gate

Run: `NODE_ENV= bash scripts/gate.sh`
Expected: PASSED.

### Step 5: Commit

```bash
git add README.md deploy/ytsejam.env.example deploy/README.md
git commit -m "docs: document KEEP_RELEASES, add enable-linger, fix stale links"
```

---

## Task 8: Username + Microsoft scrub (R7 + audit #2 M2 + audit #1 N1)

**Why:** Three small, mechanical content-polish items rolled together:
- 8 tracked docs contain `/home/bjk` absolute paths.
- 15 tracked docs use "Brian" first-name in plan/audit/lesson narrative — most fine, but a sweep ensures user-facing docs read neutrally.
- `server/test/memory/*.test.ts` fixtures seed `work/microsoft/entities.md` with the maintainer's real employer/role.
- `server/test/compaction.test.ts:261` hardcodes `/home/bjk/.ytsejam/data/sessions/…` as a fixture string.

**Files:**
- Modify: the 8 tracked docs containing `/home/bjk` (list below)
- Modify: `server/test/memory/analysis.test.ts`, `server/test/memory/consolidated.test.ts`, `server/test/memory/domain.test.ts` (Microsoft → Acme)
- Modify: `server/test/compaction.test.ts` (line ~261)

### Step 1: Replace `/home/bjk` in tracked docs

Run the sweep:

```bash
git ls-files | xargs grep -l '/home/bjk' 2>/dev/null
```

Expected: 8 files. For each, replace `/home/bjk` with one of `~`, `$HOME`, or `<repo>` as context demands. Plan/lesson/audit docs in `docs/superpowers/plans/` and `docs/audit/` historically captured shell snippets verbatim — preserving the shape with `~` is fine. For prose mentions, prefer `<repo>` or `your repo`.

Verify zero remain: `git ls-files | xargs grep -l '/home/bjk' 2>/dev/null | wc -l` should print `0`.

### Step 2: Generic-ify the test fixtures

In `server/test/memory/analysis.test.ts`, `server/test/memory/consolidated.test.ts`, and `server/test/memory/domain.test.ts`:

- Replace the path component `work/microsoft` with `work/acme` (search for the literal string `"work/microsoft"` and similar).
- Replace `### Microsoft (employer)` with `### Acme (employer)`.
- Replace `Role: Principal Engineering Manager` with `Role: Staff Engineer`.

Verify with: `grep -nE 'microsoft|Principal Engineering Manager' server/test/memory/ -r` returns nothing.

### Step 3: De-personalise the compaction test fixture

In `server/test/compaction.test.ts` around line 261, the hardcoded `"/home/bjk/.ytsejam/data/sessions/--chat--/…"` string is used in an equality assertion. Replace with a function call that builds the expected path from the test's own `tmpdir` setup (the test should already have a `tmpDir` variable for the session root — use `path.join(tmpDir, ...)` instead). If that refactor is non-trivial, the minimum fix is `${process.env.HOME}/.ytsejam/data/sessions/...` so no username leaks into committed code.

### Step 4: Run only the touched test suites first

```bash
cd server && NODE_ENV= npx vitest run test/memory/ test/compaction.test.ts
```

Expected: PASS. If `domain.test.ts` references `work/microsoft` as a domain id in assertions, those assertions will need their string literals updated too — change all of them in lockstep.

### Step 5: Run the full gate

Run: `NODE_ENV= bash scripts/gate.sh`
Expected: PASSED.

### Step 6: Commit

```bash
git add docs/ server/test/
git commit -m "chore: scrub /home/bjk paths + generic-ify test fixtures

Replaces 8 tracked docs' /home/bjk shell snippets with ~/\$HOME/<repo> as
context allows; renames the work/microsoft test fixture + 'Principal
Engineering Manager' role to work/acme + 'Staff Engineer' (the real
values matched the maintainer's public employer/role — fine but a smell);
replaces a hardcoded /home/bjk session path in compaction.test.ts with
a tmpdir-derived path."
```

---

## Task 9: Add .claude/ to .gitignore (operational hygiene, O2)

**Why:** `.claude/` is not currently gitignored. It contains `settings.local.json` (not currently tracked, but loose). Hygiene fix so it cannot be accidentally added.

**Files:**
- Modify: `.gitignore`

### Step 1: Add the entry

Append to `.gitignore`:

```
.claude/
```

### Step 2: Verify it works

Run: `git check-ignore -v .claude/settings.local.json`
Expected: prints `.gitignore:N:.claude/    .claude/settings.local.json`.

### Step 3: Verify gate

Run: `NODE_ENV= bash scripts/gate.sh`
Expected: PASSED.

### Step 4: Commit

```bash
git add .gitignore
git commit -m "chore: gitignore .claude/

Per-machine Claude Code settings — not part of the repo's public surface."
```

---

## Task 10: Final pre-handoff verification

**Why:** Confirm the branch is in a state /ship can audit and propose merging.

### Step 1: Verify everything is committed

Run: `git status --short`
Expected: empty.

### Step 2: Run the full gate one last time

Run: `NODE_ENV= bash scripts/gate.sh`
Expected: PASSED.

### Step 3: Print the commit log for the branch

Run: `git log --oneline origin/main..HEAD`
Expected: ~9 commits, one per task.

### Step 4: Hand off

Hand back to the user. Recommend running `/ship` to:
1. Re-run all three release audits against this HEAD as the final gate (use the exact prompts in `~/.ytsejam/data/release-audit/SUBAGENT-BRIEFS.md` — if that doesn't exist, the briefs are in observations from 2026-06-12).
2. Open a PR or merge directly to main.
3. Brian rotates `BRAVE_API_KEY` and `YTSEJAM_AUTH_TOKEN` as the out-of-band operational task before flipping the repo public.
