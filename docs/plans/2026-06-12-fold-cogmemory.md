# Fold cogmemory into ytsejam — Implementation Plan

**Status:** APPROVED 2026-06-12 — D1–D12 accepted as drafted. Ready for PR-0 dispatch.
**Trigger:** Two friends *waiting to install*, gated on simplicity. No existing friend install to migrate; only Brian's. cogmemory-as-separate-daemon is an abstraction with no surviving consumer (multi-harness sharing was the design goal; Hermes is uninstalled, omnius is retired, no future non-TS harness is in the plan).
**Spans:** ytsejam (Node/TS) · cogmemory (Go) · Brian's live memory store · cog-skills · the cogmemory git repo itself.
**Supersedes:** `~/projects/cogmemory/docs/plans/2026-06-12-tiered-patterns.md` in implementation column only — design content (split test, content map) ports unchanged and runs AFTER the fold lands.
**Self-modification hazard:** every milestone that swaps `~/.ytsejam/current` kills the live ytsejam session. Same as today; Brian schedules.

**Guiding principle (from Brian, post-draft):** Cog's DNA is bash + grep + LLM, not a service. cogmemory's 6k Go LOC was incidental complexity that could have been 500-1500. Port SEMANTICS, not line count — the test parity bar (D9) keeps behavior; TS LOC may land at ~1/3 of Go LOC and that's correct. If a Go helper takes 400 lines for one regex sweep, the TS is 40. Resist faithful-port reflex.

---

## 1. Why now (one screen)

The daemon's justifications are dead or library-shaped:

| Daemon justification | Status today |
|---|---|
| Single-writer serialization across harnesses | DEAD — ytsejam is the only writer |
| Cross-harness memory sharing | DEAD — Hermes uninstalled, omnius retired, no replacement planned |
| Language-independent access from non-TS tools | DEAD — no non-TS tool exists or is planned |
| Independent restart of memory vs harness | THEORETICAL — today's daemon restart already kills the live ytsejam session, so independence was never realized |
| Consolidated RPCs (session_brief, housekeeping_scan, …) | LIBRARY-SHAPED — pure functions over the file tree, identical as in-process calls |
| flock + git auto-commit cadence | LIBRARY-SHAPED — write hook in the same module |
| Strict-params contract enforcement (PR #23) | STRONGER as TS — type system catches at compile time what `DisallowUnknownFields` catches at runtime |

The deploy/share/complexity wins:

- **Install drops from 2 services + 2 configs + 2 data paths to 1 / 1 / 1.** This is the unblocker for the two pending friend installs.
- **Memory-system patches ship with the next ytsejam release** — no daemon restart that ends the live session. Today, every cogmemory RPC merge requires Brian's deliberate restart timing.
- **Removes:** unix-socket protocol, 60KB line-cap workaround, socket-chmod race window, daemon lifecycle, `cogmemory.service` plus test-service pair, the `~/.chapterhouse/memory` directory name (legacy from a retired project).
- **Preserves:** the file format spec (markdown + L0 + domains.yml + glacier YAML frontmatter) — that's the real portability surface, and it's untouched. A future non-TS harness writes against the file format, not against an RPC.

## 2. What "fold" means concretely

- One git repo (ytsejam) owns memory code, served from `server/src/memory/`.
- All `cog_*` tools call in-process TypeScript functions instead of JSON-RPC over a socket.
- The cogmemory repo gets archived after migration; its docs (`RPC-CONSOLIDATION.md`, `WIKI-TIER.md`, `TIERED-PATTERNS.md`) migrate to `ytsejam/docs/memory/` as the canonical spec.
- The live store on disk is unchanged in format. The path moves from `~/.chapterhouse/memory` to `~/.ytsejam/data/memory/` as part of the migration.
- The external memory service stops running. Its systemd units get disabled and removed. The socket file goes away.

## 3. Internal-boundary discipline (load-bearing for future optionality)

Per C3 in last night's discussion: the fold must produce a clean importable module, not scatter memory logic across `manager.ts` and friends. Concrete shape:

```
server/src/memory/
  index.ts              # public surface: every cog_* + every consolidated RPC as a function
  types.ts              # all envelopes (SessionBrief, HousekeepingScan, ...) — single source of truth
  store/                # primitive I/O (read/write/append/patch/outline/move/list/search/stats)
  domain/               # domain controller (manifest, validation, RBAC)
  consolidated/         # session_brief, housekeeping_scan, recent_observations, cluster_check, ...
  git/                  # auto-commit cadence + status/diff/log/revert wrappers
  format/               # L0 headers, frontmatter, observation lines, action items — parsers/serializers
  test/                 # vitest suite, mirrors Go tests
  README.md             # the file format spec, ported from cogmemory docs
docs/memory/
  FORMAT.md             # the on-disk format spec (extracted from cog skills + cog README)
  RPC-CONSOLIDATION.md  # migrated from cogmemory
  WIKI-TIER.md          # migrated from cogmemory
  TIERED-PATTERNS.md    # migrated from cogmemory (then implemented per the other plan)
```

**The discipline:** every memory operation goes through `server/src/memory/index.ts`. Nothing outside that directory does file I/O against the store. Tools (`server/src/tools/cog.ts`) and brief renderer (`server/src/cog/brief.ts`) import functions; they do not reach into `memory/store/` directly. This is the "you can extract to a npm package on day N+1" property.

**Test for the discipline:** `grep -rn "memory_root\|ytsejam/data/memory\|chapterhouse/memory" server/src | grep -v "^server/src/memory/"` must return zero lines outside `server/src/memory/`.

## 4. Open decisions (Brian's call before PR-1)

| # | Decision | Default | Rationale |
|---|---|---|---|
| D1 | Store location post-fold | `~/.ytsejam/data/memory/` (inside the existing data dir) | One data dir for everything. `YTSEJAM_DATA_DIR=/tmp/...` already isolates dev cleanly. Friends get a single tree. |
| D2 | Env var for memory root override | `YTSEJAM_MEMORY_DIR` (defaults to `${YTSEJAM_DATA_DIR}/memory`) | Lets advanced users keep memory on a separate disk; matches the deployment shape. |
| D3 | When does the daemon get killed? | After PR-4 (the cutover PR) merges + Brian deploys. Until then both run; ytsejam uses daemon. | Two-track until cutover — no big-bang. |
| D4 | What happens to the cogmemory repo? | Archive after migration. Add a `README.md` pointing to ytsejam. Tag a final `v1.0.0-archived` release. | Friends who already cloned it have a clear pointer. |
| D5 | Port strategy: rewrite OR transpile? | **Rewrite by hand, file-by-file, with the Go test as the spec.** | Tools for Go→TS transpile are bad. The semantics are simple (markdown + paths), so hand-port is faster AND produces idiomatic TS that fits the rest of the codebase. |
| D6 | Keep RBAC? | **NO** — single-user single-process. Drop the role param everywhere. | Simpler tool signatures, smaller TS surface, one fewer concept friends learn. Easy to add back if multi-tenancy ever returns (it won't). |
| D7 | Keep the on-disk git repo + auto-commit cadence? | **YES** — git is the durability story. Auto-commit cadence is from the open improvements list (line 14 in `cog-meta/improvements.md`); ship it as part of the fold. | The store IS a git repo. Don't lose that. |
| D8 | Friend install path | New release of ytsejam carries everything in-process. Friends update once, daemon services get disabled by a migration script in `deploy/migrate-to-folded.sh`. | One-command upgrade for the two waiting friends. |
| D9 | Test parity bar | **100% of cogmemory's `*_test.go` cases must have a vitest equivalent**, line-by-line if needed. Go tests are the spec. | Eliminates "did we lose behavior" risk. Cheap insurance for a 6k-line port. |
| D10 | Do we keep the unix socket as a deprecated compatibility shim during transition? | **NO** — there's nothing else that talks to it. Direct switchover at PR-4. | Less code, less risk, less time. |
| D11 | Tiered-patterns plan: ship before or after fold? | **AFTER fold.** Re-issue the plan as TS-shaped (the design survives, the PR-A/B become TS modules + tests). | Doing tiered-patterns in Go that we throw away in two weeks is waste. |
| D12 | The `cogmemory` daemon's recent-but-unshipped PRs (#22, #23 not yet installed) | **Port their semantics into the TS rewrite directly** — DisallowUnknownFields → Zod-or-equivalent runtime validation; `recent_observations` uses bare `domain` param. | These were shipped to fix bugs we now know about; bake the fixes into the rewrite. |

## 5. Phased rollout (6 phases, 9 PRs)

Phasing is strict: each phase ends with a working, deployable ytsejam — no half-merged limbo. Friends can install at the end of any phase boundary if they want.

### Phase 0 — Spec freeze + skeleton (1 PR)

**PR-0: Memory module skeleton + spec docs.**

- Create `server/src/memory/{index,types}.ts` with empty exports for every function we'll fill.
- Create `docs/memory/{FORMAT,RPC-CONSOLIDATION,WIKI-TIER,TIERED-PATTERNS}.md` — copy verbatim from cogmemory docs, no changes.
- Create `server/src/memory/README.md` stating the public-surface discipline (§3).
- Add a passing placeholder test in `server/src/memory/test/`.
- Update `AGENTS.md` breadcrumb under "Memory" pointing at `server/src/memory/README.md`.

**Gate:** `scripts/gate.sh` green. No behavior change.
**Rollback:** revert PR-0; no on-disk effects.

### Phase 1 — Primitive I/O (2 PRs in parallel)

These are independent and can be drafted by two subagents simultaneously.

**PR-1a: Primitive I/O module.**

Port to `server/src/memory/store/` (and re-export via `memory/index.ts`):
- `read(path)` — read file, decode UTF-8
- `write(path, content)` — atomic write with the same allow-list as today (`*/INDEX.md`, `link-index.md`, `glacier/index.md`, `domains.yml`, select `cog-meta/*`); reject id-as-path
- `append(path, text, section?)` — append to EOF or to a `## Section` heading
- `patch(path, oldText, newText)` — exact-occurrence replace; reject zero or multiple matches
- `outline(path)` — markdown headings + L0
- `move(from, to)` — rename
- `list()` — enumerate `.md` files (excluding `.git/`)
- `search(query)` — full-text regex search
- `stats(prefix?)` — files, lines, size, per_file array
- `health()` — returns `{ ok: true, files, last_commit }`
- `git({op, …})` — wraps `simple-git` or equivalent for status/diff/log/commit/revert

**Tests:** port `store/store_test.go`, `store/observations.go` tests, `rpc/server_test.go` write-path cases, `rpc/write_path_test.go` (the id-as-path rejection set).

**PR-1b: Domain controller module.**

Port `domain/domain.go` to `server/src/memory/domain/`:
- `loadManifest(rootDir)` → returns the parsed `domains.yml`
- `Controller` class: `list()`, `get(id)`, `actionItems(id)`, `resolveFile(id, file)`, `domainForPath(path)`, `validateWrite(path)`, hot-reload on `domains.yml` mtime change, `lastError`
- Subdomain handling (the `subdomains:` recursion)
- The `patterns: bool` field landing here is OUT OF SCOPE for this PR (it's the tiered-patterns plan's PR-A; lands later)

**Tests:** port every case in `domain/domain_test.go` to vitest, including the slash-in-filename rejection set and the manifest validation cases.

**Gate (both PRs):** `scripts/gate.sh` green. The new module is not yet wired up anywhere — pure addition. Existing `cog/client.ts` still talks to the daemon; nothing else has changed.

**Rollback:** revert; no on-disk effects.

### Phase 2 — Consolidated RPCs (3 PRs, can parallelize across subagents)

Each PR ports one cluster of consolidated RPCs to `server/src/memory/consolidated/`. The Go tests in `rpc/*_test.go` are the spec; vitest cases are 1:1.

**PR-2a: Session + housekeeping + open-actions cluster.**

- `sessionBrief()` — port from `rpc/session_brief.go` + `store/session_brief.go`
- `housekeepingScan()` — port from `rpc/housekeeping.go` + `store/housekeeping.go` (includes `PatternsOverCap` infra — keep the existing literal-filename check; tiered-patterns plan extends it later)
- `openActions(domain?)` — port from `rpc/methods.go`
- `domainSummary({domain})` — port from `rpc/methods.go`
- `recentObservations({since, domain?})` — port WITH the post-fix shape: bare `domain`, strict-param rejection via Zod or io-ts at the public-surface layer

**Tests:** port `rpc/session_brief_test.go`, `rpc/housekeeping_test.go`, `rpc/domain_summary_test.go`, plus the `strict_params_test.go` cases as Zod-validation tests.

**PR-2b: Analysis cluster.**

- `clusterCheck({min_cluster_size, since, domain?})`
- `entityAudit()`
- `linkAudit()`
- `linkIndexCompute()`
- `scenarioCheck()`

**Tests:** port `rpc/cluster_check_test.go`, `rpc/entity_audit_test.go`, `rpc/link_test.go`.

**PR-2c: Index + wiki cluster.**

- `glacierIndexCompute()`
- `wikiIndexCompute()`
- `l0index({domain?})`

**Tests:** port `rpc/glacier_test.go`, `rpc/wiki_test.go`.

**Gate (all three):** `scripts/gate.sh` green. New consolidated module exists alongside the still-used daemon client. Module is reachable through `server/src/memory/index.ts` but no tool calls it yet.

**Cross-check before merging PR-2c:** run both implementations against the live store in parallel and diff outputs for `session_brief`, `housekeeping_scan`, `cluster_check`, `entity_audit`. They MUST agree byte-for-byte on JSON (modulo timestamp). This is the validation that the rewrite preserved behavior.

**Rollback:** revert PRs in reverse order; no on-disk effects.

### Phase 3 — Switch tools + brief renderer to in-process (1 PR)

**PR-3: Cutover the tool surface.**

- Rewrite `server/src/tools/cog.ts` so every `cog_*` tool calls `memory/*` functions instead of `cogClient.call(...)`.
- Rewrite `server/src/cog/brief.ts` to consume `memory.sessionBrief()` directly.
- Rewrite `server/src/cog/client.ts` to be a no-op shim (kept as an empty file for one release for sentry against missed imports), OR delete it outright if grep shows no other importers — likely the latter.
- Add a `--memory-root=<path>` CLI flag and `YTSEJAM_MEMORY_DIR` env var per D2.
- Add a startup health-check: on boot, log "memory root: <path>, <N> files, last commit <sha>".

**Behavior change:** large but invisible. The daemon is still running — ytsejam just stops talking to it. Memory operations now happen inside the ytsejam process against the SAME on-disk store (both daemon and ytsejam point at `~/.chapterhouse/memory`).

**Gate:** `scripts/gate.sh` green. **Plus** an integration test: spin up dev ytsejam, exercise every `cog_*` tool against a throwaway memory tree, diff results against the Go-daemon's equivalent calls.

**Cutover:** Brian's deliberate `deploy.sh` + restart. The live session ends (self-modification hazard). New session resumes against the new in-process module; the daemon is still running but unused.

**Rollback:** revert PR-3. ytsejam goes back to talking to the daemon. Store is unchanged. Zero data risk.

### Phase 4 — Live store migration (one-time, scripted) (no PR; runbook)

This is a memory-store change, NOT a code PR. Brian-driven.

**Steps:**
1. `systemctl --user stop ytsejam` (the live session ends).
2. `systemctl --user stop cogmemory <test-service>` (daemons stop).
3. `mv ~/.chapterhouse/memory ~/.ytsejam/data/memory` (rename, single `mv`).
4. `git -C ~/.ytsejam/data/memory log --oneline | head` — verify history intact.
5. Restart ytsejam pointing at the new path (env var `YTSEJAM_MEMORY_DIR` if needed; default is the new path).
6. `cog_rpc("health")` returns ok with the new path.
7. Smoke: open a chat, ask "who are you?", confirm hot-memory loads.
8. Remove the memory service units from `~/.config/systemd/user/`.
9. `systemctl --user daemon-reload`.
10. `rm ~/.local/share/cogmemory/cog-memory.sock` (and the test socket).
11. `rm -rf ~/.config/cogmemory/` (the config dir).
12. Optionally archive `~/.local/bin/cogmemory` somewhere safe; can be deleted.

**Rollback:** restore the daemons (`systemctl --user start cogmemory`), `mv ~/.ytsejam/data/memory ~/.chapterhouse/memory`, revert PR-3. Daemons resume, ytsejam talks to them again. The rollback window is small (PR-3 needs to be revertable AND the daemon binaries still on disk); preserve the daemon binaries until Phase 5 is locked in.

### Phase 5 — Cleanup (2 PRs)

**PR-5a: Remove daemon client + dead code.**

- Delete `server/src/cog/client.ts` (the shim from PR-3).
- Delete any test that mocked the unix socket.
- Drop `COGMEMORY_SOCKET_PATH`, `COG_ROLE` from `config.ts`, env file template, README.
- Update `deploy/README.md`: no more daemon setup; single ytsejam service.
- Update `docs/agents/storage.md` (the OVERVIEW.md sibling): describe memory as in-process, point at `server/src/memory/README.md`.

**Gate:** `scripts/gate.sh` green.

**PR-5b: Migration script + friend install path (D8).**

- Add `deploy/migrate-to-folded.sh`:
  - Detects memory service unit presence
  - Stops + disables both
  - Detects `~/.chapterhouse/memory` and offers to `mv` it to `~/.ytsejam/data/memory`
  - Removes the socket + config dir
  - Idempotent — re-running is a no-op
- Update `README.md` install section: one service, one data dir.
- Update `deploy/install.sh` (or equivalent): no cogmemory dependency.
- Add a note in `CHANGELOG.md`: "BREAKING (deploy): external memory service dependency removed; run `deploy/migrate-to-folded.sh` before upgrading."

**Gate:** dry-run `migrate-to-folded.sh` on a snapshot of the live system; verify idempotency.

### Phase 6 — Repo retirement + docs migration (no ytsejam PR; cogmemory-side + cog-skills-side)

**Cogmemory repo retirement (cogmemory side):**
1. `cog_append` final `projects/cog-memory-service/observations.md`: "Repo archived 2026-XX-XX; folded into ytsejam (commit YYY). Final binary release tagged v1.0.0-archived."
2. Update `cogmemory/README.md`: deprecation banner, link to ytsejam.
3. Tag `v1.0.0-archived` on cogmemory main.
4. Open one final cogmemory PR with the README banner + tag.
5. Archive the GitHub repo (settings → archive).

**Cog skills migration (cog-skills side, lives in `ytsejam/server/data/reference/cog-skills/`):**
- The skills already talk about "memory tools" abstractly — `cog_read`, `cog_append`, etc. They will continue to work because the tool surface is preserved in PR-3.
- One real change: any skill that names the external memory service or "restart cogmemory" must be reworded to "the memory module" / "restart ytsejam".
- `grep -rn "cogmemory\|cog-memory-service\|external memory service\|service restart" server/data/reference/cog-skills/` — fix every hit. Likely <20 lines total.

**Cog memory store cleanup (one cog_patch each):**
- `cog-meta/improvements.md`: mark the "Cog memory store git commit cadence" line as RESOLVED (folded). Mark "Tiered patterns" as un-blocked-on-cogmemory-pause-now-blocked-on-fold.
- `projects/cog-memory-service/hot-memory.md`: rewrite as a tombstone pointing at ytsejam's `server/src/memory/`.
- Cross-domain `hot-memory.md`: remove the cogmemory bullet from Current Focus; add a note that memory is in-process.
- `infra/hot-memory.md`: remove external memory service references.

## 6. Sequence + dependencies

```
PR-0 (skeleton + spec docs)
  ├─> PR-1a (primitive I/O)         ─┐
  └─> PR-1b (domain controller)     ─┤
                                     ├─> PR-2a (session+housekeeping)  ─┐
                                     ├─> PR-2b (analysis cluster)       ─┤
                                     └─> PR-2c (index+wiki)             ─┤
                                                                          ├─> PR-3 (cutover tools+brief)
                                                                                ├─> Phase 4 (live migration, runbook)
                                                                                      ├─> PR-5a (cleanup)
                                                                                      └─> PR-5b (migration script)
                                                                                            └─> Phase 6 (repo retirement)
```

Critical-path: PR-0 → PR-1a → PR-2a → PR-3 → Phase 4. The other PRs can be drafted in parallel by separate subagents.

## 7. Test strategy

| Layer | Test | Owner |
|---|---|---|
| Primitive | Every `store/*_test.go` case has a vitest equivalent | PR-1a |
| Domain | Every `domain/domain_test.go` case has a vitest equivalent | PR-1b |
| Consolidated | Every `rpc/*_test.go` case has a vitest equivalent | PR-2a/b/c |
| Strict params | Zod (or equivalent) rejects unknown fields at module surface; one test per RPC | PR-2a |
| Differential | Live store: run both daemon-path and folded-path for 10 representative RPCs; diff JSON | Before merging PR-2c |
| Integration | Spin up dev ytsejam, exercise every `cog_*` tool, diff against daemon equivalent | PR-3 |
| Migration | Snapshot live store, run `migrate-to-folded.sh`, verify idempotency + clean state | PR-5b |
| End-to-end | Fresh chat after Phase 4 cutover: hot-memory loads, who-am-I works, schedule + delegate + skills all work | Brian eyeballs |

D9 sets the bar at 100% test-case parity. Make it numerical: count Go test functions per file; vitest must have at least that many. Track in a spreadsheet committed at `server/src/memory/test/PARITY.md`.

## 8. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Behavior drift between Go original and TS port (the silent kind that breaks reflect on day 3) | Med | High | Differential test at end of Phase 2 — diff JSON byte-for-byte; D9 100% test-case parity |
| Memory module leaks file I/O into the rest of `server/src/` over time | Med over months | Med | The grep test in §3 — add as a check in `scripts/gate.sh` |
| Live store corruption during Phase 4 migration | Low | Catastrophic | Pre-migration: `cp -a ~/.chapterhouse/memory /tmp/memory-backup-$(date +%s)/`. Rollback restores from backup if `mv` somehow fails. |
| Friend installs break mid-upgrade | Med | High | `migrate-to-folded.sh` is idempotent (D8 + PR-5b). Test it on a snapshot first. Document "if it fails, restart cogmemory.service and roll back ytsejam to v0.X". |
| PR-3 cutover lands at a bad time and we can't roll back fast | Med | Med | Phase 4 is gated on Brian-driven cutover. Don't auto-deploy PR-3. The daemon binary + units stay until Phase 5 (revertible window). |
| Bigger TS surface than the Go one because of types | Low | Low | Use shared type files (`types.ts`) ruthlessly; avoid duplication. Total TS LOC should land within 1.5× the Go LOC. |
| Zod (or whichever validator) becomes a heavy dep | Low | Low | If it does, write our own strict-params helper — it's ~50 lines (DisallowUnknownFields equivalent). Decide at PR-2a draft time. |
| The cogmemory PRs already merged but not deployed (#22, #23) get lost | Cert. unless ported | Med | D12 — port their semantics into PR-2a directly. The Go binary never gets installed; that's fine. |
| Tiered-patterns plan goes stale | Cert. | Low | D11 — re-issue post-fold as TS-shaped. The design content (split test, content map, D1–D7) is substrate-agnostic. |
| Friend follows old README and installs daemon | Med | Med | Add the deprecation banner to cogmemory README on day-1 of PR-0, not at Phase 6. Friends see the redirect before they `git clone`. |

## 9. Estimates (Mentat-internal; divide by 5-8 for parallelized agent reality)

| PR / Phase | Sequential | Parallelizable? |
|---|---|---|
| PR-0 (skeleton + spec docs) | 30–60 min | No (single-author) |
| PR-1a (primitive I/O) | 3–4 hours | Yes (with PR-1b) |
| PR-1b (domain controller) | 2–3 hours | Yes (with PR-1a) |
| PR-2a (session+housekeeping+open_actions) | 4–6 hours | Yes (with 2b, 2c) |
| PR-2b (analysis cluster) | 3–4 hours | Yes |
| PR-2c (index+wiki cluster) | 2–3 hours | Yes |
| PR-3 (cutover) | 2–3 hours + diff testing | No (rewires the boundary) |
| Phase 4 (runbook) | 30–60 min Brian-driven | No |
| PR-5a (cleanup) | 1–2 hours | Yes (with 5b) |
| PR-5b (migration script) | 2–3 hours | Yes (with 5a) |
| Phase 6 (repo + docs) | 1–2 hours | No |

**Sequential total:** ~25 hours of focused work.
**With parallelism + subagents (Phase 1 & 2 fan out):** wall-clock 8–12 hours.
**Brian-time:** ~2 hours total (PR reviews + Phase 4 cutover + Phase 6 retirement clicks).

## 10. Acceptance criteria

The fold is done when ALL of the following hold:

1. `~/projects/cogmemory` is archived on GitHub with deprecation banner.
2. `systemctl --user status cogmemory <test-service>` returns "not found" on Brian's machine.
3. `~/.chapterhouse/memory` no longer exists; `~/.ytsejam/data/memory` is the live store.
4. ytsejam install instructions in README.md describe ONE service.
5. ~~Two friends can install via the new path successfully.~~ Fresh-install dry-run from a clean home directory succeeds (friends will install fresh post-fold; no migration to verify).
6. `scripts/gate.sh` green for at least 3 consecutive ytsejam releases post-cutover.
7. `cog-meta/improvements.md` "Tiered patterns" entry is updated to "blocked on fold completion, now unblocked, replan."
8. `grep -rn "cogmemory\|cog-memory-service" ~/projects/ytsejam/server/src/` returns only the deprecation tombstone in `server/src/memory/README.md`.
9. The internal-boundary grep test from §3 passes: zero file I/O against the store outside `server/src/memory/`.
10. The tiered-patterns plan is re-issued as TS-shaped and queued for the next sprint.

## 11. What this plan does NOT do

- Does not change the on-disk file format. Markdown, L0 headers, `domains.yml`, glacier YAML frontmatter, observation/action-item line shape, wiki frontmatter — all unchanged. A future non-TS harness writes against the format spec at `docs/memory/FORMAT.md`.
- Does not implement tiered patterns. Re-planned post-fold (D11).
- Does not add an HTTP API to memory. If a future tool needs network access, that's a separate decision; default stays in-process.
- Does not introduce a new database. SQLite is for the JSONL/session index, not memory. Memory stays markdown-on-git.
- Does not touch hot-memory tier semantics, glacier rules, wiki rules, skill text (except for the cogmemory→memory wording fix).
- Does not preserve RBAC (D6 default). Role param drops everywhere.

## 12. Hidden bonus wins

- The 60KB line-cap workaround in `CogClient` (the `MAX_REQUEST_BYTES` guard) disappears. Big appends now just work.
- The "daemon was rebuilt but not restarted" failure mode disappears. Every memory-system change ships with the ytsejam release.
- The test memory service disappears; dev uses `YTSEJAM_DATA_DIR=/tmp/...` and that's it.
- The `~/.chapterhouse/memory` directory name (named after Chapterhouse, which is DEAD) finally goes away. Symbolic but real — the dead-project-name in the live config has been a small daily wart.
- Release engineering simplifies: one binary, one unit, one config file, one data dir. The deploy.sh becomes shorter.

---

**Ready for build when:** Brian calls D1–D12, dispatches PR-0 to a subagent (or writes it himself), and decides whether to give the two friends a heads-up that the upgrade is coming.

-- Mentat
at
as been a small daily wart.
- Release engineering simplifies: one binary, one unit, one config file, one data dir. The deploy.sh becomes shorter.

---

**Ready for build when:** Brian calls D1–D12, dispatches PR-0 to a subagent (or writes it himself), and decides whether to give the two friends a heads-up that the upgrade is coming.

-- Mentat
