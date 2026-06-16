# Sidebar Session Rename Implementation Plan

> Execute with the `develop` skill, task-by-task.

**Goal:** Add a UI affordance to rename an active session from the sidebar, reaching the already-wired backend rename path.

**Spec:** docs/plans/2026-06-16-sidebar-rename-session-design.md

**Architecture:** Frontend-only. Inline-edit triggered by a Pencil hover icon-button (matching the existing Archive icon idiom) plus double-click on the title; commits via the existing `client.patchSession(id, { title })`. No server/manager/api changes — `manager.rename` already handles mid-turn renames via `pendingTitle`.

**Tech Stack:** React 19 + TypeScript, Vite, lucide-react icons, Tailwind.

**Worktree:** ~/projects/.worktrees/sidebar-rename-session

**Branch:** fix/sidebar-rename-session

---

## Context for the implementer

All edits are in **`web/src/components/Sidebar.tsx`** (one file). Read it fully first. Key existing facts confirmed against `main` @ `2cb7917`:

- Active-list rows: outer `<div onClick={() => onSelect(s.id)}>` is the row-select handler. Anything interactive inside MUST call `e.stopPropagation()` (the existing `archive`/`unarchive` handlers do this).
- The title renders at the span currently reading `{s.title ?? "New session"}` (active list, inside a `<span className="flex-1 truncate text-sm">`).
- Archive is the pattern to mirror: a `lucide-react` icon-button with `className="block text-muted-foreground hover:text-foreground md:hidden md:group-hover:block"`, `title=`, `aria-label=`, and an `onClick` that takes `(s.id, e)` and calls `e.stopPropagation()`.
- `client.patchSession(id, { title })` already exists (`web/src/lib/api.ts:49`).
- `SessionRow` type is imported from `@/lib/types`; `client` from `@/lib/api`. Icons import from `lucide-react` (currently `Archive, ArchiveRestore`).
- The session list is owned by `useApp` and updated live over WS — `archive()`/`unarchive()` rely on the parent refresh (`onArchived`) rather than mutating in place. Rename follows the same model: after a successful PATCH, the server emits a `session_info` update and the row re-renders. **No local list mutation, no new prop on `Sidebar`.**

Gate to run after each task: `env -u NODE_ENV bash scripts/gate.sh` (from the worktree root). Baseline is **158 pass / 0 fail, gate PASSED**.

---

## Task 1: Inline rename affordance (Pencil button + double-click + inline input)

**Files:**
- Modify: `web/src/components/Sidebar.tsx`

### Step 1: Add the Pencil import

Change the lucide-react import line:

```ts
import { Archive, ArchiveRestore, Pencil } from "lucide-react";
```

### Step 2: Add edit state inside the `Sidebar` component

Near the existing `useState` declarations (alongside `showArchived` etc.), add:

```ts
const [editingId, setEditingId] = useState<string | null>(null);
const [draft, setDraft] = useState("");
```

### Step 3: Add the start / commit / cancel handlers

Place these next to the existing `archive`/`unarchive` functions inside the component:

```ts
function startRename(s: SessionRow, e: React.MouseEvent) {
  e.stopPropagation();
  setEditingId(s.id);
  setDraft(s.title ?? "");
}

async function commitRename(id: string) {
  // Guard against double-commit (Enter sets editingId=null, then blur fires).
  if (editingId !== id) return;
  const next = draft.trim();
  const original = sessions.find((s) => s.id === id)?.title ?? "";
  setEditingId(null);
  if (!next || next === original) return; // empty/whitespace or unchanged → no write
  await client.patchSession(id, { title: next });
  // Server emits a session_info update over WS; useApp's list re-renders the row.
}

function cancelRename() {
  setEditingId(null);
}
```

Note: the `if (editingId !== id) return;` at the top of `commitRename` is the double-commit guard — when Enter handler calls `commitRename` it sets `editingId = null`; the subsequent blur-triggered `commitRename(id)` then early-returns because `editingId` is no longer `id`. This makes the Enter+blur sequence fire exactly one PATCH.

### Step 4: Render the inline input OR the title span (active list row)

In the active-list `.map((s) => ...)`, replace the current title span:

```tsx
<span className="flex-1 truncate text-sm">
  {s.title ?? "New session"}
  {s.approvalMode === "yolo" ? <span className="sr-only"> (approvals off)</span> : null}
</span>
```

with a conditional — when this row is being edited, show a controlled input; otherwise the span (plus a double-click trigger and the bonus tooltip from Task 2 — but add the tooltip in Task 2, not here):

```tsx
{editingId === s.id ? (
  <input
    autoFocus
    value={draft}
    onChange={(e) => setDraft(e.target.value)}
    onFocus={(e) => e.currentTarget.select()}
    onClick={(e) => e.stopPropagation()}
    onKeyDown={(e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        void commitRename(s.id);
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelRename();
      }
    }}
    onBlur={() => void commitRename(s.id)}
    className="flex-1 rounded border border-sidebar-border bg-sidebar px-1 text-sm text-sidebar-foreground outline-none"
    aria-label="Session title"
  />
) : (
  <span
    className="flex-1 truncate text-sm"
    onDoubleClick={(e) => startRename(s, e)}
  >
    {s.title ?? "New session"}
    {s.approvalMode === "yolo" ? <span className="sr-only"> (approvals off)</span> : null}
  </span>
)}
```

### Step 5: Add the Pencil hover-button next to Archive (active list row)

Immediately before the existing Archive `<button>` in the active-list row, add a Pencil button mirroring the Archive button's classes. It should only show when NOT editing this row (so the input has room):

```tsx
{editingId === s.id ? null : (
  <button
    data-slot="button"
    onClick={(e) => startRename(s, e)}
    className="block text-muted-foreground hover:text-foreground md:hidden md:group-hover:block"
    title="Rename"
    aria-label="Rename session"
  >
    <Pencil className="size-4" />
  </button>
)}
```

(Final visual placement — Pencil before vs after Archive, and whether to hide the timeAgo while editing — is a craft call; eyeball the row and keep it from wrapping. Hiding the Archive button + timeAgo while editing is acceptable if the input needs the width.)

### Step 6: Run the gate

Run: `env -u NODE_ENV bash scripts/gate.sh`
Expected: PASSED, 158 pass / 0 fail (web build + typecheck must succeed — this is the real check for a TS/JSX change; no new tests yet).

### Step 7: Commit

```bash
git add web/src/components/Sidebar.tsx
git commit -m "feat(web): inline rename for active sessions in sidebar (#191)"
```

---

## Task 2: Bonus — full-title hover tooltip on the truncated span

**Files:**
- Modify: `web/src/components/Sidebar.tsx`

### Step 1: Add the `title` attribute to the active-list title span

On the (non-editing) title span from Task 1 Step 4, add a native `title` tooltip so the full title surfaces on hover when truncated:

```tsx
<span
  className="flex-1 truncate text-sm"
  title={s.title ?? undefined}
  onDoubleClick={(e) => startRename(s, e)}
>
```

(`?? undefined` so a null-title row gets no tooltip rather than the literal string "null".)

### Step 2: Run the gate

Run: `env -u NODE_ENV bash scripts/gate.sh`
Expected: PASSED, 158 pass / 0 fail.

### Step 3: Commit

```bash
git add web/src/components/Sidebar.tsx
git commit -m "feat(web): full-title hover tooltip on truncated sidebar titles (#191 bonus)"
```

---

## Task 3 (optional): Light web-side test on the input commit

Only do this if a `web/src` test harness for components already exists (check `web/` for `*.test.ts(x)` and the test setup). If there is no React component-testing setup (e.g. no jsdom/testing-library wired), **skip this task** — do not stand up a new test framework for one input (out of scope, against the harness north-star). The manager path is already covered by `manager.test.ts`.

**If a component test harness exists**, add a test asserting:
- Entering text + Enter calls `client.patchSession(id, { title: <trimmed> })` exactly once.
- Empty/whitespace-only draft on commit does NOT call `patchSession`.
- Unchanged draft (equal to current title) does NOT call `patchSession`.

**Files:**
- Test: `web/src/components/Sidebar.test.tsx` (only if harness exists)

### Step 1: Determine harness presence

Run: `find web/src -name '*.test.ts*'` and inspect `web/package.json` test script + any `vitest.config`/`setup` for jsdom + @testing-library/react.

### Step 2: If present, write the test; if absent, document the skip

If absent: add a one-line note to the plan's execution report that Task 3 was skipped (no web component-test harness) and stop. The web build/typecheck in the gate is the regression guard for this change.

### Step 3 (if test written): Run the gate

Run: `env -u NODE_ENV bash scripts/gate.sh`
Expected: PASSED, test count = 158 + (new tests), 0 fail.

### Step 4 (if test written): Commit

```bash
git add web/src/components/Sidebar.test.tsx
git commit -m "test(web): sidebar rename input commit guards (#191)"
```

---

## Done criteria

- Gate PASSED (158 pass / 0 fail baseline preserved; web build + typecheck green).
- Pencil button + double-click open an inline input on an active session row; Enter/blur commit, Esc/empty/unchanged cancel.
- Full-title tooltip on the truncated span.
- No server/manager/api/types changes; no new prop on `Sidebar`; no local session-list mutation.
- Manual verification (Brian, post-deploy): rename persists through reload; mid-turn rename sticks after the turn ends; Pencil tappable on iPhone PWA.
