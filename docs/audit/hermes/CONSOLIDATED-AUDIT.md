# ytsejam — Consolidated Correctness Audit

Multi-angle audit of the ytsejam codebase (~23K LOC, clean tree at `b4ea8b0`).
Five angles: **backend core**, **frontend (React)**, **websocket wire format**,
**memory subsystem (cog/LTM/dream)**, and **configuration/deployment**. Read-only
— no source modified. Per-angle reports live alongside this file:
`backend-core.md`, `frontend.md`, `websocket-wire.md`, `memory-subsystem.md`.

The synthesizer (orchestrator) independently re-verified the #1 finding from each
angle against the actual code; severities below are **recalibrated for the app's
real threat model** (single-user, localhost-bound, systemd `--user` service) — a
few security-flavored subagent findings were demoted accordingly, and the
notes say so explicitly.

---

## Top-line: the 3 that matter most

1. **C1 — Dream `merge` silently destroys a fact (data loss).** The nightly
   memory-maintenance "merge" path tombstones the surviving canonical fact
   whenever its content-addressed id collides with one of the merged originals —
   which is the *natural* case (canonical "ytsejam" == original "ytsejam"). Marks
   the proposal `applied`, so it's never re-proposed. Persisted semantic memory
   is irrecoverably lost. **VERIFIED** end-to-end by the orchestrator.

2. **B1 — Abort / graceful-shutdown hangs for 5 minutes on a pending approval.**
   Nothing calls `ApprovalCoordinator.cancelSession()` (it exists + is unit-tested
   but is wired nowhere in `src/`). An ASK-mode approval pending at `POST /abort`
   or SIGTERM blocks `harness.abort()`'s `waitForIdle()` until the 5-min timeout —
   blowing past systemd `TimeoutStopSec=45` → SIGKILL, the exact path the design
   says must never happen. **VERIFIED** (grep: one match = the definition).

3. **B2 — Turn-start race drops task reports & scheduled prompts.** `running` is
   checked, then `await runPendingCompactionAtIdle` yields, then `running` is set —
   a classic check-then-act gap. Two idle-time turn-starts (user message vs. a
   background task completion / scheduled fire, both delivered via
   `injectMessage`) both pass the gate, the second `prompt()` throws "busy", its
   text is **discarded**, and its `.catch` sets `running=false` mid-turn so
   `isRunning()` then lies. **VERIFIED** (real `await` between gate read and write).

---

## Master findings table (cross-angle, severity-ordered)

| ID | Sev | Angle | Title | Primary ref |
|----|-----|-------|-------|-------------|
| **C1** | CRITICAL | memory | Dream `merge` apply tombstones the surviving canonical fact on id collision → silent semantic-memory loss, never re-proposed | `memory/dream/apply.ts:112-119` |
| **B1** | HIGH | backend | Abort/shutdown never cancels pending approvals → `harness.abort()` hangs ≤5 min, defeats graceful drain & `POST /abort` | `manager.ts:920-942`, `approval/coordinator.ts:79` (uncalled), `index.ts:504-540` |
| **B2** | HIGH | backend | Concurrent `sendMessage`/`injectMessage` race the `running` gate → dropped task report / scheduled prompt + corrupted running flag | `manager.ts:830-848`, `:859-874` |
| **F1** | HIGH | frontend | No catch-up after WS reconnect → transcript / session list / tasks / running+compacting flags silently go stale (only approvals reconcile) | `useApp.ts:224-241`, `ws.ts:42-60` |
| **F2** | HIGH | frontend | `selectSession` transcript snapshot clobbers a `message_end` arriving during the fetch (no stable message id to merge by) | `useApp.ts:270-287` |
| **MEM-H1** | HIGH | memory | Dimension-mismatch refusal samples one (oldest) record not the majority; no write path validates dim → refusal both under- & over-triggers | `ltm/api/memory-system.ts:320-327`, `memory/embedder.ts:131-147`, `index.ts:254` |
| **MEM-H2** | HIGH | memory | Mechanical dream pass embed/HTTP calls unbounded (no timeout); a hung endpoint wedges `inFlight=true` → dream dead until restart (residual #279 gap) | `memory/dream/mechanical.ts:20-23`, `ltm/embedding/*-embedder.ts`, `dream/scheduler.ts:50-56` |
| **MEM-H3** | HIGH | memory | Concurrent same-file cog writes are an unserialized read-modify-write race → silently drops an append/patch from the markdown SSOT | `memory/store/append.ts:21-63`, `write.ts`, `patch.ts` |
| **W1** | MEDIUM | wire | `agent` event variant un-typed on both sides (server emits `as any`, web types it as an open stub) → zero compile-time contract on the primary data path | `events.ts:7`, `web/types.ts:125`, `manager.ts:462-466` |
| **W2** | MEDIUM | wire | `agent_end` is in the LIGHTWEIGHT broadcast set and carries the full `messages[]` turn → every client receives transcripts of sessions it isn't subscribed to | `server.ts:72,78` |
| **B3** | MEDIUM | backend | `AgentManager.open` harness cache never evicted → unbounded harness + bus-subscription leak over the service's (weeks-long) lifetime | `manager.ts:195,240,266` (no `.delete`) |
| **B4** | MEDIUM | backend | Boot chain & scheduler have no per-item error isolation → one malformed cron/JSONL row bricks boot or permanently stalls the 30 s tick | `index.ts:203-208`, `scheduler.ts:83-118,149-168` |
| **B5** | MEDIUM | backend | Floating promise in the task pump (`.finally` re-raises) crashes the process if terminal `record()` throws (Node ≥22 unhandled-rejection = exit) | `task-manager.ts:262-265,668-674` |
| **F3** | MEDIUM | frontend | Composer `draft` not reset on session switch (un-keyed `<Chat>`) → half-typed text sent to the wrong session | `Chat.tsx:66,106-111`, `App.tsx:132` |
| **F4** | MEDIUM | frontend | Index-keyed message list leaks per-row state (ToolCallCard open / error-boundary) across session switches | `Chat.tsx:151-160`, `Message.tsx:195,227`, `MessageErrorBoundary.tsx:26-59` |
| **F5** | MEDIUM | frontend | Client `JSON.parse`+dispatch of WS frames has no try/catch (server side does) → a malformed/short frame throws out of `onmessage`, frame dropped | `ws.ts:48-55`, `useApp.ts:177-200`, `terminal-ws.ts:27-34` |
| **F6** | MEDIUM | frontend | Approval response dropped when socket≠OPEN but card latches "responded" → user stuck ≤5.5 min | `ws.ts:81-85`, `ApprovalCard.tsx:30-34` |
| **F7** | MEDIUM | frontend | WorkdirPicker→newSession swallows invalid-cwd 400 → session opens in default dir, no feedback (editor path handles it correctly) | `useApp.ts:289-309,324-330` |
| **F8** | MEDIUM | frontend | Any 401 (incl. the 10 s LTM health poll) wipes token + hard-reloads → a transient 401 force-logs-out a working session | `api.ts:23-27`, `useApp.ts:243-268` |
| **MEM-M1** | MEDIUM | memory | Dream "ran today" marker written in UTC but due-check compares local time → ~7 unsupervised runs/night in positive-UTC-offset zones | `dream/dream-job.ts:105` vs `dream/scheduler.ts:3-39` |
| **MEM-M2** | MEDIUM | memory | LTM observation id collides on identical text + same calendar day → two cog lines collapse to one record; permanent re-replay under `--force/--rebuild` | `ltm/api/memory-system.ts:245-250`, `bridge/ltm-observer.ts:23` |
| **MEM-M3** | MEDIUM | memory | Empty-query guard (#275) incomplete: cog `search("")` matches every line → recall injects 5 arbitrary lines; manager's "profile-only" comment is false | `memory/recall.ts:98-134`, `store/search.ts:10-21` |
| **MEM-M4** | MEDIUM | memory | Last-session-before-shutdown turns can be permanently absent from LTM (ingest is fire-and-forget, not drained, no boot re-ingest) | `manager.ts:500-519`, `index.ts:203-207` |
| **MEM-M5** | MEDIUM | memory | Concurrent un-serialized `ingestSessionFile` (chat-end + task-end) shares mutable pipeline state + whole-file state overwrite + fixed-name compaction tmp | `ltm/pipeline/ingest.ts:64-102`, `ltm/store/jsonl-log.ts:91-101` |
| **B6–B9** | LOW | backend | Indexer writes after `close()` (only `setTitle` guards); mid-run rename lost on crash; `postAssistantNote` no running-guard; approval timer not `unref`'d | `indexer.ts:208-229`, `manager.ts:973-983,880-918`, `coordinator.ts:52-65` |
| **F9–F16** | LOW | frontend | pending_approvals empty-seed flicker; `"Bearer null"`; notify spam; TaskCard trailing fetch; unguarded async setState; fire-and-forget unread PATCH | see `frontend.md` |
| **W3–W10** | LOW | wire | ContentBlock lacks image fields; `pending_approvals` in neither union; compaction surrender emits no `compaction_end`; unvalidated `subscribe` sessionId | see `websocket-wire.md` |
| **MEM-L1–L3** | LOW | memory | `JsonlLog.compact()` fixed `.tmp` name; resolve/merge trust LLM factIds ordering; `hasObservation()` O(n) per line | see `memory-subsystem.md` |
| **CFG-1** | LOW/INFO | config | Several directly-read env vars (`DREAM_HOUR`, `DREAM_MIN_CONFIDENCE`, `LTM_RECONCILE_INTERVAL_MS`) are `Number()`-coerced with no NaN guard, unlike `config.ts` which clamps | `index.ts:383-386,274` |
| **CFG-2** | LOW/INFO | config/wire | Absolute session-file `path` is returned to the client (REST `toRow` + `session_meta`) and WS auth token rides the URL query string | `indexer.ts:365-377`, `ws.ts:35` |

---

## Verified by the orchestrator (not just self-reported)

- **C1** — traced `redactFact` → `redactFactById` (tombstones by id), confirmed
  `factId()` is deterministic from `{kind, predicate, normalizeObject(object),
  polarity}` (`ltm/semantic/extract.ts:73-81`), and confirmed the merge branch's
  `for (const id of p.factIds) deps.ltm.redactFact(id)` (`apply.ts:118`) is
  unconditional. Confirmed the passing test (`apply.test.ts:97-105`) *deliberately*
  picks a distinct object "so its fact id won't collide" — i.e. the bug case is
  known and side-stepped, never asserted. **Real.**
- **B1** — repo-wide search for `cancelSession`: exactly one hit, the definition
  at `coordinator.ts:79`. Zero call sites in `src/`. **Real.**
- **B2** — confirmed `runPendingCompactionAtIdle` is `async` (yields a microtask
  even on its fast path) and sits between the `if (opened.running)` read and the
  `opened.running = true` write in both `sendMessage` and `injectMessage`. **Real.**
- **F1/F2** — confirmed the mount effect (`useApp.ts:230-233`) is the only place
  that calls `refreshSessions()`/`listTasks()`, the reconnect path (`ws.ts`
  `onopen`) only re-sends `subscribe`, and `selectSession` issues `subscribe`
  before the transcript fetch then `setMessages(snapshot)` last-write-wins. **Real.**
- **MEM-M1** — confirmed `dream-job.ts:105` writes `deps.now().slice(0,10)` (UTC ISO)
  while `scheduler.ts` `ymd()`/`getHours()`/`isDue()` are all local-time. **Real.**
- **CFG-2 recalibration** — confirmed `indexer.toRow` (`:365-377`) *always*
  includes `path`, so the WS audit's "session_meta leaks an absolute path" is
  consistent with every REST session response too. In a single-user localhost app
  the only client is the owner of those paths → **demoted HIGH→LOW/INFO.**

---

## Themes (what to fix first, by leverage)

1. **Autonomous memory mutation lacks guardrails (C1, MEM-H1, MEM-H2, MEM-M1).**
   The newest, churniest subsystem (#278/#279/#280 dreaming) writes to the
   authoritative memory store unsupervised, and its safety rails have gaps: a
   merge that eats the kept fact, a dim-gate that samples the wrong record, an
   unbounded embed pass that can wedge the whole job, and a UTC/local clock split
   that fires it ~7×/night. **C1 is the single highest-priority fix** — it's the
   only finding that silently and irrecoverably destroys user data on the common
   path. One-line fix: skip the canonical id in the redact loop.

2. **Lifecycle correctness: abort & shutdown (B1, B4, B5).** The graceful-drain
   design is explicitly load-bearing (the docs say a SIGKILL is a bug signal), but
   B1 defeats it whenever an approval is pending, and B4/B5 can brick boot or crash
   the process. B1's fix is small and high-value: call `cancelSession()` in
   `abort`/`abortAll`.

3. **Turn-delivery & WS-reconnect races (B2, F1, F2).** Messages, task reports,
   and scheduled prompts can be silently dropped — backend (B2) and frontend
   (F1/F2) both. These are the "where did my message go?" class of bug and none is
   covered by an executing test.

4. **The test suite is thinner than it looks (cross-cutting).** The web
   `test/*.mjs` suite is ~80% `readFileSync`+regex source-inspection, not behavior
   — none of F1–F7 is exercised by running code, so the green gate would survive
   any of those regressions. Worth converting the state-machine tests
   (`useApp.onEvent`, `selectSession`) to real reducer tests.

5. **Hand-mirrored type contracts (W1).** The `ServerEvent` union is maintained by
   hand in two files; the `agent` variant — the primary data path — is effectively
   untyped on both sides (`as any` + open stub). A shared type package (or codegen)
   would turn several latent wire bugs into compile errors.

---

## Calibration notes / disagreements with the sub-reports

- **Security-flavored findings demoted for the threat model.** Token-in-WS-URL
  (W7/F16), absolute-path exposure (W2/CFG-2), non-constant-time token compare,
  and unvalidated `subscribe` sessionId are all real observations but low-impact
  for a single-user, localhost-bound, token-gated service where the sole client is
  the machine owner. Kept as LOW/INFO, not HIGH.
- **W2 (agent_end broadcast) kept at MEDIUM** even though it's "only" the owner's
  own data — because it's also wasteful (full transcripts fan out to every socket)
  and is a real privacy seam *if* the app is ever exposed beyond localhost. Worth
  scoping `agent_end` payloads to subscribers regardless.
- **Everything rated HIGH/CRITICAL was independently spot-checked**; the MEDIUM/LOW
  tiers rely on the sub-agents' reasoning + their cross-checks against the existing
  test suite (each report lists the guards it confirmed present, to avoid false
  positives).
