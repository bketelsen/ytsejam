# ytsejam Frontend (React UI) Correctness Audit

Scope: `web/src/**` — central state hook, WS client, REST client, approval
watchdog, and all listed components. Read-only audit. Server files consulted
only to establish the event/wire contract that the UI consumes.

**Meta-finding (affects confidence in the whole module):** the `web/test/*.mjs`
suite is overwhelmingly **source-inspection** (it does `readFileSync()` on the
`.tsx`/`.ts` source and `assert.match`es regexes against the *text*). Only
`slash-menu`, `approval-prefix`, `time`, and `approval-watchdog` execute any
real code — and `approval-watchdog.test.mjs` re-implements the reducer in a
local `makeHarness()` (lines 39–88) instead of importing `useApp`, so it tests
a *copy* of the logic, not the shipped reducer. **None of the state-sync races
below are exercised by an executing test.** A regression in the real `useApp`
`onEvent`/`selectSession` would pass CI green. Treat the green suite as a
spelling-checker for the source, not a behavioral safety net.

---

## Ranked summary

| # | Sev | Title | File:line |
|---|-----|-------|-----------|
| 1 | HIGH | No catch-up after WS reconnect: transcript, session list, tasks, and running/compacting flags silently go stale; only approvals reconcile | `useApp.ts:224-241`, `ws.ts:42-60` |
| 2 | HIGH | `selectSession` transcript snapshot clobbers a `message_end` arriving during the fetch (acknowledged in-code; unguarded by tests) | `useApp.ts:270-287` |
| 3 | MEDIUM | Composer `draft` (and other Chat-local state) is not reset on session switch — half-typed text can be sent to the wrong session | `Chat.tsx:66,106-111`, `App.tsx:132` |
| 4 | MEDIUM | Index-keyed message list leaks per-row state (`ToolCallCard` open, copied flag) across session switches & reorders | `Chat.tsx:151-160`, `Message.tsx:195,227` |
| 5 | MEDIUM | `MessageErrorBoundary` never clears its error → sticky fallback mis-attributes to later valid messages (worsened by index keys) | `MessageErrorBoundary.tsx:26-59`, `Chat.tsx:152` |
| 6 | MEDIUM | WS frames `JSON.parse`'d and routed with no try/catch; malformed/short agent frame throws out of `onmessage` and the frame is dropped | `ws.ts:48-55`, `useApp.ts:177-200`, `terminal-ws.ts:27-34` |
| 7 | MEDIUM | `respondToApproval` is silently dropped when socket ≠ OPEN, but `ApprovalCard` latches "responded" → user is stuck until the 5.5-min watchdog | `ws.ts:81-85`, `useApp.ts:341-346`, `ApprovalCard.tsx:30-34` |
| 8 | MEDIUM | WorkdirPicker → `newSession` swallows an invalid-cwd 400; session opens in the default dir with the picker already closed and zero feedback | `useApp.ts:289-309,324-330` |
| 9 | MEDIUM | Any 401 (incl. the 10 s LTM poll) wipes the token and hard-reloads — a transient/misrouted 401 force-logs-out a valid session | `api.ts:23-27`, `useApp.ts:243-268` |
| 10 | LOW | `pending_approvals` empty-seed on every (re)connect causes a transient approval flicker + watchdog timer churn | `useApp.ts:203-222`, server `server.ts:124-129` |
| 11 | LOW | `Authorization: Bearer ${getToken()}` sends literal `"Bearer null"` when unauthenticated (inconsistent with ws's `?? ""`) | `api.ts:19` |
| 12 | LOW | `notify()` fires one desktop notification per `session_meta`; a metadata burst (title+preview) double-notifies | `useApp.ts:106-120,380-384` |
| 13 | LOW | `TaskTranscriptDialog` poll uses recursive `setTimeout` with no timer handle; a queued tick fires one extra network fetch after close | `TaskCard.tsx:37-58` |
| 14 | LOW | `WorkdirPicker`/`Settings` async fetches set state with no cancellation guard (benign today; stale-clobber risk if the endpoint varies) | `WorkdirPicker.tsx:32-58`, `Settings.tsx:23-32` |
| 15 | LOW | Unread auto-clear `patchSession` is fire-and-forget; a failed PATCH leaves the row unread server-side | `useApp.ts:117-119` |
| 16 | LOW(sec) | Auth token travels in the WS URL query string (`?token=`) → leaks into server access logs / proxies | `ws.ts:35`, `terminal-ws.ts:18` |

**Verified SAFE (checked, not bugs):** markdown XSS, approval/ws watchdog timer
lifecycle, slash-menu derivation. See the final section.

---

## HIGH

### 1. No catch-up after WebSocket reconnect — most live UI state silently goes stale
**`useApp.ts:224-241` (mount-only fetch), `ws.ts:42-60` (reconnect path)**

The initial WS connect bootstraps state with `refreshSessions()` + `listTasks()`
inside the **mount effect** (`useApp.ts:230-233`). The reconnect path does *not*.
`ws.ts` auto-reconnects with backoff (`onclose` → `setTimeout(open,…)`, lines
56-60) and on `onopen` re-sends only the `subscribe` frame (lines 42-47).
`onStatus(true)` merely flips `wsState` to `"ok"` (`useApp.ts:227`); there is no
effect keyed on `wsState` that refetches.

The server `EventBus` is fire-and-forget with **no replay/buffer**
(`server/src/events.ts:35-52`). So every event emitted during the disconnect
window is gone forever:
- **Transcript**: missed `message_end` for the open session → messages missing
  until the user reselects.
- **Session list**: missed `session_meta` → stale title/preview/unread/order.
- **Tasks**: missed `task` events → `TasksDialog` and the sidebar "Tasks (N)"
  badge wrong.
- **Stuck flags**: missed `agent_end` / `compaction_end` leaves `running:true` /
  `compacting:true` forever (sidebar dot + "compacting…" pill never clear) until
  some *future* event for that session happens to correct it — which for an idle
  session never comes.

Only approvals self-heal, because `subscribe` triggers a server-side
`pending_approvals` snapshot (`server.ts:136-144`) consumed by `onPendingApprovals`.

**Trigger:** laptop sleep/Wi-Fi blip, server restart, or the 5 s connect-watchdog
firing — any reconnect. **Fix:** when `onStatus` transitions `false→true` (or in
`onopen`), refetch `listSessions` + `listTasks` and re-`getSession(currentId)`,
mirroring the mount bootstrap.

### 2. `selectSession` snapshot clobbers a concurrent `message_end` (acknowledged, unguarded)
**`useApp.ts:270-287`**

```ts
setMessages([]);                       // 272
wsRef.current?.subscribe(id);          // 275  → server starts streaming events NOW
const { session, messages } = await client.getSession(id);   // 277 async window
if (currentIdRef.current !== id) return;                     // 279
// note: a message_end arriving during the fetch can be clobbered by this snapshot
setMessages(messages);                 // 282  last-write-wins
```

`subscribe` is issued **before** the transcript fetch (line 275), so WS agent
events for `id` start flowing immediately. A `message_end` arriving in the
`[275, 282]` window is appended by `onEvent` (`useApp.ts:190-192`), then
**overwritten** by the snapshot at line 282 if the server's GET response was
materialized before that message was persisted. The message vanishes from the UI
until the user reselects. The in-code comment (280-281) acknowledges it
("self-heals on reselect; messages have no stable id to merge by").

This is the task's named soft spot; I confirm it is real, is the *common* path
(opening a session that is actively streaming), and is **not** covered by any
executing test (`message-flow.test.mjs` only regex-checks that `send` has no
optimistic echo). Same class affects `streaming`: `setStreaming(null)` at 273 +
an in-window `message_start` re-sets it, then the snapshot path leaves an orphan
or drops it. **Fix direction:** buffer events received during the fetch and
replay-after-merge, or carry a stable per-message id from the server so the
snapshot can union instead of replace.

---

## MEDIUM

### 3. Composer draft leaks across session switches → can send to the wrong session
**`Chat.tsx:66` (`const [draft,setDraft]=useState("")`), `Chat.tsx:106-111` (`submit`), `App.tsx:132` (single un-keyed `<Chat>`)**

`<Chat>` is rendered once, **not** keyed by `sessionId`, and `draft` has no reset
effect on `sessionId` change. Switching sessions (`selectSession` updates
`currentId`) keeps the same Chat instance and the same composer text. `submit()`
→ `onSend(text)` → `send()` resolves the target from `currentIdRef.current`
(`useApp.ts:334`), i.e. the **new** session. So: type a half-message in session
A, click session B in the sidebar, press Send → A's text is delivered to B.
`cwdEditorOpen`, `transcriptTaskId`, and the slash overlay state likewise persist
across the switch. **Fix:** `key={sessionId}` on `<Chat>` (cleanest), or an
effect that clears `draft`/editor state when `sessionId` changes.

### 4. Index-keyed message list leaks per-row component state
**`Chat.tsx:151-155` (`key={i}`), `Message.tsx:195` (`ToolCallCard` `useState(open)`), `Message.tsx:227` (`memo`)**

Messages are keyed by array index. `selectSession` swaps the entire `messages`
array for a different session (`setMessages(snapshot)`), so index `i` now maps to
a completely different message while React **reuses the component instance** at
that key/position. Consequences:
- A `ToolCallCard` expanded (`open=true`) at index 3 in session A stays expanded
  at index 3 in session B, now showing a *different* tool call's JSON.
- `MessageHoverCluster`'s transient `copied` check-mark (`Message.tsx:125`) and
  the error-boundary state (finding 5) leak the same way.

Append-only steady state is fine; the breakage is on session switch (and any
future insert/reorder). **Fix:** derive a stable key (timestamp+role+index, or a
server id) instead of bare array index.

### 5. `MessageErrorBoundary` never resets — sticky fallback mis-attributes to good messages
**`MessageErrorBoundary.tsx:26-59`, used `Chat.tsx:152` with `key={i}`**

The boundary sets `error` in `getDerivedStateFromError` (28-31) but has **no**
`componentDidUpdate`/`getDerivedStateFromProps` to clear it when `props.message`
changes. Because it is keyed by **index**, the instance persists across list
changes. So once a malformed message throws at index 5, the boundary at index 5
renders "Could not render this message" **permanently** — and after the array
shifts/swaps (session switch, snapshot reload), a perfectly valid message that
lands on index 5 still shows the error fallback. The fallback even prints the
*new* message's role (43), actively mis-attributing the failure. **Fix:** reset
`error` to null when the guarded message identity changes (or remount via a
stable per-message key).

### 6. WS frames parsed & routed with no try/catch
**`ws.ts:48-55`, `useApp.ts:177-200`, `terminal-ws.ts:27-34`**

```ts
ws.onmessage = (e) => {
  const msg = JSON.parse(String(e.data));   // throws on non-JSON → uncaught
  if (msg.type === "pending_approvals") {…}
  handlers.onEvent(msg);                     // throws if shape is off
};
```
Two unguarded hazards: (a) a non-JSON frame throws in `JSON.parse`; (b) `onEvent`
dereferences `event.event.type` / `const e = event.event` for any frame that
reaches line 177 (`useApp.ts:177-200`) — a malformed `agent` frame missing
`.event` throws `TypeError`. Either throws out of `onmessage`; the frame is
dropped and an uncaught error logs. The socket survives, but the event is lost
(and if it was a `message_end`, that's silent transcript loss). Note the
**server's** own `onMessage` *does* wrap parsing in try/catch
(`server.ts:131-152`); the client should be equally defensive. **Fix:** wrap
parse+dispatch in try/catch and drop unrecognized frames.

### 7. Approval response silently dropped while reconnecting; card latches "responded"
**`ws.ts:81-85`, `useApp.ts:341-346`, `ApprovalCard.tsx:30-34`**

`respondToApproval` only sends if `ws.readyState === OPEN`, else it's a no-op
(`ws.ts:82`). `ApprovalCard.handleClick` optimistically `setResponded(decision)`
(34) and disables both buttons (`60,69`). The card's `disabled` guard derives
from `wsState` (`Chat.tsx:165`), but `wsState` lags the actual socket close (it
only flips on `onclose`). So a click in the window between socket-drop and
`onclose` (or any time `wsState` is stale-"ok"): the card shows "responded", the
server never received it, the approval stays pending, and the card —
keyed by `approvalId` (`Chat.tsx:163`), so the instance and its latched
`responded` survive — stays disabled. The user **cannot retry** until the
watchdog moves it to "lost" after `APPROVAL_TTL_MS + WATCHDOG_GRACE_MS` = 5.5 min
(`approvalWatchdog.ts:1-7`). **Fix:** only latch `responded` after a confirmed
send (return a boolean from `respondToApproval`), or clear `responded` if the
approval is still present after a short timeout.

### 8. Invalid working-dir on new-session is swallowed; session opens in default dir, no feedback
**`useApp.ts:289-309` (`newSession`), `useApp.ts:324-330` (`confirmNewSession`)**

```ts
const confirmNewSession = async (cwd) => {
  setWorkdirPickerOpen(false);            // dialog closed immediately
  await newSession(model, cwd);
};
// newSession:
try { const res = await client.setSessionCwd(session.id, cwd); … }
catch { await selectSession(session.id); }   // 300-302: invalid cwd swallowed
```
`POST /cwd` returns 400 with an `{error}` body for a bad path
(server validates), but here the catch just opens the session with the **default**
cwd and the picker is already closed, so the user gets no error and silently
lands in the wrong directory — their tool calls then run somewhere unexpected.
Note the *editor* path (`CwdEditorDialog`, `Chat.tsx:336-372`) correctly surfaces
the 400 inline; only the picker path drops it. **Fix:** keep the picker open and
surface the server error on failure, mirroring `CwdEditorDialog`.

### 9. A single background 401 nukes the token and hard-reloads the app
**`api.ts:23-27`, fired by the LTM poll `useApp.ts:243-268`**

`api()` treats **any** 401 as fatal: `setToken(null); window.location.reload()`.
This runs for *every* request, including the unattended `getMemoryHealth` poll
that fires every 10 s (`LTM_POLL_MS`, `useApp.ts:19,247,263`). A transient or
misrouted 401 (proxy hiccup, server restart returning 401 briefly,
reverse-proxy auth edge) on that background poll destroys a valid session token
and bounces the user to Login mid-work, discarding the in-memory transcript.
Several mount requests can also 401 concurrently and each call `reload()`.
**Fix:** scope the auto-logout to user-initiated/auth-critical calls, or require
two consecutive 401s, and avoid letting a health poll be able to log the user out.

---

## LOW

### 10. `pending_approvals` empty-seed causes reconnect flicker + timer churn
**`useApp.ts:203-222`; server seeds `{approvals:[]}` on every `onOpen` (`server.ts:124-129`)**

The server unconditionally sends an empty `pending_approvals` on socket open,
then the real filtered list after `subscribe`. `onPendingApprovals` does a full
replace: the empty seed clears all pending approvals and `clearApprovalTimer`s
every timer (206-208), then the real list restores+re-arms them. Net state is
correct, but on each reconnect approvals briefly disappear from the UI and their
watchdog timers are torn down and rebuilt. If the post-subscribe list frame were
ever lost, approvals would stay empty. **Fix:** ignore an empty seed when local
state is non-empty, or reconcile (merge) instead of replace.

### 11. `"Bearer null"` sent when unauthenticated
**`api.ts:19`** — `Authorization: \`Bearer ${getToken()}\`` interpolates `null`
to the string `"Bearer null"`, unlike `ws.ts:35` which uses `getToken() ?? ""`.
Harmless (server 401s either way) but inconsistent and confusing in logs.

### 12. Desktop-notification spam on metadata bursts
**`useApp.ts:106-120,380-384`** — every `session_meta` with `unread && id≠current`
calls `notify()`. The server can emit multiple `session_meta` for one logical
update (e.g. preview then title), producing multiple OS notifications. Minor.

### 13. `TaskTranscriptDialog` poll leaks one trailing fetch after close
**`TaskCard.tsx:37-58`** — recursive `setTimeout(poll, 2000)` with no stored
timer id; cleanup sets `stop=true` (a flag checked only *after* the `await`).
A tick already queued at close-time still invokes `poll()` → fires one more
`getTaskTranscript` network request before the `if (stop) return` short-circuits.
No setState-after-unmount (guarded), just a wasted request. Store and
`clearTimeout` the handle.

### 14. Unguarded async→setState in WorkdirPicker / Settings
**`WorkdirPicker.tsx:32-58`, `Settings.tsx:23-32`** — `.then(setX)` with no
`cancelled` latch (unlike `Chat.tsx:71-84`, `Sidebar.tsx:51-63`, LTM poll). These
components stay mounted (only the Radix Dialog toggles), so no unmount warning,
and the endpoints are idempotent, so today it's benign. But open→close→open fast
and a stale first response can clobber the second open's reset. Add a guard for
robustness.

### 15. Unread auto-clear PATCH is fire-and-forget
**`useApp.ts:117-119`** — `void client.patchSession(id,{unread:false})` with no
error handling. On failure the row stays unread server-side while the local list
shows it read; diverges until the next `session_meta`.

### 16. Auth token in WS URL query string
**`ws.ts:35`, `terminal-ws.ts:18`** — `?token=<authToken>` is the only option for
browser WS (can't set headers), but it lands in server access logs, proxy logs,
and process listings. Acceptable for a localhost single-user app; worth a note.
The REST side correctly uses the `Authorization` header.

---

## Verified SAFE (checked — do not file)

- **Markdown XSS** (`Message.tsx:262-267`): `react-markdown@^10` (package.json:27)
  with only `remark-gfm`, **no `rehype-raw`** (confirmed: zero `dangerouslySetInnerHTML`
  / `rehype` matches in `web/src`). v10 escapes raw HTML and sanitizes URLs
  (`javascript:` stripped) by default, so untrusted model/tool output rendered as
  markdown cannot inject HTML or script. `ToolCallCard`/`ApprovalCard` render
  params via `JSON.stringify` into `<pre>` (text), also safe.
- **Approval watchdog lifecycle** (`useApp.ts:50-99,164-167,237-240`): timers are
  cleared on resolve (`approval_resolved`→`clearApprovalTimer`), on snapshot
  divergence (`onPendingApprovals`), and on unmount (`clearAllApprovalTimers` in
  the effect cleanup). Re-arm is safe (`armApprovalWatchdog` clears first). The
  fire callback guards on `pendingApprovalsRef.current[id]` before acting. No
  double-clear, no fire-after-unmount.
- **WS connect-watchdog** (`ws.ts:36-60`): cleared in **both** `onopen` and
  `onclose`, and the timer body re-checks `readyState === CONNECTING` before
  `close()`. Correct (matches `ws-watchdog.test.mjs`).
- **Slash menu** (`slashMenu.ts`, `useSlashMenu.ts`): pure derivation; `activeIndex`
  is clamped when items shrink (`useSlashMenu.ts:30-38`); name-prefix ranks above
  trigger-substring; whitespace closes. Correct.
- **Health tri-state** (`useApp.ts:249-257`, `HealthIcon.tsx:5-9`, `App.tsx:80-91`):
  `null→unknown`, `!reachable || failures≥3 → bad`, else `ok`; color/title maps
  consistent. Correct.
- **Sidebar rename re-entry** (`Sidebar.tsx:47,85-98`): `committingRef` latch
  correctly dedupes the Enter+blur double-fire.

---

## Notes on test coverage (so the parent can weight the above)

Executing tests: `slash-menu`, `approval-prefix`, `time`, and the
`watchdogDelayMs` math + a **local-harness re-implementation** of the approval
reducer (`approval-watchdog.test.mjs:39-88` — not the real `useApp`). Everything
else (`message-flow`, `health-status`, `ws-watchdog`, `compaction-pill`,
`approval-card`, `chat-slash`, …) is `readFileSync` + `assert.match` against
source text. Therefore findings **1, 2, 3, 4, 5, 6, 7** live entirely in code
paths that **no executing test touches**; the suite would stay green through any
of these regressions.
