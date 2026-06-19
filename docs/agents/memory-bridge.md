# Memory bridge (cog ↔ LTM)

> Sub-doc of [`OVERVIEW.md`](OVERVIEW.md). Code: `server/src/memory/bridge/`
> (`ltm-observer.ts`, `ltm-reconciler.ts`), the bridge plumbing on the public
> surface in `server/src/memory/index.ts` (`attachLtm`, `attachReconciler`,
> `recordObservation`, `getLtm`), the unified `recall()` helper in
> `server/src/memory/recall.ts`, and the CLI in `server/src/cli/` that exposes
> `ltm replay` / `ltm health` before server boot.
> See also: `server/src/memory/README.md` for the public-surface discipline,
> `packages/ltm/` for the LTM engine, `docs/plans/2026-06-13-cog-ltm-bridge-1-observer-design.md`
> for the design.

## What the bridge is

ytsejam now has **two memory substrates** running side by side, both
in-process:

- **cog memory** — the markdown SSOT under `<dataDir>/memory/` (observations,
  hot memory, entities, etc.), served by `server/src/memory/`. The `cog_*`
  tool surface (and the `## Memory (cog)` system-prompt section) talks to
  this one. See [`storage.md`](storage.md) § Memory module.
- **LTM** (long-term memory) — the npm workspace at `packages/ltm/`, opened
  by the server against `<dataDir>/ltm/`. Episodic + semantic memory with
  decay, consolidation, and a semantic retrieval layer (`MemorySystem`
  class). Single-writer: `MemorySystem.open()` acquires an advisory lock,
  so only one process can hold it at a time.

The **bridge** is the wiring that keeps the two in sync from cog → LTM. The
cog SSOT remains the authoritative human-readable substrate; LTM is a
derived, query-shaped index that learns from every cog observation write
(plus its own ingested session content) so retrieval can span both worlds.

This direction is deliberately one-way today: every cog `observations.md`
append fans out into LTM as a `kind: "observation"` record, content-addressed
by `cog:<domainPath>/observations.md#<sha256(line)[:12]>` so replay never
duplicates. LTM → cog is **not** mirrored.

## Three write paths into LTM

1. **Inline path — `memory.recordObservation()`** (live write). Every
   `cog_append` to `<domain>/observations.md` is routed through this in
   `server/src/tools/cog.ts`. It (a) appends the canonical observation line
   to cog SSOT, (b) best-effort mirrors it to attached LTM. The cog half
   always succeeds independently of LTM; LTM failure logs a warning and
   doesn't fail the tool call.
2. **Back-fill path — `LtmReconciler`** (timer). Walks every domain's
   `observations.md` every 5 minutes (override:
   `LTM_RECONCILE_INTERVAL_MS`) looking for lines the inline path missed —
   external editor writes, edits made while LTM was down, lines that
   pre-date wire-up. Uses the same content-addressed origin and a per-line
   `ltm.hasObservation(origin)` dedup so a normal tick is cheap.
3. **Turn-ingest path — `ingestSessionFile()`** (per session end). When a
   chat session emits `agent_end`, the manager calls
   `ltm.ingestSessionFile(sessionJsonlPath)`. Subagent sessions mirror this
   from the task manager's `run()` completion path. Best-effort: a detached
   or throwing LTM never breaks the session. This is the path that puts
   conversation turns (not just `observations.md` lines) into the LTM
   substrate, complementing the cog-mirror paths above. Late-bound via
   `ltm: () => memory.getLtm()` thunk in the manager/task-manager so
   construction order and `attachLtm(null)` shutdown remain clean.

The two cog-mirror paths produce the **same origin string** for the same line bytes, so a
line that hit both paths is mirrored exactly once. CRLF and trailing
whitespace are normalized before hashing (the reconciler reads files split
on `/\r?\n/` and trimmed; the inline writer formats clean lines from
scratch).

## Public surface — `server/src/memory/index.ts`

The bridge does not introduce a new public namespace; it bolts onto the
existing memory module's public surface:

- **`attachLtm(ltm | null)`** — make `recordObservation()` mirror to this
  LTM instance. Module-level state, last write wins. `attachLtm(null)`
  detaches (used in `SIGTERM`/`SIGINT` shutdown).
- **`getLtm(): MemorySystem | null`** — read-side accessor needed by
  `recall.ts` so it doesn't reach into the module-private slot.
- **`attachReconciler(r | null)`** — make `memory.health()` include the
  reconciler's tick stats and last-error state under `h.ltm`. When no
  reconciler is attached, `h.ltm` is **omitted from the response**, not
  set to `undefined`. The web UI's brain icon polls `/api/memory/health`
  and uses presence-or-absence to decide between "unknown" and "ok/bad".
- **`reconcileNow({force?})`** — pass-through to the attached reconciler.
  Exposed through `cog_rpc({method:"reconcile_now"})` so a skill or the
  agent can force a tick (e.g. just after a bulk external edit).
- **`initCanonicalFile({path, file_type, label})`** — idempotently creates a canonical markdown file for a registered domain from the daemon-owned template set. Exposed as `cog_rpc({method:"init_canonical_file"})`; used by the rewritten `/cog` setup skill instead of hand-rendering hot-memory/observations/action-items/dev-log stubs.
- **`skillWrite({id, description, triggers, body})`** — allow-listed write surface for generated domain routing skills. Exposed as `cog_rpc({method:"skill_write"})`; renders canonical skill frontmatter and writes `<dataDir>/skills/<id>.md` rather than allowing `/cog` to write arbitrary files.
- **`recordObservation({domainPath, text, tags, timestamp?})`** — the
  preferred write API for observations. Required tags; rejects embedded
  `\n`/`\r` in text (multi-line would split into multiple cog lines but
  the bridge parser only sees the first, so cog and LTM would diverge).
  Returns `{cog: {ok:true, line}, ltm: {ok|skipped|error}}` — the cog
  half always reports `ok:true` (failure throws); the LTM half reports
  `skipped:"ltm-not-attached"` when no LTM is wired.

`cog_append` in `server/src/tools/cog.ts` detects writes to any path ending
in `/observations.md` (without a `section`) and re-routes through
`recordObservation()` line-by-line. **All lines are parsed first; a single
malformed line aborts the whole batch** — preserving the per-invocation
atomicity the prior `memory.append(path, multi_line_text)` had.


### Setup RPCs used by `/cog`

The cog cleanup PRs added two RPC methods to keep setup generation inside narrow daemon-owned surfaces:

- **`init_canonical_file`** validates params (`path`, `file_type`, `label` only), resolves the target under the cog memory root, requires the target path to sit under a registered domain path, and enforces a sluggy basename (`[a-z][a-z0-9-]*`). If the file already exists it returns `{created:false, path, bytes:0}` and never clobbers user content. Otherwise it creates parent directories and writes one of the standard templates (`hot-memory`, `observations`, `action-items`, `dev-log`, or a generic L0+heading template). It deliberately does not auto-commit today; it is setup scaffolding, not a general write primitive.
- **`skill_write`** validates params (`id`, `description`, `triggers`, `body` only), requires `id` to match `[a-z][a-z0-9-]*`, requires at least one non-empty trigger, renders YAML frontmatter, and writes `<dataDir>/skills/<id>.md`. Its path resolver is intentionally not model-supplied: the caller provides a skill id, not an arbitrary path. The RPC overwrites on re-run because `/cog` treats generated routing skills as derived from `domains.yml`.

Both are exposed only through the fixed `RPC_METHODS` allow-list in `server/src/tools/cog.ts`. File-style cog operations (`cog_write`, `cog_append`, etc.) remain separate tools; the new setup RPCs do not widen `cog_rpc` into a filesystem tunnel.

## Reconciler internals — `server/src/memory/bridge/ltm-reconciler.ts`

- **Constructor opts:** `{ltm, dataDir, intervalMs?, logger?}`.
- **`start()`** sets up `setInterval` (unref'd so it doesn't keep the
  process alive on its own) and kicks an immediate first tick so cold
  starts don't wait `intervalMs` for back-fill.
- **`stop()`** clears the interval and awaits the in-flight tick.
- **`reconcile({force?, rebuild?, prune?})`** is the per-tick workhorse and is also reachable
  directly (the CLI calls it for a one-shot replay).
- **`health()`** returns a deep-cloned `Health` snapshot; mutating the
  returned object cannot corrupt internal state.

Per tick:

1. Walk `<dataDir>/memory/` (note: cog memory root, not the whole data dir),
   collecting every `observations.md`. Skip dot-dirs at any depth and
   `glacier/` at the top level (cold YAML archives that would mis-mirror
   as fresh observations).
2. For each file, short-circuit on the per-file `mtime` cache unless
   `force:true`.
3. Split on `/\r?\n/` and `.trim()` each line so CRLF and trailing
   whitespace hash identically to the live-path lines. Honor the same
   markdown-noise filter as the read-side `observations-parser.ts`
   (`skipMarkdownNoise()` — fenced code blocks and HTML comments span
   multiple lines, state persists).
4. For each candidate line: `parseObservationLine` → compute origin →
   `ltm.hasObservation(origin)` → if miss, `ltm.recordObservation(...)`.
5. After the mirror pass, run a lightweight origins-only scan over every
   current `observations.md` line (same trimming/noise/origin derivation,
   but no parsing, embeddings, or writes). Diff that complete live-origin
   set against `ltm.allObservationsByOrigin()` and cache
   `health().orphans.observations`: the count of active cog-origin LTM
   observation records with no current source line. Health reads serve this
   cached value only; freshness is `lastTickAt`.
6. Per-line errors bump `stats.errors` and are isolated; tick-level
   errors (e.g. unreachable `dataDir`) bump `consecutiveFailures` and
   set `reachable=false` until the next clean tick.

Error messages stored in `lastError.message` have the absolute `dataDir`
prefix replaced with `<data>` before they cross the wire — `/api/memory/health`
is bearer-gated, but operator path disclosure is a cheap audit-flag to
eliminate (issue #118).

## Boot wiring — `server/src/index.ts`

After `scheduler.start()`, server boot attaches LTM opportunistically; failures
are always degraded to cog-only memory, not process exit. Full design rationale:
[`docs/plans/2026-06-14-copilot-embedder-design.md`](../plans/2026-06-14-copilot-embedder-design.md).

1. Resolve the LTM store dir from `process.env.LTM_STORE_DIR ||
   path.join(config.dataDir, "ltm")`. The empty-string fallthrough is
   intentional `||` (not `??`) so `LTM_STORE_DIR=""` lands on the default.
2. Read embedder config from:
   - `YTSEJAM_LTM_EMBEDDER` — `auto` (default), `copilot`, `ollama`, or `hash`.
   - `YTSEJAM_LTM_COPILOT_MODEL` — default `text-embedding-3-small`.
   - `YTSEJAM_LTM_COPILOT_URL` — default
     `https://api.enterprise.githubcopilot.com`.
   - `YTSEJAM_LTM_OLLAMA_MODEL` — default `nomic-embed-text:latest`.
   - `YTSEJAM_LTM_OLLAMA_URL` — default `http://localhost:11434`.
3. Construct the runtime embedder with `createLtmEmbedder()` from
   `server/src/memory/embedder.ts`, then open LTM with
   `MemorySystem.open({storeDir, embedder})`.
   - `auto` probes Copilot → Ollama → Hash and logs the attached choice as
     `[memory] LTM bridge attached, store=..., embedder=<provider:model>`.
   - Pinned `copilot` / `ollama` modes require that dependency. Missing
     Copilot credentials or an unreachable Ollama endpoint logs a `[memory]`
     WARN and leaves the process running cog-only.
4. After open, call `MemorySystem.indexDimension()` and compare it with the
   selected embedder's dimension. On mismatch, close/detach LTM, log a
   `[memory]` WARN with the remediation command, and continue cog-only:

   ```bash
   node server/src/index.ts ltm replay --rebuild
   ```

   This re-embeds current observations under the new model. Add `--prune` to also tombstone orphan records (observations whose source line is no longer in cog memory). `--prune` is only safe in steady state — **NOT** during archival or restoration, because temporarily missing source lines will be tombstoned.
   Restart the server after replay to resume LTM. The server does **not**
   `process.exit` for a mismatch.
5. Construct `LtmReconciler({ltm, dataDir, intervalMs?})`, then
   `memory.attachLtm(ltm)`, `memory.attachReconciler(reconciler)`, and
   `reconciler.start()`. If a downstream step throws, the catch path closes
   any opened LTM handle so the advisory lock does not leak.
   The immediate first reconciler tick runs asynchronously; after it settles,
   boot emits a one-time soft warning when cached orphans are present:
   `[memory] LTM bridge: N orphan observation(s) detected (run \`ltm replay --rebuild --prune\` to clean)`.
   This is visibility only. The server never auto-prunes; cleanup remains an
   explicit operator action because source edits must not destructively alter
   LTM provenance.

Shutdown drains in the opposite order: `SIGTERM`/`SIGINT` (registered with
`process.once`) await `reconciler.stop()`, then `attachReconciler(null)` /
`attachLtm(null)`, then `ltm.close()`. The handler does NOT call
`process.exit`. As of issue #210 this LTM drain is **step 6 of 7** in the
unified `drainAndExit` orchestrator (`server/src/index.ts`); the previous
behavior — LTM drained but HTTP/WS/manager/tasks/scheduler/indexer did
not — caused systemd to SIGKILL the process at `TimeoutStopSec=45`.
The orchestrator drains in this order: scheduler.stop → wss.clients close
(1001) → HTTP server.close → manager.abortAll → taskManager.cancelAll →
`shutdownLtm` (this function) → indexer.close. See
`docs/plans/2026-06-15-graceful-shutdown-design.md` for the rationale and
`deploy/README.md` for verification recipes.

The CLI `ltm replay` and `ltm health` commands use the same embedder factory
as server boot. `ltm replay` intentionally skips the dimension-mismatch refusal
because replay is the remediation path. The selected embedder's vectors are
cached under `<storeDir>/embed-cache/`, namespaced by `<provider>:<modelName>`;
changing embedder selection invalidates only that namespace, leaving other
providers' caches valid.

## Recall — `server/src/memory/recall.ts`

A single async function that queries **both** substrates and normalizes
the result. Surfaced to the model as the `recall` tool (`createCogTools()`
in `server/src/tools/cog.ts`):

```ts
const r = await recall(query);
// {
//   hits: [
//     { from: "cog", text, where: "<path>:<line>", score: 1.0, tags? },
//     { from: "ltm", text, where: "ltm:<id>",     score: 0.87, stale?, tags? },
//     ...
//   ],
//   cogCount,  // total cog grep matches before top-K truncation
//   ltmCount,  // LTM items before dedupe
//   dropped,   // LTM hits dropped on origin path match
// }
```

Mechanics:

- Top **K=5** from each substrate. Cog uses `memory.search()` (full-text);
  LTM uses `MemorySystem.retrieve(query, {k:K})` (semantic).
- **Ordering:** strict alternation `cog[0], ltm[0], cog[1], ltm[1], …`,
  then whichever has remainder. Score is informational — cog has no
  native score and inventing a cross-substrate score would be a separate
  design problem.
- **Dedupe:** when an LTM observation record's `origin` starts with
  `cog:<path>` and a cog hit exists at `<path>:<line>`, the LTM hit is
  dropped. Conservative: this can over-drop if cog+LTM hold different
  content from the same file. Trade-off accepted per the design doc.
- **No filter parameter today.** The two substrates use different
  coordinate systems (LTM tags vs cog paths); conflating them in a single
  filter is a footgun. Deferred until usage data shows the need; when
  added, the rule is **separate `filterTags` (LTM-only) and `scopePaths`
  (cog-only)**, never one conflated argument.
- Per-substrate errors are swallowed and logged; recall always returns a
  shape even if one or both substrates throw.

## CLI — `server/src/cli/`

The server binary also exposes argv subcommands intercepted **before** the
HTTP boot. The arg-layer interception pattern (`runCli(argv)` returning
`null` to fall through to the server, a number to exit) is the
"intercept-in-the-arg-layer-you-own" pattern from the bridge lessons — no
patched dependency, no separate binary that duplicates boot.

```
node server/src/index.ts ltm replay [--force] [--rebuild] [--prune]   # one reconcile tick, JSON stats
node server/src/index.ts ltm health             # one-off CLI snapshot
npm run ltm -- replay                           # ergonomic wrapper from repo root
node server/src/index.ts ltm backfill <dir> [--rate=N] [--batch=N] [--pause-ms=N] [--poll-ms=N]
                                                  # rate-limited backfill via running server's admin route
```

`ltm replay` exits 0 if `stats.errors === 0`, 1 otherwise. `--force`
invalidates the mtime cache and re-scans every observation file, but skips
lines whose content hash already exists in LTM (idempotent). Use `--rebuild`
to additionally re-embed already-mirrored observations under the current
embedder — required after switching embedder providers or model dimensions.
`--rebuild` re-embeds current observations only. Add `--prune` with `--rebuild` to tombstone orphan records whose `cog:` origin is no longer present in the current cog file scan. `--prune` requires cog memory to be in its normal steady state — running while files are mid-archive or mid-restore will tombstone embeddings whose source is temporarily missing. The CLI opens
LTM directly, so **the server must be stopped** (single-writer lock). The
CLI's `ltm health` is intentionally not a live-server health surface — for
live state, hit the server's `/api/memory/health` endpoint or watch the
brain icon in the web UI (see [`observability.md`](observability.md)).

`ltm backfill` is different from the other two subcommands: it requires the
server to be **running** because it speaks HTTP to the admin route at
`POST/GET/DELETE /api/admin/ltm-backfill[/:jobId]` rather than opening LTM
directly. This preserves the single-writer invariant — only the server
process touches the substrate. The CLI POSTs to start a job, polls GET
until terminal status, and sends DELETE on Ctrl-C for graceful cancel.
Auth via `YTSEJAM_API_TOKEN`, server URL via `YTSEJAM_API_URL` (default
`http://127.0.0.1:9873`).

## Dreaming (nightly memory maintenance)

The **dream job** is a scheduled, background LTM maintenance pass that runs
once per night (default 03:00 local) and keeps the fact profile clean without
requiring user action. Code: `server/src/memory/dream/`.

### What it does

The job runs two phases:

1. **Mechanical (autonomous) pass** — deterministic, reversible maintenance:
   backs up `facts.jsonl`, runs `canonicalizeFacts()` (normalises predicate
   casing and synonym predicates), `consolidate()` (folds episodic memories),
   a full reconciler tick with `--rebuild --prune`, and `backfillFactEmbeddings()`.
   This phase never consults the LLM and never touches proposals; it is skipped
   when `DREAM_PROPOSE_ONLY=1`.

2. **LLM mining pass** — sends current active facts + recent user turns to the
   configured model via the `propose_changes` tool. The model returns
   confidence-scored proposals of kinds `drop` / `merge` / `resolve` / `add`.
   Proposals below `DREAM_MIN_CONFIDENCE` are discarded; proposals whose key
   matches a previously dismissed proposal are discarded (anti-thrash guard).
   Surviving proposals are persisted in `<dreamDir>/pending-proposals.jsonl`.

After both phases the job opens (or reuses) a **"Memory maintenance" chat
session** and posts a human-readable report listing each proposal with its
id, kind, targets, and rationale. The agent (or operator) can review and
reply `apply all`, `apply 1,2`, `dismiss 3`, or `explain 2` to action items
via the `dream_apply` / `dream_dismiss` / `dream_pending` cog tools.

Dream state (cursor position, last-run date, maintenance session id) is
persisted in `<dreamDir>/dream-state.json`. Each run appends a structured
entry to `<dreamDir>/dream-log.jsonl` for observability.

### Kill-switches and safety

- `DREAM_ENABLED=0` — disables the scheduler entirely; `DreamScheduler.start()`
  is a no-op. This is the recommended kill-switch for staging environments or
  while performing manual LTM surgery.
- `DREAM_PROPOSE_ONLY=1` — skips the mechanical phase (no autonomous writes to
  `facts.jsonl`). Proposals are still mined and the report is still posted.
  Useful when you want LLM review but not autonomous canonicalization.
- The mechanical pass always writes a timestamped `.bak.*` file next to
  `facts.jsonl` before touching it, so mechanical changes are trivially
  reversible with `cp`.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `DREAM_ENABLED` | `1` | Set to `0` to disable the dream scheduler entirely. |
| `DREAM_HOUR` | `3` | Hour of day (0–23, local time) at which the job runs. |
| `DREAM_MODEL` | `claude-haiku-4.5` | Chat-completions model for the LLM mining pass. Passed to the Copilot endpoint. |
| `DREAM_MINE_TOKEN_BUDGET` | `8000` | Approximate token budget for user turns fed to the miner. Newer turns are kept first when the budget is exceeded. |
| `DREAM_MIN_CONFIDENCE` | `0.6` | Minimum proposal confidence (0–1) to retain. Proposals below this are silently discarded after the LLM call. |
| `DREAM_PROPOSE_ONLY` | `0` | Set to `1` to skip the mechanical pass and only mine + report proposals. |

All env vars are read at server boot by `DreamConfig` in
`server/src/memory/dream/scheduler.ts`. Changing them requires a server
restart; there is no live-reload.

### Anti-thrash: applied proposals are excluded from re-proposal

The anti-thrash guard checks both `dismissedKeys()` and `appliedKeys()` so a
proposal that has already been applied is never re-proposed on a subsequent
nightly run. `applyProposals()` only marks a proposal `"applied"` if the
underlying mutation was verified to have landed (the fact round-trips through
the regex extractor); proposals whose fact did not land remain `"pending"` and
resurface for the next nightly pass.

## Health surface

`memory.health()` returns the cog store health (git status, file count,
last commit, etc.) and, when a reconciler is attached, an `ltm` field:

```ts
h.ltm = {
  reachable: boolean,
  consecutiveFailures: number,
  lastError?: { message, at },
  lastTickAt?: string,
  lastTickStats?: { scannedFiles, scannedLines, replayed, rebuilt, skipped, errors, durationMs? },
  orphans?: { observations: number },
};
```

`h.ltm` is **omitted** (not present, not `undefined`) when no reconciler
is attached — important for the web brain-icon polling logic, which
distinguishes "unknown / not wired" from "ok / bad".
`orphans.observations` is the cached count from the last successful
reconciler tick; `lastTickAt` is the freshness marker.

`/api/memory/health` (bearer-gated) returns `{ltm: h.ltm ?? null}` for the
web UI. See [`observability.md`](observability.md) § Health icons.


## Manifest write validation (`domains.yml`)

`domains.yml` writes are now validated synchronously before they reach disk. `memory.write()` calls `validateWholeFileWritePath()` as before, then for `rel === "domains.yml"` parses and validates the proposed YAML with `validateManifestContent(content)` before the atomic write. A bad manifest therefore fails the tool call close to the cause instead of persisting corrupt YAML and surfacing later as a mysterious `domains.get` / routing failure.

Validation checks the structure the controller expects: top-level YAML must be an object when present, `domains` must be an array, ids are non-empty and unique across nested subdomains, paths are non-empty relative paths with no `..`, `files`/`triggers` are string arrays, file basenames are declared without slashes and without `.md`, and `subdomains` is an array when present. `null` / empty manifests normalize to an empty domain list.

The read side still keeps the stale-but-served controller behavior for external edits or races: `Controller.maybeReload()` catches parse/validate failures, stores `lastError`, and continues serving the last-good manifest. `Controller.get(id)` includes the cached manifest-load error in the unknown-id message, so the error is visible through the normal `cog_rpc({method:"domains.get"})` surface. The difference after PR #211 is that writes through ytsejam's own `cog_write("domains.yml", ...)` cannot silently persist an invalid manifest in the first place.

## Patterns to know if you touch this code

- **Atomicity across substrates.** When migrating a single-store write
  into a multi-store fanout (cog + LTM), parse **all** inputs first, then
  perform **all** writes — never parse-then-write per item. A malformed
  line in the middle of a batch must abort the whole batch so cog SSOT
  and LTM never diverge mid-write. `cog_append`'s multi-line observation
  branch follows this.
- **Validate parser inputs against the SSOT regex, not prose.** The cog
  observation validator lives at `server/src/memory/store/append.ts:7`
  (`/^-\s+\d{4}-\d{2}-\d{2}\s+\[.+\]:\s*.+$/`). The bridge parser
  (`parseObservationLine`) mirrors it: tags are mandatory and non-empty,
  body is mandatory and non-empty, dates round-trip through `Date` to
  reject `2026-13-99` / `2026-02-30`. If you change one, change the other
  and lock it with a negative-case test.
- **Normalize whitespace before content-addressed dedup.** The origin
  hash is `sha256(<domainPath>/<filename>\u0000<rawLine>)[:12]`. If a
  producer splits on `\n` and a consumer splits on `/\r?\n/`, the two
  paths hash different strings and dedup breaks silently in both
  directions. Both inline writer and reconciler split on `/\r?\n/` and
  `.trim()` — keep it that way.
- **`toBeUndefined()` is too weak for OMIT semantics.** For optional
  fields like `h.ltm` whose spec is "omitted, not set to undefined",
  pair `expect(h.ltm).toBeUndefined()` with `expect("ltm" in h).toBe(false)`.
  The first passes both for the correct omit path and for an erroneous
  explicit-undefined-set mutant.
- **Mutation-test "graceful failure" assertions.** A test that says
  "we handle X gracefully" with a try/catch is only meaningful if the
  inner call actually throws. Temporarily remove the catch (or the
  defensive code) and confirm the test fails before trusting it.
