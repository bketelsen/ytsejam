# Desktop UI Audit Synthesis — ytsejam web frontend

**Date:** 2026-06-11 (post-mobile-sweep, post-restart)
**Method:** Three subagents on three model families, same brief, structured rubric. Code-only (no browser).
**Trigger:** Brian flagged dialog content not constraining + general desktop ergonomics gaps after the mobile-fixes-and-typing-lag-fix sweep landed (12 PRs, main at `afbbfb0`).

| Reviewer | Family | Verdict | File |
|---|---|---|---|
| Claude Opus 4.8 | Anthropic | **NEEDS-WORK** | [`claude-opus-4.8.md`](./claude-opus-4.8.md) |
| GPT-5.5 | OpenAI | **NEEDS-WORK** | [`gpt-5.5.md`](./gpt-5.5.md) |
| Gemini 3.5 Flash | Google | **NEEDS-WORK** | [`gemini-3.5-flash.md`](./gemini-3.5-flash.md) |

**Verdict synthesis:** Three NEEDS-WORK verdicts. No REJECT this time — the post-mobile-sweep state is genuinely good; what's left is real but bounded. Convergent finding across all three: **dialog max-width is being silently overridden to 384px on desktop**, the bug Brian sees as "dialogs not constraining their content."

---

## Tier 1 — Unanimous Critical (all three flagged, fix first)

### 1. Dialog max-width is being silently overridden to 384px on desktop

**The bug Brian flagged.** All three reviewers found it; two reviewers found two different layers of it; both layers are real.

**Files:** `web/src/components/ui/dialog.tsx:62`, `web/src/components/Settings.tsx:56`, `web/src/components/TasksDialog.tsx:20`, `web/src/components/TaskCard.tsx:69`

**Layer A (GPT-5.5's framing — verified):** The `DialogContent` primitive ends its className with `sm:max-w-sm` (384px). Call sites pass `max-w-2xl` (672px) / `max-w-3xl` (768px) **without `sm:` prefix**. In the compiled CSS, both rules have the same selector specificity, but `sm:max-w-sm` lives inside an `@media (min-width: 40rem)` block that comes AFTER the unprefixed rule in cascade order. **At desktop widths, `sm:max-w-sm` wins.** Settings/TasksDialog/TaskTranscriptDialog are rendering at 384px wide on desktop — narrower than the 320px Login card with one screen-width of margin. Verified via direct inspection of compiled CSS.

**Layer B (Claude Opus 4.8's framing — also verified):** Even if Layer A is fixed, `DialogContent` is a CSS `grid`, and grid items default to `min-width: auto` — they refuse to shrink below their min-content width. So `max-w-2xl` caps the dialog *only if every child can shrink to fit*. Today the dialogs work by luck — every current child is independently `min-w-0`-guarded (textarea has it, list rows use `min-w-0 flex-1 truncate`, etc.). One unguarded child blows the cap.

**Fix (both layers, both small):**
1. Layer A — change call-site classes from `max-w-2xl` → `sm:max-w-2xl`, `max-w-3xl` → `sm:max-w-3xl` in all three dialog usage sites.
2. Layer B — add `[&>*]:min-w-0` to the `DialogContent` base class in `ui/dialog.tsx:62` so future children can't defeat the cap.

Ship together. Layer A makes the existing dialogs look right; Layer B makes them robust against future content.

### 2. Markdown tables overflow chat column and dialog widths

**Files:** `web/src/components/Message.tsx:84-88`

**Caught by:** Claude (Critical), Gemini (Medium).

GPT-5.5 didn't flag this specifically but noted "markdown overflow hardening" in passing — partial coverage.

**The bug:** Claude verified in compiled typography CSS that `.prose table` is `table-layout: auto; width: 100%` with **no** `display: block; overflow-x: auto` wrapper. Unlike `.prose pre`, which gets `overflow-x: auto`, tables sized to content can exceed `width: 100%` and drag the prose container (and ancestor dialog/chat column) wider.

LLM output loves markdown tables — this is a common case that hits hard. Combined with Tier 1 #1's grid `min-width: auto` issue, a wide table in a transcript dialog produces visible blow-out.

**Fix:** Add table-wrap utilities to the prose container at `Message.tsx:86`:
```tsx
<div className="prose dark:prose-invert prose-sm max-w-none break-words [overflow-wrap:anywhere] [&_table]:block [&_table]:overflow-x-auto [&_table]:max-w-full">
```

Pair with Tier 1 #1's `[&>*]:min-w-0` fix. Together they make the chat column and transcript dialog overflow-proof.

### 3. Sidebar session rows are not keyboard-navigable

**Files:** `web/src/components/Sidebar.tsx:53-65`

**Caught by:** All three reviewers (Claude Medium, GPT-5.5 High, Gemini Critical).

**The bug:** Session rows are `<div onClick>` with no `role`, `tabIndex`, or key handler. Tab order skips the entire session list. Keyboard-only users can reach New chat / Tasks / Settings buttons but can't select an existing conversation.

**Fix (Claude's recommendation — cleanest):** Convert the row to a real `<button>` element. Move the delete `×` out of nested-button territory if needed (current shape may already be OK; verify on edit). Inherits `focus-visible` styling automatically from the `<button>` ancestor selectors.

**One reviewer adjudication needed:** Gemini's Critical #2 claimed the delete button is "still focusable in the tab sequence" while invisible. **This is incorrect** — the button uses `hidden` (i.e. `display: none`) which removes it from the tab sequence entirely. The real bug is that on desktop, keyboard users have NO path to delete a session (button is `display: none` until you hover the row with a mouse). The fix for #3 above (making the row keyboard-focusable) plus a `md:group-focus-within:block` on the delete button gives keyboard users a discoverable delete path.

### 4. `@media (pointer: coarse)` 44px rule bleeds onto touchscreen laptops

**Files:** `web/src/index.css:150-156`

**Caught by:** Claude (High); GPT-5.5 noted as a desktop-density concern; Gemini explicitly called it a **strength** (incorrectly).

**The disagreement matters.** Gemini wrote: *"Touch target expansions (to 44px) are brilliantly restricted to `@media (pointer: coarse)` in `index.css`. Desktop density is fully preserved for fine pointer mouse users."* That's true for traditional desktops but **wrong for touchscreen laptops** (Surface, touchscreen XPS, 2-in-1 in laptop mode), which report `pointer: coarse` as primary even with a mouse + 1920px screen. On those devices the entire UI jumps to 44px controls, hurting desktop density.

**Claude's fix:** Tighten the query to `@media (pointer: coarse) and (hover: none)` — excludes mouse-equipped touch laptops while still catching phones/tablets. One-token change.

This is the hybrid-device case the mobile sweep didn't think about. Real but moderate-impact (only affects users on hybrid hardware running in laptop mode).

### 5. Composer Enter-send fires during IME composition

**Files:** `web/src/components/Chat.tsx:77-82`

**Caught by:** Claude (High; specifically IME); GPT-5.5 (Medium; mentioned alongside Cmd/Ctrl+Enter); Gemini (mentioned as a strength, missed the IME issue).

**The bug:** The composer's `e.key === "Enter" && !e.shiftKey` check fires during IME (Input Method Editor) composition. For CJK / Korean / Japanese input where users compose characters across multiple keypresses with Enter sometimes confirming a composition mid-flow, this sends half-composed text. Unambiguously a bug for CJK users; non-issue for ASCII-only users.

**Fix:** Add `!e.nativeEvent.isComposing` to the Enter-send branch:
```tsx
if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
```

One condition. Correct regardless of whether you ever add Cmd/Ctrl+Enter as a sibling shortcut (separate product call).

### 6. Dialog headers + close buttons scroll away with body content

**Files:** All three dialog usage sites (Settings, TasksDialog, TaskCard transcript), via `overflow-y-auto` on `<DialogContent>` itself.

**Caught by:** Claude (Medium); Gemini (High); GPT-5.5 didn't flag explicitly.

**The bug:** Yesterday's PR #16 mobile-dialog fix put `overflow-y-auto` on `<DialogContent>` itself. So when content is long (long Settings persona + schedules, long task transcript), the entire dialog scrolls — including the `<DialogTitle>` and the absolute-positioned close `×` button. Desktop users lose the close affordance when scrolled down.

**Fix:** Restructure dialog content as `flex flex-col` with header `shrink-0` and a separate scrollable body region. Move `overflow-y-auto` from `<DialogContent>` onto the inner content wrapper. Standard shadcn scrollable-dialog pattern; ~3 line changes per dialog.

Worth noting: this is a follow-up to PR #16. The mobile-full-screen fix correctly added scroll containment but put it on the wrong element.

---

## Tier 2 — Two-of-three agreement (high confidence)

### 7. Sidebar delete button is a tiny raw glyph with no hit area

**Files:** `web/src/components/Sidebar.tsx:66-71`

**Caught by:** Claude (High); GPT-5.5 (High); Gemini (touched lightly under the keyboard-focus concern).

The `×` glyph is a raw character with no padding, no `size-*`, no shadcn `Button` wrapper. On desktop the row reflows on hover (timestamp and `×` compete for the same visual slot). Hard to hit precisely with a mouse despite the row being wider.

**Fix:** Wrap as `<Button variant="ghost" size="icon-xs">` with a lucide `X` icon. Reserve the slot with `opacity-0 group-hover:opacity-100` rather than `hidden`/`block` to prevent reflow. Reuses existing primitive + lucide; no new component.

Folds in cleanly with Tier 1 #3 (sidebar keyboard navigation) — both touch the same sidebar row structure.

### 8. ToolCallCard has no hover affordance, looks non-interactive

**Files:** `web/src/components/Message.tsx:30-49`

**Caught by:** Claude (Medium); Gemini (Medium); GPT-5.5 didn't flag.

The collapsed tool-call toggle is a full-width button (`flex w-full text-left`) but has no `hover:` background, no cursor change, no visible affordance that it's clickable.

**Fix:** Add `hover:bg-muted/50 transition-colors rounded-md` to the toggle button. Pure utility additions, no structural change.

---

## Tier 3 — Unique-to-one findings

### Claude-only:
- **Dialog title can collide with absolute close button** when title text is long (`TaskCard.tsx:71-72`). Fix: `DialogHeader className="pr-8"` and `DialogTitle className="break-words leading-snug"`. Small, defensible.
- **Settings ⚙ button has no accessible name** (`Sidebar.tsx:48-50`). Bare glyph, no `aria-label`. Trivial fix.

### GPT-5.5-only:
- **`Message` rendering inside transcript dialog uses chat-bubble `max-w-[80%]`** which wastes space in a dialog context (the bubble caps at 80% of the dialog width, not 100%). Suggests a "dialog mode" prop on Message. Real but moderate — bias toward fixing only if it bothers Brian after Tier 1 lands.

### Gemini-only:
- One factually-wrong claim (delete button "focusable while invisible"; actually `display: none` removes it from tab order). Adjudicated above; the underlying concern is real but the mechanism Gemini described isn't.

---

## Direct disagreements

### Dialog overflow root cause: cascade override vs. grid min-width

**GPT-5.5** identified the `sm:max-w-sm` class cascade as the cause.
**Claude** identified the grid `min-width: auto` as the cause.
**Both are correct, in different ways.** GPT-5.5's finding explains why the CURRENT dialogs render too narrow. Claude's finding explains why any future content that doesn't self-`min-w-0` would defeat the cap regardless of cascade. Fix both; they're complementary, not contradictory.

### `@media (pointer: coarse)` rule

**Claude** flagged as a desktop-density bug on hybrid devices.
**Gemini** explicitly praised as a strength.
**Claude is right.** Gemini missed the hybrid-device case. Real bug, moderate impact.

### IME composition

**Claude** flagged as a real bug (no IME guard, will send mid-composition).
**Gemini** missed it entirely; called the existing Enter-send a strength.
**Claude is right.** Tested behavior matches the spec — `isComposing` is unset, so the bug exists.

---

## Classification — autonomous-dispatch vs morning-decision

Per Brian's authorization: "surprise me with boldness or caution." Each Tier-1 issue classified here. Bias toward autonomous when the fix is mechanical, scoped, and has clear precedent in the codebase. Bias toward morning-decision when the fix involves layout restructuring, taste judgment, or new surface area.

| # | Issue | Classification | Why |
|---|---|---|---|
| 1 | Dialog max-w (cascade + grid min-w-0) | **AUTONOMOUS** | Mechanical class swap at 3 call sites + one primitive line. Verified both layers in source. |
| 2 | Markdown tables overflow | **AUTONOMOUS** | One arbitrary-variant class addition at one site. Verified mechanism. |
| 3 | Sidebar rows keyboard nav | **MORNING-DECISION** | Converting `<div onClick>` → `<button>` requires care around the nested delete button. Real risk of subtle layout shift. Defer to Brian's eyes. |
| 4 | Coarse-pointer query | **AUTONOMOUS** | One-token CSS change. Effect well-understood. |
| 5 | IME composition guard | **AUTONOMOUS** | One-condition addition. Behavior well-defined by spec. |
| 6 | Dialog header scroll-away | **MORNING-DECISION** | Restructures dialog body layout (flex-col + inner scroll wrapper). Touches all three dialogs. Real risk of breaking the existing responsive behavior from PR #16 if done wrong. Wants Brian's eyes. |
| 7 | Sidebar delete button hit area | **MORNING-DECISION** | Couples to #3 (same row structure). Ship together if at all. |
| 8 | ToolCallCard hover affordance | **AUTONOMOUS** | Pure utility class addition. No structural risk. |

**Autonomous queue (dispatch tonight if Brian's "boldness" authorization holds):** #1, #2, #4, #5, #8 — five PRs, each mechanical, each well-supported by evidence.

**Morning-decision queue (file as issues, leave for Brian):** #3, #6, #7 — three PRs that involve real layout restructuring or coupled changes.

---

## Recommended Order if Brian approves autonomous batch

Strictly serial (mobile sweep precedent: serial avoids rebase confusion). Each one is small enough to land in ~5min of subagent time + my merge.

1. **#5 IME guard** — smallest possible (one condition), zero risk, isolated to Chat.tsx
2. **#4 coarse-pointer query** — one CSS token, zero risk, isolated to index.css
3. **#1 dialog max-w (both layers)** — three call sites + one primitive line, the headline bug
4. **#2 markdown table wrap** — one prose className addition, prevents real overflow
5. **#8 ToolCallCard hover** — utility additions, polish

Total: 5 PRs, all classified AUTONOMOUS, all backed by code-verified evidence, all small.

Morning queue (#3, #6, #7) — filed as issues with diagnosis, Brian decides whether to dispatch fixes or restructure.
