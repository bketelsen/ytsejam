# ytsejam Persistent-Memory Subsystem — Correctness Audit

**Scope:** cog markdown store (`server/src/memory/store/**`), LTM vector engine
(`packages/ltm/src/**`), the cog→LTM bridge (`server/src/memory/bridge/**`),
the nightly "dreaming" maintenance (`server/src/memory/dream/**`), plus the
public surface, recall, embedder selection, and session-ingest wiring.

**Method:** read every in-scope file + the design docs
(`docs/agents/memory-bridge.md`, `storage.md`, `server/src/memory/README.md`,
`docs/memory/FORMAT.md`) and cross-checked each suspicion against the test
suite (`server/test/memory/**`, `server/test/*ltm*`,
`packages/ltm/src/**/*.test.ts`). Read-only; no files modified.

Single-user, single Node process is assumed throughout — but the codebase
fires several **un-awaited / parallel** writers, so "one process" does **not**
imply "one writer at a time." Several findings hinge on that.

---

## Ranked summary

| # | Sev | Title | Key ref |
|---|-----|-------|---------|
| C1 | **CRITICAL** | Dream `merge` apply destroys the surviving canonical fact when its id collides with an original → silent semantic-memory loss, never re-proposed | `dream/apply.ts:99-119` |
| H1 | **HIGH** | Dimension-mismatch refusal keys off a single first-record sample, not the majority; write paths never validate dim — refusal both under- and over-triggers | `api/memory-system.ts:320-327`, `embedder.ts:131-147`, `index.ts:254` |
| H2 | **HIGH** | Mechanical dream pass embedding/HTTP calls are unbounded (no timeout); a hung endpoint wedges the nightly job and permanently blocks the scheduler — residual #279 gap | `dream/mechanical.ts:20-23`, `copilot-embedder.ts`, `dream/scheduler.ts:50-56` |
| H3 | **HIGH** | Concurrent same-file cog writes are an unserialized read-modify-write race → silently drops an append/patch from the markdown SSOT | `store/append.ts:21-63`, `store/write.ts`, `store/patch.ts` |
| M1 | MEDIUM | Dream date bookkeeping mixes UTC (state write) and local (due check) → multiple unsupervised runs per night in positive-UTC-offset timezones | `dream/dream-job.ts:105`, `dream/scheduler.ts:3-4,29-39` |
| M2 | MEDIUM | LTM observation id collides on identical text + same calendar day → two cog lines map to one LTM record; permanent re-replay under `--force/--rebuild` | `api/memory-system.ts:245-250`, `bridge/ltm-observer.ts:23` |
| M3 | MEDIUM | Empty-query guard (#275) incomplete: cog `search("")` matches every line → recall injects spurious hits; manager's "profile-only" comment is false | `recall.ts:98-134`, `store/search.ts:10-21`, `manager.ts:337` |
| M4 | MEDIUM | Last-session-before-shutdown turns can be permanently absent from LTM: ingest is fire-and-forget + not drained + no boot re-ingest | `manager.ts:500-519`, `task-manager.ts:632-642`, `index.ts:203-207` |
| M5 | MEDIUM | Concurrent un-serialized `ingestSessionFile` (chat-end + task-end) share mutable pipeline state + full-overwrite state file + fixed-name compaction tmp | `pipeline/ingest.ts:64-102`, `store/jsonl-log.ts:91-101` |
| L1 | LOW | `JsonlLog.compact()` uses a fixed `${file}.tmp` (no pid/uuid) — latent corruption if compaction ever overlaps | `store/jsonl-log.ts:93` |
| L2 | LOW | `resolve`/`merge` trust LLM `factIds` ordering with no keep≠drop guard | `dream/apply.ts:53-55` |
| L3 | LOW | `hasObservation()` is O(n) full-scan per call; reconciler calls it per line → O(lines×records) per forced tick | `api/memory-system.ts:297-300` |

**Verified-OK (refuted suspicions):** the provenance gate (#277) is correctly
enforced — `recordObservation` defaults `learnFacts:false` and the only two
`learnFacts:true` callers are the user-approved dream apply paths
(`dream/apply.ts:78,103`); the bridge mirror never opts in, so cog observations
stay episodic-only. `cosine()` correctly throws on dim mismatch and every live
caller dimension-guards first (`retriever.ts:210`, `promote.ts:141`,
`retriever.ts:246`). The reconciler CRLF/trim origin parity, the
parse-all-before-write batch atomicity (`cog.ts:204-226`), the markdown-noise
filter parity, and the manifest validate-on-write (`store/write.ts:13-15`) all
hold and are well tested.

---

## CRITICAL

### C1 — Dream `merge` apply destroys the surviving canonical fact on id collision (silent semantic-memory loss)

**Files:** `server/src/memory/dream/apply.ts:85-120` (the `merge` branch);
miner `server/src/memory/dream/miner.ts:33-34` (canonical schema, no
distinctness constraint).

**The bug.** The merge branch records the canonical fact, verifies it
round-trips, then redacts **every** original id:

```ts
// apply.ts (merge branch)
await deps.ltm.recordObservation({ text: obsPhrase(predicate,object,polarity),
                                   timestamp: deps.now(), origin:"dream:approved",
                                   learnFacts:true });           // (1) lands canonical
if (!factExists(deps.ltm, predicate, object)) { ...return false; }
const canon = deps.ltm.listFacts().find(/* matches predicate/object */);
if (canon && carriedSources.length) deps.ltm.attachFactSources(canon.id, carriedSources);
for (const id of p.factIds) deps.ltm.redactFact(id);            // (2) redacts ALL originals
return true;
```

Nothing requires the canonical to be **distinct** from the originals. The
canonical's id is content-addressed (`factId(kind, canonicalizePredicate(pred),
slug(normalizeObject(object)), polarity)` — `semantic/extract.ts:73-81`). When
the canonical normalizes to the **same id as one of the merged facts**:

1. `recordObservation(...learnFacts:true)` re-asserts that existing fact →
   it stays/returns to `active`.
2. `factExists` → true; `canon` = that fact.
3. `for (const id of p.factIds) redactFact(id)` redacts **it too**, because its
   id is in `p.factIds`.

Net: all merged facts AND the canonical are tombstoned; the function returns
`true`, the proposal is marked `applied`, and the anti-thrash guard
(`appliedKeys()`, `dream-job.ts:72`) guarantees it is **never re-proposed**.
Persisted semantic memory is silently and irrecoverably destroyed (recoverable
only from the timestamped `.bak.*` made by the mechanical pass, if it ran, and
only by hand).

**Trigger (highly realistic).** "Give the canonical form" of two near-duplicate
facts very naturally equals one of them. Example: merge
`works_on=ytsejam` + `works_on=the ytsejam project` with canonical
`works_on=ytsejam`. `normalizeObject` strips the leading "the", so the two
originals differ, but the canonical's id (`fact-attribute-works_on-ytsejam-p`)
**equals original #1**. The apply destroys both.

**Why tests miss it.** `server/test/memory/dream/apply.test.ts:97-105`
deliberately constructs the canonical with *a distinct object* "so its fact id
won't collide with the originals" — i.e. the colliding case is known and
side-stepped, never asserted against.

**Fix.** Exclude the canonical id from the redact loop:
`for (const id of p.factIds) if (id !== canon?.id) deps.ltm.redactFact(id);`
(and/or have the miner reject a `merge` whose canonical id is in `factIds`).

---

## HIGH

### H1 — The "dimension-mismatch refusal" is keyed off a single sampled record, and no write path validates dimension

**Files:** `packages/ltm/src/api/memory-system.ts:320-327` (`indexDimension`),
`:336-354` (`dimensionReport`, the *correct* majority computation, used only for
a warning); `server/src/memory/embedder.ts:131-147` (`checkDimensionMismatch`);
`server/src/index.ts:254-273` (the only enforcement site);
`api/memory-system.ts:245-267` / `semantic/store.ts:97-109,301-320` (write
paths that embed-and-persist with no dim check).

**The gap.** The documented refusal exists in exactly one place — server boot:

```ts
const mismatch = checkDimensionMismatch(opened.indexDimension(), embedderResult);
if (mismatch) throw new Error(mismatch);
```

But `indexDimension()` returns `VectorIndex.sampleDimension()` — the length of
the **first** episodic record carrying an embedding (Map/log insertion order),
because `VectorIndex.set` pins to the first vector and refuses the rest. So the
gate compares the *new* embedder against **one arbitrary (oldest) record**, not
the store's majority dimension:

- **Under-trigger / contamination:** a store that is majority 1536-dim
  (copilot) but whose first log line is a 256-dim hash contaminant returns
  `indexDimension() === 256`. Booting with `YTSEJAM_LTM_EMBEDDER=hash` then
  *passes* the gate (256===256) and proceeds to append more 256-dim vectors
  into a majority-1536 store. The class already knows the truth via
  `dimensionReport().primary` but only logs it as a warning (`index.ts:261-273`).
- **Over-trigger / total LTM loss:** the same single 256-dim head record makes
  boot with the *correct* copilot embedder compute
  `checkDimensionMismatch(256, 1536)` → mismatch → `throw` →
  `attachLtmBridge` catch detaches LTM and schedules retries that will fail
  identically forever. LTM is silently disabled until a manual `ltm replay`.

Additionally, **no runtime write path validates dimension at all**:
`recordObservation` (`:263`), `ingestTurn`→`embedFact`, `backfillEmbeddings`,
and `consolidate` all persist `await embedder.embed(...)` straight into
`episodic.jsonl`/`facts.jsonl`. Intra-process this is safe (one fixed embedder),
but combined with `auto` mode's *silent* downgrade to 256-dim `HashEmbedder` on
lost Copilot creds (`embedder.ts:58-79`) and `ltm replay --rebuild`
*intentionally* skipping the refusal (`cli/ltm-commands.ts:150-156`), the only
backstop against a mixed-dim index is the boot gate — which is unreliable per
above.

**Severity rationale.** Not CRITICAL because `VectorIndex`/`Retriever` pin
retrieval to the majority dimension and `cosine` throws rather than scoring
across dims, so a mixed index *degrades* (minority bucket excluded) rather than
returning garbage. But it silently (a) drops correct records from retrieval and
(b) can disable LTM wholesale, and the documented guarantee ("dimension-mismatch
refusal … enforced on every write path") is not met.

**Fix.** Drive the gate off `dimensionReport().primary` (majority), not
`indexDimension()`; consider a dimension assertion in `EpisodicStore.upsert` /
`SemanticStore` writes against an index-pinned dimension.

---

### H2 — Mechanical dream pass makes unbounded embedding/HTTP calls; a hang wedges the nightly job permanently (residual #279 gap)

**Files:** `server/src/memory/dream/mechanical.ts:20-23`;
`packages/ltm/src/embedding/copilot-embedder.ts:32-51`,
`ollama-embedder.ts:38-52` (bare `fetch`, **no** `AbortController`/timeout —
confirmed: zero `AbortController`/`signal`/`setTimeout` in all of
`packages/ltm/src`); `server/src/memory/dream/scheduler.ts:50-56`;
`server/src/index.ts:400-419` (dream `run` has `.catch` but no timeout).

**The gap.** Issue #279 bounded the **miner** LLM call with a 30s
`AbortController` (`miner.ts:85-101`) — verified present and correct. But the
mechanical pass runs *before* the miner and calls four embed-heavy operations,
none of which is time-bounded:

```ts
deps.ltm.canonicalizeFacts();            // re-embeds via assertFact paths
await deps.ltm.consolidate();            // embeds each summary
await deps.reconcile({rebuild:true,prune:true});  // RE-EMBEDS EVERY observation
await deps.ltm.backfillFactEmbeddings(); // embeds every un-embedded fact
```

Every `embedder.embed()` underneath is a Copilot/Ollama HTTP `fetch` with no
timeout. If the embeddings endpoint hangs (TCP black-hole, proxy stall), the
mechanical pass blocks indefinitely. Worse, the scheduler's re-entrancy guard
never clears:

```ts
const tick = async () => {
  if (this.inFlight || !this.isDue()) return;
  this.inFlight = true;
  try { await this.opts.run(); } catch {...} finally { this.inFlight = false; }
};
```

A hung `run()` means `finally` never executes → `inFlight` stays `true` forever
→ **all** future nightly ticks early-return. The dream subsystem is dead until
the process restarts. The miner timeout is necessary but not sufficient; the
"bound the call so it can't stall the nightly run" intent of #279 was applied to
the miner only, leaving the larger mechanical embedding surface unbounded.

**Fix.** Add an `AbortController`/timeout to the embedder HTTP calls
(copilot/ollama), and/or wrap `runMechanicalPass`/`run()` in an overall
`Promise.race` deadline so a hung backend can't pin `inFlight`.

---

### H3 — Concurrent same-file cog writes are an unserialized read-modify-write race (silent SSOT data loss)

**Files:** `server/src/memory/store/append.ts:21-29` (`appendAtEOF`),
`:31-63` (`appendUnderSection`), `store/write.ts:7-18`, `store/patch.ts:7-16`
— all do `readFile → compute → atomicWrite(rename)` with **no per-file mutex**;
`store/fs.ts:5-28` (`atomicWrite` is atomic per write but does not serialize the
read-modify-write); pi default `toolExecution: "parallel"`
(`node_modules/@earendil-works/pi-agent-core/dist/agent.js:128`,
`agent-loop.js:299-332`) and ytsejam never sets it sequential.

**The bug.** Each cog mutation reads the whole file, computes new content, and
atomically renames a temp over it. The rename is atomic, but the
read→modify→write sequence is not guarded. When two writes to the **same file**
overlap:

```
append A: read existing(=X) ─┐
append B: read existing(=X) ─┤   both see X
append A: write X+a (rename) ─┘
append B: write X+b (rename)     ← clobbers X+a; "a" is lost
```

pi executes a batch of tool calls with `executeToolCallsParallel`
(`await Promise.all(...)`), so if the model emits two `cog_append`/`cog_patch`
calls targeting the same file in one assistant turn (e.g. two observations to
`personal/observations.md`), the second rename silently drops the first. Because
cog markdown is the **authoritative** substrate, this is silent persisted-memory
loss. It can also desync the substrates: the LTM mirror runs per
`recordObservation` and each line hashes to a distinct origin, so LTM may retain
*both* lines while cog keeps only one → cog/LTM divergence the reconciler's
orphan accounting will then flag.

**Severity rationale.** HIGH not CRITICAL because the trigger requires
same-file writes within a single parallel batch (cross-file parallel writes are
safe), which is not the dominant pattern — but it is reachable from normal model
behavior and corrupts the SSOT with no error.

**Fix.** Serialize store mutations per resolved path (an async keyed mutex
around `append`/`write`/`patch`/`move`), mirroring the existing
`auto-commit.ts` coalescing mutex.

---

## MEDIUM

### M1 — Dream "ran today" marker is written in UTC but compared in local time → multiple unsupervised runs per night (and inconsistent baseline)

**Files:** `server/src/memory/dream/dream-job.ts:105`
(`lastRunDate: deps.now().slice(0,10)` where `now = () => new Date().toISOString()`
→ **UTC** date); `server/src/memory/dream/scheduler.ts:3-4` (`ymd()` uses
`getFullYear/getMonth/getDate` → **local**), `:29-33` (`isDue` compares
`lastRunDate()` to local `ymd(now)`), `:38` (`getHours` → local);
`server/src/index.ts:433-439` (`recordBaseline` writes local `ymd`, *unlike*
the job's UTC write).

**The bug.** The due-check compares a **UTC** date string against a **local**
date string. In positive-UTC-offset zones the UTC date lags local at the run
hour:

- Sydney (UTC+10), `DREAM_HOUR=3`: 03:00 local Jun 20 = 17:00 UTC Jun 19.
- First run writes `lastRunDate="2026-06-19"` (UTC).
- 04:00 local Jun 20: `isDue` → hour ok, `"2026-06-19" !== ymd(local)="2026-06-20"`
  → **true → runs again**. Repeats hourly until UTC rolls to Jun 20 (10:00 local).

Result: ~7 full mechanical passes + LLM mining runs per night instead of one.
Each backs up `facts.jsonl` and is roughly idempotent, so this is wasteful and
unsupervised-write-amplifying rather than directly corrupting — but it
contradicts the "once per night" contract and multiplies autonomous fact
mutation windows. The seed/run inconsistency (baseline local ymd vs job UTC
slice) is the root smell.

Separately, the documented "a daytime (re)start does NOT trigger an immediate
unsupervised run" holds only on the **first-ever** boot (`shouldSeedBaseline`
requires `lastRunDate===null`). A restart with a prior-day `lastRunDate` *does*
fire immediately if today's run hasn't happened — defensible as catch-up, but
stronger than the doc's blanket claim.

**Fix.** Use one clock convention end-to-end — compute `lastRunDate` with the
same local `ymd()` the scheduler compares against (or compare both in UTC).

---

### M2 — LTM observation id collides on identical text + same calendar day → two cog lines collapse to one record; permanent re-replay under `--force`

**Files:** `packages/ltm/src/api/memory-system.ts:245-250`
(`id = obs-<sha256(text + "\n" + timestamp)[:12]>`);
`server/src/memory/bridge/ltm-observer.ts:16,23`
(`timestamp = "${date}T00:00:00.000Z"` — day granularity).

**The bug.** Observation timestamps are truncated to the day, and the LTM record
id hashes only `text + timestamp`. So two **distinct** cog observation lines with
the same body and same calendar day (but different tags, or simply logged twice)
produce the **same** LTM id and upsert over each other — LTM keeps one record
(latest tags/origin win) for two cog lines, so semantic recall under-covers.

The dedup origin (`computeOrigin`, `ltm-observer.ts:28-36`) hashes the full raw
line *including tags*, so the two lines have different origins. After recording
line1 then line2 (same id), the single record's `origin` = origin2. On a
`--force`/`--rebuild` tick the reconciler does
`hasObservation(origin1)` → false (record now holds origin2) → re-records
(origin flips to origin1) → next forced tick origin2 looks missing → re-records
again. The two same-day-same-text lines **never dedup under force** and
ping-pong the single record (`stats.replayed` keeps incrementing). Orphan
accounting stays correct (one of the two origins is always live), so no false
prune — the cost is wasted re-embeds and a permanently "dirty" forced replay.

**Fix.** Fold the origin (or tags) into the LTM observation id, or carry a
real per-line timestamp rather than midnight-truncated.

---

### M3 — Empty-query guard (#275) is incomplete: cog `search("")` matches every line; recall injects spurious hits

**Files:** `server/src/memory/recall.ts:98-134` (no empty-query short-circuit
before `memory.search(query)`); `server/src/memory/store/search.ts:10-21`
(`"".toLowerCase()` → `line.includes("")` is always true);
`server/src/manager.ts:337` (comment claims "On empty query, buildMemorySection
emits profile-only (no recall hits)").

**The bug.** #275 added the empty-query guard to `MemorySystem.retrieve`
(`api/memory-system.ts:367-370`) and `Retriever.rank`
(`retrieval/retriever.ts:132`) — verified correct. But `recall()` calls
`memory.search(query)` with no guard, and cog full-text `search("")` matches
*every line of every markdown file*: `cogCount` becomes the total line count and
`cogHits` is the first 5 lines of the store, which then get interleaved into the
recall result and injected into the system prompt by `buildMemorySection`. The
manager's comment that an empty query yields "profile-only (no recall hits)" is
therefore false — it yields 5 arbitrary cog lines.

Reachable directly: the `recall` tool passes the model's `query` straight
through (`tools/cog.ts:277-278`), and the model can pass `""`.

**Severity rationale.** MEDIUM — misleading context injection and a false
in-code invariant, but not corrupting.

**Fix.** Short-circuit `if (!query.trim()) return {hits:[],cogCount:0,ltmCount:0,dropped:0}`
at the top of `recall()` (and/or guard `store/search.ts`).

---

### M4 — Last-session-before-shutdown turns can be permanently missing from LTM

**Files:** `server/src/manager.ts:500-519` (ingest fired via `setTimeout(0)` on
`agent_end`, un-awaited, `.catch`-only); `server/src/task-manager.ts:632-642`
(same for subagent sessions, in a `finally`); `server/src/index.ts:203-207`
(boot does `rebuildIndex`/`recoverInterrupted` for sqlite — but **no**
`ingestSessionDir`/turn re-ingest); shutdown drain `index.ts:542-547` drains the
reconciler but not pending ingest timers.

**The bug.** Turn-ingest into LTM is best-effort and fire-and-forget
(`setTimeout(() => ltm?.()?.ingestSessionFile(...), 0)`), explicitly not awaited.
On a session that ends just before SIGTERM, the timer may never run, and there
is **no boot-time catch-up** that re-ingests session JSONLs — the reconciler only
back-fills `observations.md`, not conversation turns. A session that ends and is
never reopened therefore can have its final turns absent from LTM forever; only
the manual `ltm backfill` CLI recovers them. (`ingestFile` is incremental via
`ingest-state.json`, so a *reopened* session self-heals on its next
`agent_end` — but many sessions are never reopened.)

**Fix.** On boot, run a bounded `ingestSessionDir(sessions)` catch-up (it's
idempotent via `ingest-state.json`), or flush pending ingest in the drain.

---

### M5 — Concurrent un-serialized `ingestSessionFile` shares mutable pipeline state and a fixed-name compaction temp

**Files:** `packages/ltm/src/pipeline/ingest.ts:64-102` (`this.state` mutated +
`saveState()` whole-file overwrite per call); `api/memory-system.ts:194-206`
(`ingestSessionFile`/`ingestSessionDir` are `async`, callers don't serialize);
`store/jsonl-log.ts:91-101` (`compact()` writes a **fixed** `${file}.tmp`).

**The bug.** The "single-writer" invariant is enforced only across *processes*
(advisory lock, `api/memory-system.ts:137-166`). Within the one process,
`ingestSessionFile` is fired un-awaited from **two** managers (chat `agent_end`
and task-completion `finally`). If a chat session and a subagent task finish
near-simultaneously, two `ingestFile` runs interleave: both read/extend
`this.state`, both call `saveState()` (full overwrite — last writer wins, can
drop the other's `entryIds` delta), and any overlapping `compact()` (from a
concurrent `consolidate`/redact) shares one `${file}.tmp` path. Content-addressed
ids make a dropped `entryIds` entry self-heal (re-ingest upserts, no dup), and
`appendFileSync` is atomic per call, so this is degradation/redundant-work rather
than guaranteed corruption — but the fixed-tmp compaction (L1) is a real latent
corruption hazard the moment two compactions overlap.

**Fix.** Serialize LTM mutating entry points behind a single in-process queue;
give `compact()` a unique temp name (see L1).

---

## LOW

### L1 — `JsonlLog.compact()` uses a fixed temp filename

`packages/ltm/src/store/jsonl-log.ts:93` — `const tmp = `${this.filePath}.tmp`;`.
Unlike the cog store's `atomicWrite` (`store/fs.ts:7`, pid+uuid suffixed), two
overlapping compactions of the same log would write the same temp and one
`rename` could publish a half-written file. Sequential in practice today, but a
single-point latent corruption hazard. Fix: `\`${filePath}.\${process.pid}.\${randomUUID()}.tmp\``.

### L2 — `resolve`/`merge` trust LLM `factIds` ordering

`server/src/memory/dream/apply.ts:53-55` — `resolve` redacts `factIds[1]`
(convention "[0]=keep, [1]=drop") with no check that `factIds[0] !== factIds[1]`
or that index 1 isn't the intended survivor. An LLM that inverts the order
silently redacts the fact the user wanted to keep and marks the proposal
`applied` (so it won't resurface). Lower-impact sibling of C1. Fix: validate
keep≠drop and that both ids exist before redacting.

### L3 — `hasObservation()` is O(n) per call

`packages/ltm/src/api/memory-system.ts:297-300` — linear scan of *all* episodic
records, called once per candidate line by the reconciler
(`bridge/ltm-reconciler.ts:297`). A forced/rebuild tick over a large store is
O(lines × records). Correctness is fine; flagged as a scaling cliff for the
nightly `--rebuild` path. Fix: maintain an `origin → id` index alongside the
episodic map.

---

## Notes on items explicitly checked and found correct

- **Provenance gate #277:** `recordObservation` is episodic-only by default;
  `learnFacts:true` appears only at `dream/apply.ts:78,103` (user-approved
  add/merge). The bridge `mirrorToLtm` (`ltm-observer.ts:42-62`) never sets it.
  Profile facts cannot leak in from cog observation mirroring. **Holds.**
- **Vector normalization #269:** `normalizeUnit`/`cosine`
  (`embedding/embedder.ts:87-111`) are the single shared path; `cosine` throws on
  dim mismatch and all three live scorers dimension-guard first
  (`retriever.ts:210,246`, `promote.ts:141`). Zero-vector → norm-1 fallback is
  handled. **Holds.**
- **Bridge dedup / double-ingest:** inline `recordObservation` and the reconciler
  produce the same `cog:<path>#<sha>` origin for the same line bytes
  (CRLF/trim parity verified in `ltm-reconciler.test.ts:484-503`), and LTM ids
  are content-addressed, so inline+reconciler firing on the same line mirrors
  once. **Holds** (except the same-text-same-day collision, M2).
- **Reconciler failure isolation:** per-line errors are counted, not fatal; the
  cog write never depends on the LTM mirror result (`index.ts:251-257`). **Holds.**
- **Batch atomicity:** `cog_append` parses all observation lines before any
  write (`tools/cog.ts:204-226`), and `recordObservation` rejects embedded
  newlines (`index.ts:215-219`). **Holds.**
- **Manifest/`domains.yml` validate-on-write:** `store/write.ts:13-15` →
  `validateManifestContent` (`domain/manifest.ts:71-97`) rejects bad structure,
  `..`, absolute paths, dup ids before disk; read side stays stale-but-served.
  **Holds.**
- **Path traversal:** `normalizeRelPath` + `resolveMemoryPath`
  (`store/paths.ts:31-51`) reject absolute/`..`/`/../`; `move` enforces the
  whole-file allow-list on the destination; `init_canonical_file`/`skill_write`
  constrain basenames to `[a-z][a-z0-9-]*`. **Holds.**
- **Parser robustness:** `observation-grammar.ts` / `observations-parser.ts`
  round-trip dates through `Date`, skip (not throw) on malformed input; the
  session reader and `JsonlLog.load()` tolerate corrupt lines (streamed chunk
  read avoids the V8 string cap). **Holds.**
- **Proposal apply idempotency:** `applyProposals` only marks `applied` on a
  verified round-trip (`apply.ts:84,106-119,135-142`); failures stay `pending`.
  The anti-thrash guard reads both `dismissedKeys()` and `appliedKeys()`
  (`dream-job.ts:72`). **Holds — except the C1 false-positive "verified" on a
  merge that then self-destructs.**
