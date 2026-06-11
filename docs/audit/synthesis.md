# UI Audit Synthesis — ytsejam web frontend

**Date:** 2026-06-11
**Audit goal:** Identify responsive-design and iPhone-friendliness gaps in `~/projects/ytsejam/web/`.
**Method:** Three subagents on three model families, identical brief, structured-output rubric for mechanical synthesis. Code-only (no browser).

| Reviewer | Family | Verdict | File |
|---|---|---|---|
| Claude Opus 4.8 | Anthropic | **NEEDS-WORK** | [`claude-opus-4.8.md`](./claude-opus-4.8.md) |
| GPT-5.5 | OpenAI | **REJECT** | [`gpt-5.5.md`](./gpt-5.5.md) |
| Gemini 3.5 Flash | Google | **NEEDS-WORK** | [`gemini-3.5-flash.md`](./gemini-3.5-flash.md) |

**Verdict synthesis:** The two "NEEDS-WORK" verdicts and the one "REJECT" agree on the substance — the codebase has effectively zero mobile layout. The difference is threshold: GPT-5.5 measured against "first-class iPhone tool" (the stated goal), Claude and Gemini measured against "fixable in a bounded pass" (also true). All three would block iPhone shipping today. Treat as REJECT for the stated goal.

---

## Tier 1 — Unanimous Critical (all three flagged, fix first)

These are the issues every reviewer surfaced as critical or high-priority. Highest confidence. Fix these and the worst of the iPhone experience is unblocked.

### 1. Fixed `w-72` (288px) sidebar with no breakpoint

**Files:** `src/App.tsx:24`, `src/components/Sidebar.tsx:40`
**The math (verified by all three):** 288px sidebar of 375px viewport leaves **87px** for chat. Of 390px: 102px. Of 430px: 142px. Unusable.
**No breakpoints exist** in app-layout code — Claude grep-confirmed all `sm:`/`md:` utilities live only inside `src/components/ui/` primitives, never in app layout. This is structural, not a polish issue.
**Fix (all three converged):** Wrap the existing `<aside>` in a shadcn `Sheet` (Radix Dialog as side drawer); `hidden md:flex` on the inline aside; add a hamburger in a mobile top bar.
**Harness-friendly:** uses an existing shadcn primitive, no new component class.

### 2. No `viewport-fit=cover` + no safe-area-inset handling

**Files:** `index.html:6`, plus the entire compiled CSS (Claude verified `0` occurrences of `env(safe-area-inset-*)` in `dist/assets/*.css`).
**Effect on iPhone:** content collides with the notch (top), composer collides with the home indicator (bottom). Will be worse once installed as a PWA.
**Fix (all three converged):** Add `viewport-fit=cover` to the meta tag. Then pad the chat composer (`Chat.tsx:55`) with `pb-[env(safe-area-inset-bottom)]` and any full-height edges with the corresponding top/left/right values. Tailwind v4 supports arbitrary `env()` values directly — no plugin.

### 3. `h-screen` (100vh) instead of `h-dvh`

**Files:** `src/App.tsx:24`, `src/components/Login.tsx:21`
**Effect on iPhone Safari:** iOS Safari's `100vh` includes the area under the dynamic toolbar, so the bottom of the chat composer (and Login button) sits hidden behind Safari's bottom bar until the user scrolls. Classic.
**Fix (all three converged):** Replace `h-screen` with `h-dvh`. Tailwind v4 ships it. Two-line change.

### 4. Touch targets below Apple HIG 44pt minimum

**Files:** `src/components/ui/button.tsx:25` (default `h-8` = 32px, `sm` = 28px, icon variants 28-36px)
**Affected call sites (all three agree on the pattern; Claude itemized them):** Send/Stop (`Chat.tsx:67/72`), New chat / Tasks / ⚙ (`Sidebar.tsx:42/45/48`), task Cancel/View (`TaskCard.tsx:115/118`), schedule Cancel (`Settings.tsx:111`), dialog close (`ui/dialog.tsx:70-73`).
**Fix (best version, Claude's):** *Don't fork the primitive.* Add one `@media (pointer: coarse) { [data-slot="button"], [data-slot="input"], [data-slot="select-trigger"] { min-height: 44px; } }` block in `index.css`. Single CSS rule, respects desktop density, no component rewrites.
**Harness-friendly note:** GPT-5.5 suggested per-call-site responsive class additions (`min-h-11 px-3` everywhere); Gemini suggested editing the Button defaults. Claude's `pointer: coarse` media query is the cleanest "use existing CSS pattern, touch nothing else" path. **Adopt Claude's approach.**

### 5. iOS auto-zoom on Settings's native `<select>` and persona textarea

**Files:** `src/components/Settings.tsx:73` (native `<select>` is `text-sm` = 14px), `Settings.tsx:63` (persona textarea overrides primitive to `text-sm`)
**Effect:** iOS Safari auto-zooms any focused input <16px. Disruptive scaling.
**Important nuance (all three caught this):** the *base* Input/Textarea primitives are already iOS-zoom-safe — they use `text-base md:text-sm` (16px on phones, 14px on desktop). The bug is that **Settings overrides them.**
**Fix (all three converged):** Change Settings's overrides from `text-sm` → `text-base md:text-sm`. Two-line change.

### 6. Modal dialogs are centered narrow boxes on mobile, not full-screen sheets

**Files:** `src/components/Settings.tsx:56` (`max-w-2xl`, no `max-h`/scroll), `TasksDialog.tsx:20`, `TaskCard.tsx:69`
**Effect:** On iPhone with keyboard open, an 80vh centered box gets crushed; the Settings persona textarea (`rows={12}`) overflows with no internal scroll; Save buttons can land under the keyboard.
**Fix (all three converged, Claude's most precise):** Mobile-full-screen treatment: `className="max-w-2xl h-[100dvh] max-h-[100dvh] rounded-none sm:h-auto sm:max-h-[80vh] sm:rounded-xl"` + add `overflow-y-auto` to Settings's content. Standard shadcn responsive-dialog pattern.

---

## Tier 2 — Two-of-three agreement (high confidence)

### 7. PWA / add-to-home-screen metadata is missing entirely

**Files:** `index.html` (no manifest, no `apple-touch-icon`, no `theme-color`, no `apple-mobile-web-app-capable`); only `favicon.svg`/`icons.svg` exist in `public/`.
**Caught by:** GPT-5.5, Claude (Gemini mentioned in passing but didn't itemize).
**Effect:** "Add to Home Screen" produces generic browser-chrome icon with default status bar. For a tool Brian opens throughout the day, the install feels half-built.
**Fix:** Minimal `manifest.webmanifest` (name, theme-color matching the dark `--background` ≈ `#0b1418`, `display: standalone`, existing `favicon.svg` as a maskable icon) + `<link rel="manifest">`, `<meta name="theme-color">`, `<meta name="apple-mobile-web-app-capable" content="yes">`, `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`, an `apple-touch-icon`. **No service worker** — install doesn't need one, and Workbox is harness-bloat.

### 8. Long URLs / inline code can overflow narrow chat bubbles

**Files:** `src/components/Message.tsx:74` (bubbles `max-w-[80%]`), `:86` (prose container)
**Caught by:** GPT-5.5, Claude.
**Effect:** Bubble width is fine; the `prose` inline `<code>` and bare URLs have no wrap guard and force horizontal scroll inside the narrow chat column.
**Fix:** Add `break-words` or `[overflow-wrap:anywhere]` to the prose div (`Message.tsx:86`).

### 9. Sidebar session delete (`×`) is unreachable on touch

**Files:** `src/components/Sidebar.tsx:68` (only delete control; `className="hidden ... group-hover:block"`)
**Caught by:** Gemini, Claude (GPT-5.5 mentioned it as Medium Priority).
**Effect:** Tailwind v4 wraps `group-hover:` in `@media (hover:hover)` (Claude verified in shipped CSS). iPhones report `hover: none` → the button never appears. **Sessions can be created on mobile but never deleted.**
**Inverse-of-the-obvious finding (Claude's framing):** Tailwind v4 *already* solves sticky-hover. The trap is the opposite — hover-*gated affordances* disappear on touch.
**Fix:** Make the control always visible on touch (`block md:hidden md:group-hover:block`), or unconditionally render with reduced opacity.

### 10. Dark mode is hardcoded; `prose-invert` is hardcoded

**Files:** `index.html:2` (`<html class="dark">`), `src/components/Message.tsx:86` (`prose prose-invert`)
**Caught by:** GPT-5.5, Claude (Claude as Medium #5).
**Effect:** Works correctly today because the app is always-dark. But the CSS *defines* both light and dark themes (`index.css:57-99`), so this is a latent bug if light/system theme is ever enabled. Also violates CLAUDE.md's "don't assume dark theme" rule.
**Fix:** Drop the hardcoded `prose-invert`, rely on `dark:prose-invert`. Optionally add `prefers-color-scheme` bootstrap if system-adaptive theme is desired.

---

## Tier 3 — Unique-to-one findings (worth considering)

These are items only one reviewer flagged. Lower confidence — could be insightful family-specific catches, or could be noise. Decide case-by-case.

### From Claude only

- **`scrollIntoView({behavior:"smooth"})` fights the iOS keyboard.** `Chat.tsx:27-29` auto-scrolls to bottomRef on every message/stream tick. iOS scrolls focused composer into view; competing smooth scroll causes janky scroll wars and input jumping during typing. *Fix: scroll the message container's `scrollTop` rather than `scrollIntoView` on whole page; gate to "only if already near bottom."* Confidence: medium; needs device verification. **Likely a real bug worth fixing.**
- **`field-sizing-content` textarea auto-grow is Safari 17.4+ only.** `textarea.tsx:10`. On older iOS Safari, the composer won't grow. Minor.
- **Generic `<title>web</title>`.** `index.html:8`. One-line fix. Adopt.

### From GPT-5.5 only

- **Chat `main` lacks `min-w-0`.** `Chat.tsx:45-57`. Combined with the fixed sidebar, can create horizontal overflow instead of flex squeeze. *Real find; goes away once the sidebar becomes a drawer (Tier 1 #1) but is a defensive fix worth keeping.* Add `min-w-0`.
- **TaskCard horizontal action row doesn't shrink.** `TaskCard.tsx:101-120`. Cancel/View buttons can crowd label/status in narrow dialogs. Fix: `flex-wrap` or `flex-col sm:flex-row`. Medium.

### From Gemini only

- **Login card `w-80` (320px) is tight at 375px viewport.** `Login.tsx:23`. Claude caught the same shape (Medium #3) — actually 2-of-3, just noting Gemini surfaced it first. *Fix: `w-80 max-w-[calc(100%-2rem)]`.*
- **Various Strengths claims (oklch variables, unidirectional state).** Real but unactionable in the audit context.

---

## Direct disagreements

Two reviewers contradicting each other are the most informative cases. Reviewing each:

### "Hover stickiness on iOS" — Gemini said yes, Claude said no

Gemini's iPhone-Specific Concerns list flagged sticky `:hover` states as an iOS issue. Claude verified (in compiled CSS) that Tailwind v4 already wraps `hover:`/`group-hover:` in `@media (hover:hover)`, so they don't trigger on touch.

**Adjudication:** Claude's finding is verifiable and correct. Tailwind v4's automatic hover-media-query wrapping is documented and confirmed in this codebase's shipped CSS. Gemini's concern is generic-iOS-knowledge that doesn't apply here. **Trust Claude. The trap is the inverse — hover-gated affordances vanishing on touch (item #9 above), not sticky hover.**

### Dialog default width — Gemini said `max-w-[calc(100%-2rem)]`, GPT-5.5 said `max-w-2xl`

Both are looking at different layers. Gemini read the primitive `ui/dialog.tsx:62` default. GPT-5.5 read the *consuming* `Settings.tsx:56` which overrides to `max-w-2xl`. Claude analyzed how `tailwind-merge` resolves the conflict (the unprefixed `max-w-2xl` overrides `sm:max-w-sm` at all widths by source order).

**Adjudication:** Both correct at their level. Claude's resolution-analysis is the most complete. The *fix* lives at the call sites (Settings, TasksDialog), not the primitive. **No real disagreement, just different read-depths.**

---

## What no reviewer could verify (browser smoke required)

All three agreed on the limits:
- Exact pixel overflow / horizontal scrollbar appearance at 375/390/430.
- iOS keyboard occlusion of Settings Save button and chat composer.
- `scrollIntoView` vs keyboard scroll-war behavior (Claude High #4) — observable only live.
- Real touch-hit-rate ergonomics — measurable only on device.
- `field-sizing-content` fallback behavior on specific iOS Safari versions.
- PWA standalone status-bar appearance.
- `confirm()` and native `<select>` rendering inside dark `color-scheme` on real iPhone (CLAUDE.md notes headless Chrome lies about this).

**Implication:** Anything in the audit marked `confidence: medium` should be browser-confirmed before the fix lands. This is a code-level audit; the rendered audit is a separate pass.

---

## Recommended Action Order

Concrete, prioritized, harness-friendly. Numbers below correspond to the synthesis tiers above.

### Phase 1 — Unblock iPhone usage (must-do)

These four fixes together make the app *usable* on iPhone. Each is small.

1. **Sidebar → Sheet drawer below `md`** (Tier 1 #1). Wraps existing `<aside>` in shadcn `Sheet`. One component change, one hamburger trigger. Single highest-impact fix.
2. **Viewport + safe-area + dvh together** (Tier 1 #2, #3): add `viewport-fit=cover` to `index.html`, swap `h-screen`→`h-dvh` in App + Login, pad chat composer with `pb-[env(safe-area-inset-bottom)]`. ~5 line-changes total.
3. **Touch-target pass** (Tier 1 #4): one `@media (pointer: coarse)` CSS block. Single rule.
4. **Settings text-size fix** (Tier 1 #5): `text-sm` → `text-base md:text-sm` on the two Settings overrides. Two-line change.

### Phase 2 — Mobile polish (should-do)

5. **Mobile-full-screen dialogs** (Tier 1 #6): responsive `h-[100dvh] rounded-none sm:h-auto sm:rounded-xl` on Settings/TasksDialog/transcript + `overflow-y-auto` on Settings content. Standard shadcn pattern.
6. **Unhide sidebar delete on touch** (Tier 2 #9): drop hover-gating; always-visible with reduced opacity.
7. **Text overflow guard on chat bubbles** (Tier 2 #8): `break-words` on `Message.tsx:86` prose container.
8. **Defensive `min-w-0` on Chat main** (Tier 3 GPT-5.5): pairs with Sidebar→Sheet conversion.

### Phase 3 — First-class home-screen tool (nice-to-have)

9. **PWA polish** (Tier 2 #7): `manifest.webmanifest` + apple meta tags + `theme-color` + `apple-touch-icon`. No service worker. Real `<title>ytsejam</title>`.
10. **`scrollIntoView` → conditional `scrollTop`** (Tier 3 Claude): scroll the container, gate to "near bottom only."
11. **Drop hardcoded `prose-invert`, use `dark:prose-invert`** (Tier 2 #10): latent bug, free to fix.

### Phase 4 — Browser smoke (gate)

12. **Render at 375/390/430 and exercise:** keyboard open in Settings, composer focus on long messages, sidebar drawer open/close, dialog full-screen behavior, PWA install + launch. Confirm or refute the `confidence: medium` items.

---

## Notes on the audit process itself

- **Cross-family panel worked.** Three families produced overlapping-but-distinct findings; the consensus items are robustly high-confidence and the unique items reveal family-specific catches. Claude's verification-against-compiled-CSS (the `@media (hover:hover)` finding, the `0` occurrences of `env(safe-area-inset-*)`) was the most rigorous; GPT-5.5's call-site itemization was the most comprehensive; Gemini's "exceptionally clean codebase" framing was the most generous (and the only one to soften the verdict to NEEDS-WORK on a strict reading).
- **Harness-not-tools rule held.** Every recommendation in this synthesis uses an existing CSS/Tailwind v4/shadcn primitive. No "build a new drawer component" or "add a touch-handling library." The closest call was Claude's `@media (pointer: coarse)` CSS block — that's still plain CSS, not new code.
- **Code-only audit's limits are real.** Sections 4 ("browser smoke") gates the medium-confidence items. Don't ship Phase 1 without a quick live check on a real iPhone.
- **Total scope of changes** for Phases 1+2 is well under 100 lines across ~6 files. Phase 3 adds a small `manifest.webmanifest` + ~8 meta tags. Phase 4 is verification, not changes.
