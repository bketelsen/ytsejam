# Design: Archive session (soft-delete) — replaces hard delete

**Status:** DRAFT (2026-06-11) — not yet implemented
**Project:** ytsejam
**Touches server/src:** YES — `Justify-server-change:` required at commit (see Justification §)

---

## Problem & principle

Sessions are append-only JSONL transcripts — a permanent record with history value (you can replay/resume them; they feed reflect). **Hard delete throws away something unreconstructable.** But a long session list clutters the browser. Resolve the tension: **archive = soft-delete.** Hide the session from the default list; keep the file. **Remove the hard-delete affordance entirely** — the "Delete" button becomes "Archive". Nothing in the UI destroys a session anymore.

(Filesystem deletion remains possible by hand for someone who truly wants it gone — that's a deliberate, out-of-band act, not a one-click button.)

## Non-goals

- No auto-archive / retention policy in v1 (no "archive after N days"). Manual only.
- No bulk archive UI in v1 (one session at a time, like delete is today).
- No permanent-delete button. Explicitly removed, not relocated.

---

## Current delete path (what "replace completely" means — every touch point)

- **Web:** Sidebar.tsx has a hard-delete affordance (hover-gated ✕ per the audit). `web/src/lib/api.ts` `deleteSession(id)` → `DELETE /api/sessions/:id`.
- **Server route:** `server.ts` `app.delete("/api/sessions/:id")` → 404 if unknown, else `manager.deleteSession(id)`.
- **Manager:** `deleteSession(id)` aborts if running, drops from the open map, `repo.delete(metadata)` (removes the JSONL), `indexer.deleteSession(id)`, emits `session_deleted`.
- **Indexer:** `deleteSession(id)` = `DELETE FROM sessions WHERE id=?`. `listSessions()` = `SELECT * ... ORDER BY updated_at DESC`.
- **Bus/WS:** `session_deleted` event drives the UI to drop the row.

All of this gets repurposed: the destructive `repo.delete` goes away; the rest becomes archive plumbing.

## SSOT decision (the load-bearing one)

`index.db` is **rebuilt from JSONL on boot** (`manager.rebuildIndex()`), and that rebuild hardcodes `unread: false` — so a DB-only column is **ephemeral** and resets on restart. `unread` tolerates that; **archive state must NOT** — a DB-only `archived` flag would un-archive every session on the next restart.

Therefore **archive state must be persisted where `rebuildIndex` can read it back.** Precedent exists: session **title** is SSOT via `session.appendSessionName(title)` (written to the JSONL) and read on rebuild via `getSessionName()`. Archive should follow the same shape:

- **Preferred:** append an archive marker into the session's own JSONL (mirrors `appendSessionName`). On rebuild, read it back and set the derived `archived` column. This keeps archive state traveling with the session file.
- **Fallback (if pi-agent-core does not expose a generic session-metadata append):** a ytsejam-owned sidecar — a small `archived` set persisted as JSONL events under `dataDir/session-meta/` (or reuse the same per-session sidecar the working-dir feature introduces). `rebuildIndex` consults it when repopulating the `archived` column.

**Open question to resolve before build:** does `pi-agent-core`'s `Session` expose an append for arbitrary metadata (beyond `appendSessionName`/`appendModelChange`)? Check `Session`/`SessionStorage` in `@earendil-works/pi-agent-core/dist/harness/`. If yes → in-session marker. If no → sidecar. **This is the same mechanism question as the working-dir plan — pick one approach and share it** (a generic ytsejam per-session metadata channel would serve both archive flag and working dir).

Either way the derived `sessions.archived` column exists for fast list filtering; the JSONL/sidecar is the SSOT that survives rebuild.

---

## Design

### Indexer
- Add `archived INTEGER NOT NULL DEFAULT 0` to the `sessions` table (mirrors the `unread` column). **Bump `SCHEMA_VERSION`** so existing dev indexes recreate cleanly (the index is derived; a recreate just re-reads JSONL).
- `setArchived(id, archived: boolean)` — `UPDATE sessions SET archived=? WHERE id=?` (mirrors `setUnread`).
- `listSessions(opts?: { includeArchived?: boolean })`: default `WHERE archived=0 ORDER BY updated_at DESC`; when `includeArchived` true, return all (with the flag) so the UI can show an archived view later. Add `listArchivedSessions()` or fold into the option — lean to the option.
- `SessionRow` gains `archived: boolean` (like `unread`). `rebuildIndex` sets it from the SSOT marker (not hardcoded false).

### Manager
- Replace `deleteSession` with `archiveSession(id)`:
  - if running, **leave it running** — archive is non-destructive and the run can finish. Do NOT abort on archive (that would be a surprising side effect). If the session is open, just mark it; it stays in the open map and finishes its turn normally.
  - persist the archive marker (in-session append or sidecar per the SSOT decision),
  - `indexer.setArchived(id, true)`,
  - emit `session_archived` (replaces `session_deleted`),
  - **do NOT** `repo.delete` — the file stays.
- Add `unarchiveSession(id)` (symmetric) for the eventual restore path — cheap to add now, wires the same marker off + `setArchived(id,false)` + `session_unarchived` event. Worth including in v1 server-side even if the UI restore is minimal.
- Keep the open-session map behavior: archiving an open session can drop it from the in-memory open map (it's hidden) but must not delete the file.

### Server routes
- **Remove** `app.delete("/api/sessions/:id")`.
- Add `POST /api/sessions/:id/archive` → 404 if unknown, else `manager.archiveSession(id)`, `{ ok:true }`.
- Add `POST /api/sessions/:id/unarchive` → symmetric (supports the restore path).
- `GET /api/sessions` gains optional `?archived=1` to return archived ones (for an archived view); default returns active only.

### Bus / WS events
- Replace `session_deleted` with `session_archived` (and add `session_unarchived`). The web layer handles `session_archived` by removing the row from the active list (same UX as delete looked like), and `session_unarchived` by re-adding it.

### Web
- `api.ts`: replace `deleteSession(id)` with `archiveSession(id)` (`POST .../archive`); add `unarchiveSession(id)`; `listSessions` gains an optional archived flag.
- **Sidebar.tsx:** the hover-gated ✕ "delete" affordance becomes an **"Archive"** affordance (icon: an archive/box glyph rather than a trash/✕). Same placement and interaction (hover or, per the mobile audit, a touch-reachable control — note: the audit flagged hover-gated session-delete as unreachable on touch; the archive control should inherit whatever fix that issue lands, or be tap-reachable). Clicking archives → row disappears from the list. Wire the `session_archived` WS event to drop the row live.
- Remove any "Delete" labels/confirm dialogs. If delete had a confirm ("Delete this session?"), archive needs **no confirm** — it's non-destructive and reversible. (One fewer click; reinforces that nothing is lost.)
- **Archived view (v1, included):** a "Show archived" toggle at the bottom of the sidebar that calls `listSessions({archived:true})` and renders archived sessions muted with an "Unarchive" action per row. Low cost — the `archived` column, the `?archived=1` query, and `unarchiveSession` already exist from the steps above, so the toggle is a small Sidebar addition on top. Clicking Unarchive returns the session to the active list (live via `session_unarchived`).

---

## Implementation order

1. **Indexer + SSOT marker:** `archived` column, `SCHEMA_VERSION` bump, `setArchived`, `listSessions` filtering, `rebuildIndex` reads the marker. Resolve the in-session-vs-sidecar question here. Test: archive a session, rebuild the index, assert it stays archived and is excluded from the default list.
2. **Manager + routes + bus:** `archiveSession`/`unarchiveSession`, remove `deleteSession` + the DELETE route, add archive/unarchive routes, swap events. Test: archive route hides the session but the JSONL file still exists on disk; unarchive restores it.
3. **Web:** Sidebar affordance delete→archive, remove delete UI, wire `session_archived`/`session_unarchived`, and the "Show archived" toggle + per-row Unarchive (v1 — included). Browser smoke desktop + mobile widths (and confirm the archive control is reachable on touch).

Each step independently shippable + dogfooded. Can be built/run on the dev instance (:3000, test memory, throwaway data) against live :9873 before merge.

## Justification (harness-not-tools gate)

Touches `server/src`. It qualifies: this is **core data-lifecycle correctness**, not harness-bloat or a re-implementable tool — it makes session deletion non-destructive (preserving the JSONL SSOT) and is a behavior change to existing routes/manager/indexer, none of which a skill can express. It *removes* a destructive capability and adds a reversible one; net surface roughly flat (delete route → archive+unarchive routes). `Justify-server-change:` trailer cites this.

## Open questions

- In-session archive marker vs sidecar — resolve against `pi-agent-core` `Session` API (see SSOT decision). Share the mechanism with the working-dir feature if possible. **(Only remaining open question.)**
- ~~Should archiving an actively-running session abort it?~~ **RESOLVED (Brian, 2026-06-11): no — let it finish. Non-destructive.**
- ~~Archived-view scope for v1?~~ **RESOLVED (Brian, 2026-06-11): include the "Show archived" toggle + per-row Unarchive in v1 — low cost on top of the column/route/manager work.**
- Interaction with the hover-gated-control mobile audit issue (#8-ish): the archive control should be tap-reachable; coordinate with that fix.
