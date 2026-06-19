# Per-session Approval Mode — Design

**Date:** 2026-06-14
**Branch (intended):** `approval-mode`
**Status:** Approved, ready for write-plan

## Problem

ytsejam has no permission system. `bash` runs arbitrary commands; `write`/`edit`
write anywhere the path resolves; `delegate` spawns subagents with the same
blank-check tool set. The persona text ("be careful with destructive commands")
is the entire safety layer — a vibe, not a gate.

Brian uses top-tier models with a strong prompt and accepts that the judgment
layer is the model. He is not asking for sandboxing or a policy engine. The
specific constraints that drive the design:

1. **No annoying mid-flow prompts.** Per-tool-call approval during routine work
   is a non-starter.
2. **Bedtime planning must keep working.** "Plan a bunch of things and fire
   them off before bed" is a load-bearing routine. Any design that interrupts
   overnight autonomous runs is dead on arrival.
3. **Binary is fine.** Brian explicitly named "ask for everything" or "yolo" as
   the granularity he wants.

## Solution shape

A per-session mode toggle with two states (`YOLO` and `ASK`), defaulting to
YOLO, plus per-turn message-prefix overrides for the moments the default is
wrong.

### Mode

- **YOLO** (default): all tools execute immediately. Behavior identical to
  current ytsejam.
- **ASK**: mutating tools pause the turn, surface an inline approval card in
  the chat, and resume on user response.

### Toggle

- Lives on the session record (`sessions.approval_mode`, default `"yolo"`).
- One-tap control in the chat header for the active session.
- Toggle persists for the session's lifetime; new sessions start YOLO.

### Per-turn overrides

User message prefixes that override the session toggle for that turn only:

- `/yolo` — force YOLO for this turn
- `/careful` — force ASK for this turn

Slash-command completion overlay (PR #133) gets two new entries. The prefix is
stripped from the message before model dispatch.

### Visual indicator

Sessions currently in YOLO mode get a yellow/warning background tint in the
left-rail session list. ASK sessions render with the default background.
Rationale: YOLO is the default state, so flagging it visually (rather than
flagging the careful state) makes "this session can do anything" legible at a
glance. The pattern mirrors brake-warning lights: the indicator is on when the
safety is off.

A live indicator in the active session's header is also required — shape will
be proposed during write-plan (likely a small badge near the existing health
icons).

## Gated vs. ungated tools

### Gated (pause in ASK)

| Tool | Reason |
|---|---|
| `bash` | Can do anything; can't be statically classified. Covers `systemctl --user restart ytsejam` and similar. |
| `write` | Writes to filesystem. |
| `edit` | Writes to filesystem. |
| `delegate` | Spawns subagent with full tool access. |
| `schedule` | Creates time-bomb that fires later. |
| `cancel_schedule` | Destroys a recurring job; killing the wrong cron is silent and bad. |

### Ungated (always run)

| Tool | Reason |
|---|---|
| `read`, `ls`, `grep`, `find` | Read-only filesystem. |
| `web_search`, `web_fetch` | Outbound HTTP, no mutation. |
| `cancel_task` | Brake handle — gating your own brake handle is wrong. |
| All `cog_*` | Memory is internal, low blast radius, Brian uses cog memory constantly. |
| `recall` | Read-only. |

### Special case: `delegate`

The `delegate` call itself is gated in ASK mode. Once approved, the spawned
subagent runs YOLO regardless of the parent session's mode. Rationale: the
whole point of `delegate` is a self-contained brief — approving the brief
effectively pre-approves what its instructions say to do. Per-step gating
inside subagents would make `/careful` planning sessions unusable.

This is an explicit trade. The mitigation is that the approval card for
`delegate` shows the full task brief, so the user can read what they're
unleashing before tapping approve.

## Approval UX

When a gated tool call arrives in ASK mode:

1. Tool execution pauses.
2. An inline card appears in the chat stream (same visual layer as messages),
   showing:
   - Tool name and label
   - Tool parameters (formatted, scrollable if long)
   - Approve / Deny buttons
3. On **Approve**: tool executes, result feeds back into the turn normally.
4. On **Deny**: tool returns a synthetic result `{ content: [{ type: "text",
   text: "User denied this tool call." }] }`. Model decides next move
   (typically: try a different approach or report back).
5. On **5-minute timeout**: same as Deny, but synthetic text reads `"User
   denied this tool call (timeout)."`. Failure mode is "your run stopped," not
   "your run is hung."

No out-of-band notifications. No phone push. The card lives in the chat where
the user is already looking when they care.

## Architecture

### Server-side

**Single gate point.** Wrap the `execute` function of gated tools with a check
that, in ASK mode, emits a pending-approval event over WS and awaits a
resolution before calling through. The wrap happens in `manager.ts` around the
tools-assembly site (line ~211), so every session-bound tool list goes through
it uniformly.

**Pending approvals are in-memory.** A `Map<approvalId, { resolve, timeout }>`
on the AgentManager. They don't survive a server restart. If the service
restarts mid-approval, the in-flight turn is already dead (same property as
any in-flight turn today) — no new failure mode introduced.

**WS protocol additions:**

- Server → client: `approval_request { approvalId, sessionId, toolName,
  toolLabel, params }`
- Client → server: `approval_response { approvalId, decision: "approve" |
  "deny" }`
- Server → client: `approval_resolved { approvalId, decision }` (so all
  connected clients can update their UI when one client decides)

**Schema change:**

- `sessions` table gets `approval_mode TEXT NOT NULL DEFAULT 'yolo'`.
- Migration: additive column with default, no data backfill needed.

### Client-side

**State:**

- Session record carries `approvalMode: "yolo" | "ask"` from server.
- Per-session pending approvals tracked in component state.

**UI surfaces:**

1. **Header toggle** — two-state control near the existing health icons. Tap
   flips the session's mode, server persists.
2. **Approval card** — new message-stream component type. Lives in the same
   list that renders user/assistant messages and tool calls.
3. **Left-rail tint** — Sidebar.tsx session list item gets a conditional
   background class when the session is in YOLO mode.

**Composer prefix handling:**

- On send, check if message starts with `/yolo` or `/careful` followed by
  whitespace.
- If so, strip the prefix and send the message with an `overrideMode` field
  alongside. Server honors the override for that turn only.
- Slash-completion overlay (existing PR #133 infrastructure) gets entries for
  `/yolo` and `/careful`.

### Data flow

```
User sends message
  → Server determines effective mode (override > session toggle)
  → Turn begins
  → Model emits tool call
    → If tool is ungated OR effective mode is YOLO: execute, return result
    → If tool is gated AND effective mode is ASK:
        - Emit approval_request over WS
        - Create pending approval entry with 5-min timeout
        - await Promise
        - On client response or timeout: resolve with decision
        - If approved: execute, return real result
        - If denied: return synthetic denial result
  → Model continues turn with result
  → ... (loop)
  → Turn ends
```

## Error handling

- **Client disconnects mid-approval**: timeout fires, synthetic denial. If
  client reconnects, server pushes current `approval_resolved` state so any
  stale card can be cleared. The web client also runs a dropped-resolve watchdog:
  if a pending approval reaches 5 minutes plus 30 seconds of grace without a
  resolution event, it clears the card and shows a retry notice.
- **Multiple clients connected**: any client's approve/deny resolves the
  approval. Others receive `approval_resolved` and dismiss their card.
- **Mode toggled mid-turn**: turn keeps the mode it started with. New mode
  applies to next turn. (Avoids race where you flip to ASK and an
  already-in-flight `bash` slips through, or vice versa.)
- **Invalid prefix**: `/yolocowboy` (not a registered command) is not
  stripped; gets sent as-is to the model. Same behavior as any other unknown
  slash-prefix today.

## Testing

- **Unit**: gate wrapper logic — gated tool + YOLO mode passes through; gated
  tool + ASK mode awaits; timeout fires after 5 min; ungated tools never
  await.
- **Unit**: prefix stripper — `/yolo foo` → `("yolo", "foo")`, `/careful bar`
  → `("ask", "bar")`, `/yolocowboy x` → `(null, "/yolocowboy x")`.
- **Integration**: full turn through manager — start ASK session, model emits
  `bash`, verify WS event fires, simulate approve, verify execution.
- **Integration**: timeout path — same setup, no response, verify synthetic
  denial after 5 min (test uses shortened timeout).
- **UI smoke (manual)**: toggle in header, card rendering, left-rail tint,
  prefix completion.

## Out of scope (deliberately)

These were considered and explicitly rejected:

- **Global persistence of toggle** — per-session only, to avoid "flipped
  yesterday, forgot, broke bedtime run" failure mode.
- **Allowlists / denylists / path-based policies** — binary only. Brian named
  the binary explicitly.
- **Sandboxing** (chroot, container, syscall filtering) — not the safety
  model. The model's judgment is the safety layer.
- **Subagent-internal gating** — `delegate` is gated once at spawn; subagent
  inherits nothing. Trade is named above.
- **Audit log feed of all tool calls** — separate observability concern, can
  come later.
- **Phone push / out-of-band notifications on pending approval** —
  over-engineered for a binary mostly left on YOLO.
- **Special-case "restart ytsejam" approval shape** — `bash` covers it, no
  separate logic needed.

## Files expected to change

| File | Change |
|---|---|
| `server/src/manager.ts` | Wrap gated tools' `execute`; thread effective-mode through turn; emit approval events. |
| `server/src/server.ts` | WS handlers for `approval_response`; mode-toggle HTTP endpoint. |
| `server/src/tools/*.ts` | Mark tools as gated/ungated (likely a flag on the tool record, not a hardcoded list elsewhere). |
| Schema migration | `sessions.approval_mode` column. |
| `web/src/components/Chat.tsx` | Approval card component; mode-aware composer prefix handling. |
| `web/src/components/Sidebar.tsx` | Left-rail tint on YOLO sessions. |
| `web/src/components/ChatHeader.tsx` (or wherever the icons live) | Mode toggle control. |
| Slash-completion data source | Add `/yolo` and `/careful` entries. |
| `server/src/persona.ts` | Update tool-safety text to describe the new mode (and that the model should respect it). |

Concrete component paths to be confirmed in write-plan.

## Harness-gate check

This is a feature touching `server/src/`, so it needs to clear the
Justify-server-change gate (cog-meta/patterns.md, promoted 2026-06-11):

1. **What does this let the harness DO that a skill orchestrating existing
   tools can't?** Intercept tool dispatch and pause it on user input. A skill
   runs *as* a tool sequence; it cannot gate other tool calls from outside.
   The gate must live at the dispatch layer, which is server-side.

2. **Why does upstream convention demand it (not just "would be nicer")?**
   Approval gates on agent tool calls are a standard agent-harness pattern
   (Claude's tool-approval UI, Cursor's command palette, etc.). The current
   "vibe based on persona text" approach is the outlier.

3. **What real friction does it remove — measured, not hypothetical?** The
   measured friction is the cost of *not having it*: every careful moment
   today requires Brian to either fully review a plan turn-by-turn (slow) or
   accept the model could do something quietly destructive (anxiety). The
   binary is the cheapest correct shape.

**Verdict: PASS.** Approval-gate UI is browser-runtime; pause/resume is
server-side state on the active turn; no skill can intercept tool dispatch
from outside the harness.
