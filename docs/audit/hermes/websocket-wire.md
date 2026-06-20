# ytsejam — WebSocket Wire-Format & Client/Server Contract Audit

**Scope:** correctness bugs across the server↔browser WebSocket boundary —
`ServerEvent` union drift, inbound/outbound handler logic, terminal WS contract,
serialization hazards, WS auth, and event-ordering guarantees.
**Method:** hand-diff of the two `ServerEvent` definitions plus read-through of every
emit site, both WS upgrade handlers, both client transports, the pi-agent-core/pi-ai
source types, and the WS/compaction/terminal tests. **Read-only. No files modified.**

Authoritative server union: `server/src/events.ts:6-33` (imports `AgentEvent` from
`@earendil-works/pi-agent-core`).
Hand-mirrored browser union: `web/src/lib/types.ts:124-135`.

---

## Ranked summary

| # | Sev | Title | Primary ref |
|---|-----|-------|-------------|
| 1 | HIGH | `agent` variant is not really mirrored — web types `event` as a loose stub and the server emits `as any`; the primary data path has **zero** compile-time contract on either side | events.ts:7 / types.ts:125 / manager.ts:462-466 |
| 2 | HIGH | `session_meta.session` ships the server-only absolute filesystem `path` to the browser; web `SessionRow` omits `path` and weakens `archived` to optional | indexer.ts:7-17 / manager.ts:1231-1238 / types.ts:24-37 |
| 3 | MEDIUM | LIGHTWEIGHT filter broadcasts `agent_end` to **all** sockets, and `agent_end` carries the full `messages[]` turn transcript → every client receives transcripts of sessions it isn't subscribed to | server.ts:72,78 / pi types.d.ts:357-358 |
| 4 | MEDIUM | Client `JSON.parse` has no try/catch (`ws.ts`, `terminal-ws.ts`); a malformed frame throws uncaught in `onmessage`. Unknown future event types crash `onEvent`'s agent fall-through | ws.ts:48-55 / terminal-ws.ts:27-34 / useApp.ts:176-187 |
| 5 | MEDIUM | `ChatMessage`/`ContentBlock` mirror lacks image fields (`data`,`mimeType`); pi-ai `ImageContent` blocks are unrenderable. `agent_end.messages` (plural) vs web `message?` (singular) | types.ts:59-78 / Message.tsx:262-292 / pi-ai types.d.ts:165-169 |
| 6 | LOW | `pending_approvals` is a side-band frame in **neither** union; routing depends on an early `return` in `ws.ts`. Remove/reorder it and the frame crashes `onEvent` | ws.ts:50-54 / server.ts:124-144 |
| 7 | LOW | WS auth token in URL query string (`?token=`) on both routes → proxy/access logs + browser history; non-constant-time compare. (4401 path & PUBLIC_API_PATHS are correct) | server.ts:37,107,162 |
| 8 | LOW | Compaction ordering: retry-exhaust surrender emits no `compaction_end`; a client connecting mid-compaction never sees `compaction_start` (relies on `listSessions` `compacting` seed) | manager.ts:1200-1226 / compaction-events.test.ts:71-139 |
| 9 | LOW | `subscribe` accepts any string `sessionId` with no existence check (harmless single-user, but unvalidated) | server.ts:134-145 |
| 10 | LOW | Empty `pending_approvals` on open wipes client approval state, then relies on the client re-sending `subscribe` to re-seed | server.ts:124-129 / useApp.ts:203-222 |

No **missing variants** and no **extra variants**: both unions enumerate the same 11
`type`s. All drift is **inside** two variants (`agent`, `session_meta`) plus the
shared row/message shapes. `task`, `schedule`, `approval_*`, `compaction_*`,
`session_archived/unarchived` are field-for-field identical.

---

## ServerEvent union diff — variant by variant

Legend: **server** = `server/src/events.ts` (+ the imported row/`AgentEvent` types it
resolves to); **web** = `web/src/lib/types.ts` (+ its local `SessionRow`/`ChatMessage`/
`TaskRow`/`ScheduleRow`).

| Variant | Server fields (authoritative) | Web fields (mirror) | Divergence |
|---|---|---|---|
| `agent` | `sessionId: string`, `event: AgentEvent` (full 10-member discriminated union: `agent_start` / `agent_end{messages: AgentMessage[]}` / `turn_start` / `turn_end{message,toolResults}` / `message_start{message}` / `message_update{message,assistantMessageEvent}` / `message_end{message}` / `tool_execution_start|update|end{toolCallId,toolName,args,…}`) | `sessionId: string`, `event: { type: string; message?: ChatMessage; [k: string]: unknown }` | **MAJOR.** Web does not mirror `AgentEvent` at all — it's an open structural stub (effectively `any` past `type`/`message`). `message?` is singular; `agent_end` carries `messages[]` (plural). `assistantMessageEvent`, `toolCallId`, `args`, `result`, `isError`, `toolResults` are entirely unmodeled. Server emit also casts `event as any` (manager.ts:465) so **neither side** enforces the shape. |
| `session_meta` | `session: SessionRow & { running: boolean; compacting: boolean }` where `SessionRow` (`indexer.ts:7-17`) = `id, path, title, createdAt, updatedAt, preview, unread, archived, approvalMode` | `session: SessionRow` (`types.ts:24-37`) = `id, title, createdAt, updatedAt, preview, unread, archived?, running, compacting?, approvalMode, cwd?` | **MAJOR.** Server sends **`path`** (absolute server FS path to the JSONL session file) — **absent from web type**. `archived` required on server, `archived?` optional on web. `running` always sent (ok). `compacting` always sent on server (required), `compacting?` optional on web (ok). `cwd?` exists only on web and is **never** present in `session_meta` (it's the GET-session field). |
| `session_archived` | `sessionId: string` | `sessionId: string` | none |
| `session_unarchived` | `sessionId: string` | `sessionId: string` | none |
| `task` | `task: TaskRow` (`tasks.ts:7-18`) | `task: TaskRow` (`types.ts:82-93`) | none — field-for-field identical incl. `TaskStatus` union |
| `schedule` | `schedule: ScheduleRow` (`schedules.ts:8-21`) | `schedule: ScheduleRow` (`types.ts:110-122`) | none — identical incl. `ScheduleSpec` |
| `compaction_start` | `sessionId: string`, `trigger: "proactive"\|"reactive"` | same | none |
| `compaction_end` | `sessionId: string`, `status: "succeeded"\|"surrendered"\|"failed"` | same | none |
| `approval_request` | `approvalId, createdAt: number, sessionId, toolName, toolLabel, params: unknown` | same | none |
| `approval_resolved` | `approvalId`, `decision: "approve"\|"deny"\|"timeout"` | `approvalId`, `decision: ApprovalDecision` (= same 3) | none |
| `approval_mode_changed` | `sessionId`, `mode: "yolo"\|"ask"` | `sessionId`, `mode: ApprovalMode` (= same) | none |
| `pending_approvals` *(side-band, NOT in either union)* | server.ts:124-128, 140-143 emits `{ type:"pending_approvals", approvals: ApprovalRequest[] }` | modeled separately as `PendingApprovalsSnapshot` (`types.ts:19-22`), routed in `ws.ts:50-54` before `onEvent` | present in code, absent from both `ServerEvent` unions — see Finding 6 |

### Embedded shape diff — `message` payload (`ChatMessage` vs pi-ai `Message`)

The `message`/`messages` field inside agent events is serialized from pi-ai
`UserMessage|AssistantMessage|ToolResultMessage` and parsed on the web as `ChatMessage`
(`types.ts:68-78`) with `ContentBlock[]` (`types.ts:59-66`).

| Source block (pi-ai `types.d.ts`) | Web `ContentBlock` | Divergence |
|---|---|---|
| `TextContent{type:"text",text,textSignature?}` | `{type,text?}` | ok (signature dropped, harmless) |
| `ThinkingContent{type:"thinking",thinking,thinkingSignature?,redacted?}` | `{type,thinking?}` | ok |
| `ToolCall{type:"toolCall",id,name,arguments:Record,thoughtSignature?}` | `{type,id?,name?,arguments?}` | ok |
| `ImageContent{type:"image",data,mimeType}` | **no `data`/`mimeType` fields** | **DRIFT** — image blocks can't be represented; `Message.tsx:262-292` has no `image` case → renders `null` (silently dropped). See Finding 5 |

---

## Findings (detail)

### 1. HIGH — The `agent` variant is a stub, not a mirror; both sides drop type safety on the primary data path
**Refs:** `server/src/events.ts:7`, `web/src/lib/types.ts:125`, `server/src/manager.ts:461-466`, pi `dist/types.d.ts:354-392`

The server union declares `event: AgentEvent` — the full 10-member discriminated union.
The web mirror declares:
```ts
| { type: "agent"; sessionId: string; event: { type: string; message?: ChatMessage; [k: string]: unknown } }
```
This is an **open structural type**: past `type` and an optional singular `message`,
every field is `unknown`. So the highest-traffic frame (token streaming, tool calls,
turn boundaries) has **no compile-time contract** on the browser. Worse, the server's
emit site casts the payload to `any`:
```ts
this.opts.bus.emit({ type: "agent", sessionId: opened.id, event: event as any });   // manager.ts:462-466
```
so the authoritative `event: AgentEvent` annotation is also defeated at the only place
it matters.

**Trigger / impact:** if pi-agent-core renames or reshapes a field the UI reads —
`useApp.ts:188-200` reads `e.message` for `message_start/update/end` and
`event.event.type` for `agent_start/agent_end` — **neither `tsc` build catches it**.
The transcript silently breaks (blank/stale messages) with a green build on both sides.
This is precisely the "hand-maintained twins drift apart" failure mode the audit targets,
and for this variant the mirror has already given up.

Note also a latent mismatch: `agent_end` carries `messages: AgentMessage[]` (plural
array, pi `types.d.ts:357-358`); the web stub models `message?` (singular). Harmless
today only because `useApp.ts:193-199` ignores the payload for `agent_end`.

**Fix:** export the real `AgentEvent`/`AgentMessage` types to the web package (shared
types package or generated `.d.ts`) and type `event: AgentEvent`; drop the `as any` at
the emit site (cast to `AgentEvent` and let `FORWARDED_EVENTS` gate at runtime). At
minimum, replace the open `[k: string]: unknown` stub with a discriminated mirror of the
fields the UI actually reads.

---

### 2. HIGH — `session_meta` serializes the absolute server filesystem `path` to the browser; the web type denies the field exists
**Refs:** `server/src/indexer.ts:7-17,365-377`, `server/src/manager.ts:1228-1239` (`emitMeta`), `server/src/events.ts:8`, `web/src/lib/types.ts:24-37`

`emitMeta` spreads the indexer `SessionRow` straight onto the event:
```ts
this.opts.bus.emit({ type: "session_meta",
  session: { ...row, running: this.isRunning(id), compacting: this.isCompacting(id) } });
```
`row.path` is `JsonlSessionMetadata.path` (pi `harness/types.d.ts:307-309`) — the
**absolute path of the session's JSONL file on the server host** (e.g.
`/home/<user>/.../chat/<id>.jsonl`, populated at `manager.ts:230`). The authoritative
`events.ts` type includes it (via the imported `SessionRow`), so it is genuinely on the
wire on **every** metadata update (rename, run start/stop, compaction start/end, model
change, unread flip). The web mirror's `SessionRow` (`types.ts:24-37`) **omits `path`
entirely**.

**Trigger / impact:** every `session_meta` frame discloses server data-dir layout to the
browser (and thus to devtools, any reverse proxy access log, and browser history if it
were ever URL-bound). It's the user's own bearer-gated browser, so not a cross-tenant
breach — but it's unnecessary host-path disclosure and a concrete schema divergence: the
UI compiles against a type that lies about the wire. A future web feature that does
`Object.entries(session)` or logs the row would surface the path.

Secondary drift in the same variant: `archived` is **required** on the server row but
`archived?` **optional** on web; `cwd?` exists only on web and is never carried by this
event (the web `SessionRow` is overloaded to also describe the GET `/api/sessions/:id`
body — two different payloads sharing one type, which is itself a drift hazard).

**Fix:** strip `path` in `emitMeta` (project the row to the public fields) — the browser
never uses it. Then reconcile `archived` required/optional and split the GET-session
shape (`cwd`) from the `session_meta` shape so the mirror matches the wire exactly.

---

### 3. MEDIUM — LIGHTWEIGHT broadcast leaks full turn transcripts: `agent_end` is global but carries `messages: AgentMessage[]`
**Refs:** `server/src/server.ts:72,74-79` (`LIGHTWEIGHT`, `shouldSendWsEvent`), pi `types.d.ts:356-358`, `server/test/ws.test.ts:326-343`

```ts
const LIGHTWEIGHT = new Set(["agent_start", "agent_end"]);
...
if (event.type !== "agent") return true;
return event.sessionId === subscribed || LIGHTWEIGHT.has(event.event.type);
```
The intent (per the comment) is "events every client gets regardless of subscription
(sidebar liveness)". But `agent_end`'s payload is **not** lightweight — pi defines
`agent_end` as `{ type:"agent_end"; messages: AgentMessage[] }`, the entire turn's
message array (assistant text, thinking, tool calls/results). Because `agent_end` is in
LIGHTWEIGHT, **every connected socket receives the full transcript of every session,
including sessions it is not subscribed to.**

**Trigger / impact:** open the app on session A; whenever session B (a scheduled task, a
background autonomous run, another browser tab) finishes a turn, socket A receives B's
complete `messages[]`. Single-user today so it's not a cross-user leak, but it is: (a)
data exposure beyond the filter's stated "liveness only" contract; (b) wasted bandwidth
(potentially large arrays pushed to idle tabs); (c) a latent privacy bug the moment this
ever runs multi-user or shares a socket across contexts. The UI doesn't even use the
payload — `useApp.ts:178-184,193-199` only reads `e.type` to flip the running pill.
`ws.test.ts:337-339` pins that unsubscribed sockets get `agent_start`/`agent_end` types
but never asserts the payload is stripped.

**Fix:** when broadcasting an `agent_end` to a non-subscribed client, forward a
liveness-only projection (`{ type:"agent", sessionId, event:{ type:"agent_end" } }`)
and drop `messages`. Or introduce a dedicated lightweight running-state event
(`{type:"session_running", sessionId, running}`) and stop overloading `agent_end` for
the sidebar.

---

### 4. MEDIUM — Client inbound frames are parsed without try/catch; malformed or unknown frames throw/crash in the handler
**Refs:** `web/src/lib/ws.ts:48-55`, `web/src/lib/terminal-ws.ts:27-34`, `web/src/useApp.ts:176-187`

```ts
ws.onmessage = (e) => {
  const msg = JSON.parse(String(e.data));   // ws.ts:49 — no try/catch
  if (msg.type === "pending_approvals") { handlers.onPendingApprovals?.(msg); return; }
  handlers.onEvent(msg);
};
```
Two distinct hazards:
- **Malformed JSON** (non-JSON control text, a proxy-injected frame, a truncated frame)
  makes `JSON.parse` throw **uncaught inside `onmessage`**. The throw doesn't close the
  socket (so it's not fatal), but the frame is lost with only a console error. Note the
  asymmetry: the **server** hardens its inbound path with try/catch (`server.ts:132-152`,
  `186-199`); the **client** does not. `terminal-ws.ts:28` has the identical unguarded
  `JSON.parse`.
- **Unknown event `type`.** `useApp.ts`'s `onEvent` handles the 10 known variants, then
  *falls through* assuming an agent event: `if (event.sessionId !== currentIdRef.current)
  { if (event.event.type === ...) }` (lines 176-178). Any future/extra `ServerEvent`
  `type` the web doesn't recognize lands here and dereferences `event.event.type` on an
  object with no `event` field → `TypeError`, thrown through `onmessage`. So adding a new
  server variant without updating the web switch crashes on that frame.

**Fix:** wrap the parse + dispatch in try/catch in both `ws.ts` and `terminal-ws.ts`
(log and drop). In `useApp.ts`, gate the agent fall-through on `event.type === "agent"`
explicitly and ignore unknown types, rather than treating "not one of the known types"
as "must be agent".

---

### 5. MEDIUM/LOW — `ChatMessage`/`ContentBlock` mirror can't represent image content; `agent_end.messages` plural/singular drift
**Refs:** `web/src/lib/types.ts:59-78`, `web/src/components/Message.tsx:262-292`, pi-ai `types.d.ts:151-169,192-219`

`ContentBlock` (`types.ts:59-66`) models `text`, `thinking`, `id`, `name`, `arguments`
but has **no `data`/`mimeType`** fields. pi-ai's `ImageContent` is
`{ type:"image"; data: string; mimeType: string }` and is a legal member of
`UserMessage.content` and tool-result content. `Message.tsx:262-292` renders `text`,
`thinking`, and `toolCall` blocks and `return null` for anything else — so an image
block on the wire is **silently dropped** (no compile error because `ContentBlock.type`
is the open `string`). If/when an assistant or tool emits an image, it vanishes from the
transcript.

Also: the web `ChatMessage.timestamp?` is optional but pi-ai messages always set
`timestamp: number` (harmless — superset). `role: string` is intentionally loose to
accommodate pi's synthetic `compactionSummary`/`bashExecution`/`branchSummary` roles,
which `Message.tsx:24-52` handles via casts — acceptable but another place the mirror
relies on runtime casts instead of the type.

**Fix:** add `data?: string; mimeType?: string` to `ContentBlock` and an `image` render
case in `Message.tsx` (or explicitly document that images are unsupported and assert it).
Align `message`/`messages` naming with the real `AgentEvent` (Finding 1).

---

### 6. LOW — `pending_approvals` lives in neither union; correct routing depends on an easily-broken early return
**Refs:** `web/src/lib/ws.ts:50-54`, `server/src/server.ts:124-128,140-143`, `web/src/useApp.ts:203-222`

`pending_approvals` is emitted by the server (on open and on subscribe) and consumed by
the web, but it is **not** a member of `ServerEvent` in either `events.ts` or `types.ts`
— it's modeled only as the standalone `PendingApprovalsSnapshot` interface. The web
relies on intercepting it *before* the generic dispatch:
```ts
if (msg.type === "pending_approvals") { handlers.onPendingApprovals?.(msg); return; }
handlers.onEvent(msg);
```
If that early `return` is ever removed or the snapshot reordered after `onEvent`, the
frame falls into `useApp.ts`'s agent fall-through (Finding 4) and throws on
`event.event.type`. The contract is correct today but undocumented in the type system and
fragile.

**Fix:** either add `pending_approvals` as a first-class `ServerEvent` variant (and handle
it in `onEvent`), or co-locate a comment/test pinning the "must intercept before onEvent"
invariant. A `web/test` assertion that an unknown `type` is ignored (not treated as agent)
would also catch regressions.

---

### 7. LOW — WS token in query string; non-constant-time compare (4401 / PUBLIC_API_PATHS are correct)
**Refs:** `server/src/server.ts:37,96-102,107-111,162-166`, `web/src/lib/ws.ts:35`, `web/src/lib/terminal-ws.ts:18`

Both WS routes authenticate via `?token=<authToken>` because the browser can't set
`Authorization` on a WS handshake; `PUBLIC_API_PATHS` (`/api/login`, `/api/ws`,
`/api/terminal/ws`) correctly exempts them from the bearer middleware (`server.ts:96-97`),
and each route does its own in-handler check, closing with **4401** before subscribing the
bus / spawning a PTY on mismatch (`server.ts:107-111,162-166`; pinned by
`ws.test.ts:80-96` and `terminal.test.ts`). That part is sound.

Residual low-severity notes: (a) the token rides in the URL, so it can surface in reverse-
proxy/access logs and browser history — inherent to browser WS, but the same token also
gates the full PTY shell (`terminal.md` flags this blast radius), so the standard "don't
log it / scope it" caveat applies. (b) The compare is a plain `!==` (`server.ts:100,107,
162`), not constant-time — negligible for a localhost single-user app but noted for
completeness.

**Fix:** none required for the threat model; if hardening, prefer a short-lived
subprotocol token or a `Sec-WebSocket-Protocol`-carried credential and constant-time
compare, and ensure proxies don't log query strings.

---

### 8. LOW — Compaction event ordering the UI can't fully rely on (documented design gaps)
**Refs:** `server/src/manager.ts:1200-1226` (`markCompactionStart/End`), `manager.ts:531-570,626-655,685-724`, `server/test/compaction-events.test.ts:71-139`, `docs/agents/observability.md:43-53`

`markCompactionStart`/`End` are paired inside `try/finally` on all three normal
compaction paths, so a started compaction always emits its `compaction_end`. Two ordering
realities the UI leans on but the bus doesn't guarantee:
- **Surrender emits no `compaction_end`.** The reactive retry-exhaust surrender path calls
  `emitCompactionSurrender` directly, outside any `runCompactionIfPending`, so it produces
  only an assistant diagnostic message — no `compaction_end{surrendered}`
  (`compaction-events.test.ts:71-139` pins this as a known gap). It does *not* strand the
  pill (no unpaired `compaction_start` is emitted on that branch, and the prior successful
  compaction already cleared `compacting`), so the practical impact is only that the
  surrender isn't surfaced as a compaction-lifecycle event.
- **No replay on (re)connect.** A client that connects *after* `compaction_start` never
  receives it. There is no per-session catch-up for compaction state on
  subscribe/open (only `pending_approvals` is seeded). The `compacting` flag is recovered
  only via the eventual `compaction_end` → `session_meta`, or via the initial
  `listSessions` fetch (`server.ts:209-218` maps `compacting: isCompacting`), which
  `useApp` runs once on mount. On a pure WS reconnect without a list refresh, a session
  could briefly show a stale (or missing) compacting pill until the next `session_meta`.

**Fix (optional):** seed compaction state on subscribe (mirror the `pending_approvals`
catch-up), and/or emit a synthetic `compaction_end` on surrender so the lifecycle is
always paired.

---

### 9. LOW — `subscribe` accepts an unvalidated, possibly-nonexistent `sessionId`
**Refs:** `server/src/server.ts:134-145`

```ts
if (msg.type === "subscribe" && typeof msg.sessionId === "string") { subscribed = msg.sessionId; ... }
```
Only the *type* is checked, not existence. A client may subscribe to any string; it then
receives agent frames scoped to that id (none, if it doesn't exist) and an empty filtered
approval snapshot. No security boundary is crossed in a single-user app, but the input is
unvalidated and the handler will happily hold an arbitrary `subscribed` value.

**Fix:** optionally `indexer.getSession(id)`-gate the subscribe and ignore unknown ids
(or document that subscribe is intentionally permissive).

---

### 10. LOW — Empty `pending_approvals` on open wipes client state and depends on client re-subscribe to restore it
**Refs:** `server/src/server.ts:121-129`, `web/src/useApp.ts:203-222`, `web/src/lib/ws.ts:42-47`

On every (re)connect the server sends `{ type:"pending_approvals", approvals: [] }` before
it knows the subscribed session. `onPendingApprovals` (`useApp.ts:203-222`) does a
**wholesale replace** to `{}` and clears all watchdog timers, then the real per-session
snapshot is sent only after the client replays `subscribe` (`ws.ts:46`, guarded by
`if (subscribed)`). Net effect converges, but: (a) there's a brief window where a focused
session's pending-approval dialog flickers (cleared → re-seeded); (b) if **no** session is
focused at reconnect (`subscribed === null`), no `subscribe` is sent, so approvals stay
wiped until the user selects a session (acceptable, since approvals are session-scoped).
The behavior is pinned by `ws.test.ts:117-139,223-248`.

**Fix:** none strictly required; if smoothing the flicker, defer the wipe until the
replacement snapshot arrives, or seed the real snapshot on open using the last-known
`subscribed` echoed by the client.

---

## Terminal WS contract — verified clean
**Refs:** `server/src/server.ts:159-207`, `server/src/terminal.ts`, `web/src/lib/terminal-ws.ts`, `docs/agents/terminal.md:56-62`

Field-by-field agreement on every frame:

| Direction | Frame | Server | Client | Match |
|---|---|---|---|---|
| server→client | output | `{type:"output", data:string}` (server.ts:174) | checks `type==="output" && typeof data==="string"` (terminal-ws.ts:29) | ✓ |
| server→client | exit | `{type:"exit", code:number}` then `ws.close()` (server.ts:178-179) | `type==="exit"` → `typeof code==="number" ? code : undefined` (terminal-ws.ts:31-32) | ✓ |
| client→server | input | `{type:"input", data:string}` (terminal-ws.ts:4) | server: `type==="input" && typeof data==="string"` → `session.write` (server.ts:188) | ✓ |
| client→server | resize | `{type:"resize", cols:number, rows:number}` (terminal-ws.ts:5) | server: `Number.isFinite(cols)&&Number.isFinite(rows)` → `max(1,floor())` (server.ts:191-195) | ✓ |

Edge cases handled well: resize coerces non-finite/`NaN`/≤0 to a ≥1 floored integer
(`server.ts:195`); `pty.onExit.exitCode` is always a `number` server-side but the client
still defends with `: undefined`; malformed client frames are swallowed
(`server.ts:197-199`); `onClose` kills the PTY (`server.ts:201-204`), and the client
queues sends until open (`terminal-ws.ts:19-25,42-43`). The only minor gap: if the socket
isn't `WS_OPEN` at child exit, the server skips the `exit` frame *and* the explicit close
(`server.ts:177-180`), so the client learns of termination only via the eventual transport
`onclose` (→ `handlers.onClose`), not via `onExit(code)`. Apart from the missing-try/catch
on the client `JSON.parse` (Finding 4), the terminal contract is correct.

---

## Serialization hazards — assessment
**Refs:** `server/src/indexer.ts:334-377`, `server/src/approval/coordinator.ts:52-54`, `server/src/approval/wrap-tool.ts:47-53`, `server/src/index.ts:76-84`

- **No `Date` objects on the wire.** `createdAt`/`updatedAt`/`startedAt`/… are ISO
  **strings** (sqlite `TEXT`, surfaced via `toRow`/`toTaskRow`/`toScheduleRow`); message
  `timestamp` is a **number**; `approval_request.createdAt` is `Date.now()` (number,
  `coordinator.ts:54`). All JSON-safe.
- **No `bigint` reaches the wire.** sqlite columns are `number|bigint` (`SqliteInteger`),
  but every converter coerces with `Number(...)`/`=== 1` before the row leaves the indexer
  (`indexer.ts:341-376`), so `session_meta`/`task`/`schedule` payloads carry plain
  `boolean`/`number`. `JSON.stringify(bigint)` would throw — but nothing emits a raw one.
- **No `Map`/`Set`/circular refs.** `ScheduleSpec` is round-tripped through
  `JSON.stringify/parse` (`indexer.ts:312,339`); messages/usage are plain objects.
- **`params: unknown` (approval_request).** Sourced from the tool's `Static<TParameters>`
  arguments (`wrap-tool.ts:39,52`), i.e. JSON the model produced for the tool call — so
  JSON-origin and serializable in practice. Residual nit: nested `undefined` values are
  silently dropped by `JSON.stringify` (the UI only displays params, so cosmetic). A
  non-JSON-safe custom tool that put a `Date`/`bigint`/function on its params object would
  serialize lossily/throw, but no in-tree tool does.
- **`undefined` top-level fields** are dropped by `JSON.stringify` and re-read as `absent`
  on the web — consistent with the optional fields, no observed mismatch.

Net: the serialization surface is sound; the only sensitive-content issue is the absolute
`path` in `session_meta` (Finding 2), and the only payload-bloat issue is `agent_end.
messages` broadcast width (Finding 3).

---

## Inbound handler validation — assessment
**Refs:** `server/src/server.ts:81-87,131-153`

- `isApprovalResponse` (`server.ts:81-87`) correctly requires `type==="approval_response"`,
  `typeof approvalId==="string"`, and `decision ∈ {approve,deny}` — it rejects
  `decision:"timeout"` (server-internal only) and non-string ids. Pinned by
  `ws.test.ts:299-324` (numeric id, `"timeout"`, and missing-decision all ignored, socket
  stays open). Matches the web sender's `Exclude<ApprovalDecision,"timeout">`
  (`ws.ts:81-84`). ✓
- `subscribe` requires `typeof sessionId === "string"` but not existence (Finding 9).
- `unsubscribe` requires only `type==="unsubscribe"` and nulls `subscribed`. ✓
- All inbound parsing is wrapped in try/catch (`server.ts:132-152`) — malformed client
  frames never crash the socket. (The client lacks the symmetric guard — Finding 4.)
