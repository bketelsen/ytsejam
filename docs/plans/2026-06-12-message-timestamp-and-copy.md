# Design: Message hover timestamp + copy button (UI only)

**Status:** SHIPPED 2026-06-11 — merged to `main` (commits `0564edb` impl, `11a18c4` tests + late-evening/early-morning fix); live in prod release `20260611-110817`.
**Project:** ytsejam
**Touches server/src:** NO — web/ only. No new API, no schema change.
**Scope:** `web/src/components/Message.tsx` + `web/src/lib/time.ts` (new) + `web/src/index.css` (coarse-pointer rule) + `web/test/time.test.mjs`.

**As built:** matches the draft. No-shift via absolutely-positioned, opacity-only group-hover cluster (`message-hover-cluster`); native `title=` fallback; copy = raw markdown of text blocks only (excludes thinking/tool-JSON) with `navigator.clipboard` → hidden-textarea `execCommand` fallback → hide if neither; coarse-pointer fallback shows the cluster at opacity 0.6. Helper is Intl-based, no dependency. Honest caveat carried at ship: no-layout-shift is a structural CSS guarantee, visually confirmed by Brian on the dev instance.

---

## Goals

1. **Relative timestamp on hover** for each message (e.g. "2m ago", "3h ago", "yesterday"), shown when the user hovers the bubble — **with zero layout shift**.
2. **Copy button** per message that copies the message's text content to the clipboard.

Both are presentational. The data already exists.

## Data is available (verified)

`ChatMessage.timestamp?: number` (epoch ms) is already in `web/src/lib/types.ts`, and the live API populates it on every message (`GET /api/sessions/:id` returns `timestamp` on user/assistant/toolResult messages — verified against the running instance). So:
- **No server change.** Render relative time from `message.timestamp`.
- It is typed optional, so guard: if `timestamp` is missing, render no time affordance (don't crash, don't show "Invalid Date").

## The hard constraint: NO UI shift

The timestamp must appear on hover without reflowing the bubble, the message list, or shifting neighbours by a pixel. This rules out:
- conditionally mounting an in-flow element on hover (changes height/width),
- `display:none → block` toggles that occupy space when shown,
- anything that participates in the flex/normal flow.

**Two acceptable techniques (use both, layered):**

1. **Native `title` attribute** — zero layout cost, fully accessible, but browser-styled and ~1s delayed. Use it as the baseline/fallback on the bubble: `title={absoluteAndRelative}` so even without custom CSS there's a hover tooltip.

2. **Absolutely-positioned overlay** (the primary, custom-styled one): a small timestamp element rendered with `position:absolute`, taken OUT of flow, `opacity-0` by default and `opacity-100` on group-hover. Because it's absolutely positioned it occupies no layout box — neighbours never move. Anchor it relative to the bubble (the bubble wrapper gets `relative` + a `group` class). Place it just outside/above the bubble (e.g. `-top-5`, aligned to the bubble's start/end edge depending on user vs assistant) or inside a corner — pick a spot that does not overlap text. Pure opacity transition; no width/height/margin animation.

Implementation note: add `group relative` to the inner bubble `<div>` (the one with `max-w-[80%] rounded-lg px-3 py-2 ...`). The timestamp + copy button are `absolute`, `opacity-0 group-hover:opacity-100 transition-opacity`, `pointer-events-none` until shown (so they don't block text selection), `pointer-events-auto` on the copy button when visible. On touch (`@media (pointer:coarse)`) there's no hover — either always-show at reduced opacity, or reveal on tap/focus; v1 can simply always render them at low opacity on coarse pointers (decide in build; keep it from shifting layout there too).

## Relative time helper

Small pure function in `web/src/lib/` (e.g. `time.ts`): `relativeTime(ms: number): string` → "just now" / "Nm ago" / "Nh ago" / "yesterday" / "Mon DD" / "Mon DD, YYYY" for older. Also `absoluteTime(ms)` → full locale string for the `title`. Prefer `Intl.RelativeTimeFormat` / `Intl.DateTimeFormat` (built-in, no dep). The hover `title` shows the absolute time (and optionally the relative); the overlay shows the relative.

(Live-updating the relative string as time passes is NOT required for v1 — it's computed on render. A message list re-renders often enough; do not add a per-message interval timer. Note as a possible later nicety.)

## Copy button

- Per-message control that copies the message's **text** to the clipboard via `navigator.clipboard.writeText(...)`.
- **What to copy:** concatenate the text of the message's text blocks (the same `blocks(message).filter(type==="text").map(text).join("\n")` shape already used elsewhere in this file for tool results). Copy the raw markdown source (what the model wrote), not rendered HTML — most useful for pasting. Exclude thinking blocks and tool-call JSON; copy the human-facing text.
- **Placement:** lives in the same absolutely-positioned, group-hover-revealed cluster as the timestamp (so it also causes no layout shift). A small icon button (clipboard glyph from the existing icon set / lucide if present, else a unicode ⧉ or "Copy" text button using the shadcn `Button` `size`/`variant` ghost). `pointer-events-auto` so it's clickable when revealed.
- **Feedback:** on click, swap the icon/label to a check / "Copied" for ~1.5s (local `useState`), then revert. No toast needed.
- **Guard:** `navigator.clipboard` can be undefined on non-secure origins. ytsejam is served over http on LAN/tailscale — `navigator.clipboard` requires a secure context (https or localhost). Over plain-http LAN it may be unavailable. Fallback: a hidden `<textarea>` + `document.execCommand("copy")` path, or feature-detect and hide the button when no clipboard API. **Resolve in build:** test whether the clipboard API is present when served via tailscale-serve (which terminates TLS — likely secure context) vs raw http://host:9873 (not secure → no API). At minimum, feature-detect and degrade (hide button or use execCommand fallback) rather than throwing.

## Which messages get these

- **User + assistant text messages:** yes (timestamp + copy).
- **toolResult messages:** already return null (not rendered standalone) — skip.
- **Tool-call cards / TaskCards:** out of scope for v1 (the copy/timestamp is for the conversational messages). Could extend later.
- Thinking-only blocks: no copy button (not primary content); timestamp optional.

## Implementation steps

1. `lib/time.ts`: `relativeTime(ms)` + `absoluteTime(ms)`, pure, Intl-based. Unit-testable (vitest in web workspace if web tests exist; else keep trivially correct).
2. `Message.tsx`: add `group relative` to the bubble wrapper; add the absolutely-positioned hover cluster (timestamp text + copy button), `opacity-0 group-hover:opacity-100 transition-opacity`, guarded on `message.timestamp` presence and clipboard availability. Copy handler with copied-state feedback.
3. `index.css` (only if needed): a `@media (pointer:coarse)` rule to reveal the cluster at reduced opacity on touch (no hover there) — without layout shift.
4. Browser smoke: desktop hover (confirm NO neighbour movement — inspect with layout borders), copy round-trip (paste elsewhere), mobile widths 375/390/430 (controls reachable, still no shift), and a message with absent timestamp (no crash, no "Invalid Date").

## Justification (harness-not-tools gate)

**Not applicable — web/ only, no server change.** This is pure presentation on data the API already sends. No `Justify-server-change:` trailer needed.

## Open questions

- Clipboard over plain http (non-secure context): confirm whether served-via-tailscale is a secure context (expected yes); decide execCommand fallback vs feature-detect-hide for the raw-http case. Degrade gracefully regardless.
- Touch reveal: always-show-at-low-opacity vs tap-to-reveal. Lean always-show-faint on coarse pointers for v1.
- Exact overlay placement (above bubble vs corner-inside) — pick during build to avoid overlapping text at narrow widths; must not shift layout in any case.
