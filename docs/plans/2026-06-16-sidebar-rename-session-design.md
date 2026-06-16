# Design: Sidebar session rename (UI affordance)

**Issue:** [#191](https://github.com/bketelsen/ytsejam/issues/191) — UI: no way to rename a session — backend exists, frontend doesn't call it
**Date:** 2026-06-16
**Branch:** `sidebar-rename-session`
**Scope:** Frontend-only. No server, manager, or API changes.

## Problem

Session rename is wired end-to-end on the backend but unreachable from the UI. Confirmed against `main` @ `2cb7917`:

- `server/src/server.ts:263` — `app.patch("/api/sessions/:id")` → `manager.rename(id, body.title)` (line 267). ✅
- `server/src/manager.ts:836` — `rename(id, title)` with race-safe `pendingTitle` machinery (mid-run defer @840, `agent_end` flush @397, write-point invariant re-check @1019–1030). ✅
- `web/src/lib/api.ts:49` — `patchSession(id, { title?, ... })` already accepts `title`. ✅
- **UI affordance — absent.** All three `patchSession` call sites pass `unread`/`model`, never `title`. `s.title` renders read-only at `Sidebar.tsx:104` (active) and `:143` (archived).

The 2026-06-15 backfill (#187–#190) generated titles for 53 previously-NULL sessions; some are verbose or land on the wrong topic for compacted multi-thread sessions. Those bad titles are permanent until manually `curl`-PATCH-ed with a Bearer token — not a sensible UX.

## Scope decision

**Active sessions only** (Brian, 2026-06-16). One render site (`Sidebar.tsx:104`). The archived panel (`:143`) keeps its own `archivedRows` state and is explicitly out of scope for this cut; can fast-follow if wanted.

## Approach

**Inline edit triggered by a Pencil hover icon-button** — a hybrid of the issue's two options, chosen to match the sidebar's *actual* idiom rather than the issue's assumed one.

Why this over the issue's literal options:
- The issue's option 2 ("three-dot menu, already a likely host for archive") rests on a menu that **does not exist** — archive is a bare hover icon-button (`<Archive>`, `md:group-hover:block`, `e.stopPropagation()`). Building a menu is *more* surface, not less.
- The issue's option 1 (double-click only) is **invisible** (no signal a row is renamable) and has **no clean touch equivalent** — ytsejam runs as an installed iPhone PWA.
- A Pencil icon next to the existing Archive icon is discoverable, touch-friendly, and matches the one affordance pattern the sidebar already has. Honors the harness north-star: no new modal/popover/menu component.

## Components

All changes in `web/src/components/Sidebar.tsx`. New local state, one new icon import, one new commit handler. No new files, no new props on the `Sidebar` component (rename uses the already-imported `client` directly, mirroring how `archive`/`unarchive` already do).

### 1. State
```ts
const [editingId, setEditingId] = useState<string | null>(null);
const [draft, setDraft] = useState("");
```
Only one row edits at a time. `editingId === s.id` switches that row's title `<span>` to a controlled `<input>`.

### 2. Trigger (Pencil hover-button)
Add a `<Pencil>` icon-button next to the existing `<Archive>` button in the active-list row (after `Sidebar.tsx:104`'s span / timeAgo, before or after Archive — final placement is a craft detail for the implementer to eyeball against the row). Same class pattern as Archive: `block text-muted-foreground hover:text-foreground md:hidden md:group-hover:block`, `aria-label="Rename session"`, `title="Rename"`.

`onClick` (with `e.stopPropagation()`):
```ts
function startRename(s: SessionRow, e: React.MouseEvent) {
  e.stopPropagation();
  setEditingId(s.id);
  setDraft(s.title ?? "");
}
```

Secondary trigger — **double-click on the title span** also calls `startRename` (free, since the edit state already exists; power-user nicety). `onDoubleClick` on the span, also `stopPropagation`.

### 3. Edit input + commit/cancel
When `editingId === s.id`, render an `<input>` in place of the title span:
- `value={draft}`, `onChange` → `setDraft`
- `autoFocus`, and select-all on focus so the user can overtype immediately
- `onClick`/`onKeyDown` stop propagation so typing/clicking in the input never selects/navigates the row
- **Enter** → commit. **Esc** → cancel. **Blur** → commit.

```ts
async function commitRename(id: string) {
  const next = draft.trim();
  const original = sessions.find((s) => s.id === id)?.title ?? "";
  setEditingId(null);
  if (!next || next === original) return; // guard: empty/whitespace or unchanged → no write
  await client.patchSession(id, { title: next });
  // No local list mutation needed: the server emits a session_info update over WS
  // and useApp's session list is the live source — mirrors archive()/unarchive()
  // which also rely on the parent refresh rather than mutating in place.
}

function cancelRename() {
  setEditingId(null);
}
```

Key handler on the input:
```ts
onKeyDown={(e) => {
  if (e.key === "Enter") { e.preventDefault(); void commitRename(s.id); }
  else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
}}
onBlur={() => void commitRename(s.id)}
```

**Empty/unchanged guard rationale:** the backend accepts any string; an empty title renders as the "New session" fallback and looks broken. Guard client-side — empty/whitespace-only OR identical-to-current → cancel without a write.

**Blur-after-Enter double-commit:** Enter fires `commitRename` (sets `editingId = null`), which can also trigger blur → a second `commitRename(id)`. Harmless because the second call's `editingId` is already null and the guard (`next === original` after the first write, or the row no longer in edit) makes it a no-op, but the implementer should confirm no double-PATCH fires — simplest is that the first commit's `setEditingId(null)` unmounts the input before blur resolves, OR an in-flight guard. Note for implementer; not a blocker.

## Bonus catch (flagged, in-blast-radius)

Add `title={s.title ?? undefined}` to the truncating title `<span>` at `Sidebar.tsx:104` so the full title surfaces on hover when truncated. One attribute, same file, directly addresses the "is this title even right?" problem that motivates the rename feature. **Undo:** remove the one attribute.

## Data flow

1. User clicks Pencil (or double-clicks title) → row enters edit mode, input focused + selected.
2. User edits, presses Enter (or blurs) → `commitRename` → `client.patchSession(id, { title })` → `PATCH /api/sessions/:id`.
3. Backend `manager.rename` writes JSONL `session_info` (SSOT) when idle, or defers to `pendingTitle` flushed on `agent_end` when mid-turn.
4. Server emits the updated session over WS; `useApp`'s live session list re-renders the row with the new title. No client-side list mutation.

## Error handling

- **Empty/whitespace title:** guarded client-side (cancel, no write).
- **Unchanged title:** guarded (no write).
- **Mid-turn rename:** no new code — `manager.rename` already handles via `pendingTitle` (#188). Index + WS emit happen immediately; JSONL append deferred to `agent_end`.
- **PATCH failure:** `patchSession` returns a promise; `commitRename` awaits it. On reject, the edit is already closed and the displayed title reverts to server state on next WS update. A toast is *not* in scope (the sidebar has no toast surface today; adding one is out of north-star bounds for this fix).

## Testing

- **Manager path:** already covered by `manager.test.ts` (no new server tests — issue acceptance confirms).
- **Web-side (optional, light):** a component test asserting Enter on the input calls `patchSession(id, { title })` with the trimmed draft, and that empty/unchanged drafts do **not** call it. Optional per issue; include if cheap.
- **Manual (Brian, post-deploy):** rename an active session via Pencil → persists through reload; rename via double-click; Esc cancels; empty title cancels; rename a mid-turn (running) session and confirm it sticks after the turn ends. PWA/touch: confirm the Pencil is tappable on iPhone (always-visible on touch via `md:hidden`).

## Acceptance (from issue #191)

- [x] Rename affordance present in Sidebar (Pencil hover-button + double-click, active list)
- [x] Renames persist through reload (JSONL `session_info` is SSOT — already does)
- [x] In-flight rename still works (no new code — `manager.rename` `pendingTitle`)
- [x] No new manager tests required; light web-side input-commit test optional
- [x] Bonus: full-title hover tooltip on the truncated span

## Out of scope

- Archived-panel rename (`:143`) — deferred fast-follow.
- Three-dot menu / modal / popover — rejected (no existing menu; more surface than the fix needs).
- Toast on PATCH failure — no toast surface in the sidebar today.
