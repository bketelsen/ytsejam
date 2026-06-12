# UI Audit — GPT-5.5

## Verdict
REJECT — The desktop layout is clean, but the fixed 18rem sidebar with no mobile alternate makes the chat effectively unusable at iPhone widths.

## Critical Issues (mobile-breaks-the-app)
1. `web/src/App.tsx:24` + `web/src/components/Sidebar.tsx:40`, fixed row layout and `w-72 shrink-0` sidebar leave only ~87px at 375px, ~102px at 390px, and ~142px at 430px for the chat pane before padding/gaps; there is no breakpoint, drawer, hamburger, or collapsed state. Suggested fix: keep the sidebar as `hidden md:flex md:w-72` on desktop and add a mobile header/hamburger using an existing shadcn/Radix `Sheet`/`Dialog`-style drawer, with chat as the default full-width mobile view. Confidence: high.
2. `web/src/components/Chat.tsx:45-57` and `web/src/components/Message.tsx:74`, the chat `main` lacks `min-w-0` and message bubbles cap themselves at `max-w-[80%]`; combined with the fixed sidebar, messages and the composer can be forced into a min-content squeeze or create horizontal overflow instead of a usable iPhone chat surface. Suggested fix: add `min-w-0` to the chat `main`, make mobile messages use a larger width such as `max-w-[92%] sm:max-w-[80%]`, and solve the sidebar issue above. Confidence: high.

## High Priority (degrades mobile UX significantly)
1. `web/index.html:6`, viewport meta is only `width=device-width, initial-scale=1.0`; it omits `viewport-fit=cover`, so the app cannot intentionally handle notched iPhone safe areas when run in Safari/PWA-like contexts. Suggested fix: use `content="width=device-width, initial-scale=1.0, viewport-fit=cover"` and then add safe-area padding where needed. Confidence: high.
2. `web/src/App.tsx:24`, `web/src/components/Login.tsx:21`, and `web/src/index.css:138-148`, full-height screens use `h-screen`/100vh with no `dvh`/`svh` fallback and no global root height strategy; iOS Safari dynamic toolbars and the keyboard can make the bottom composer or login form sit behind browser chrome. Suggested fix: use `min-h-dvh`/`h-dvh` for app shells, consider `min-h-svh` fallback where appropriate, and test keyboard-open behavior. Confidence: medium-high from code; exact severity needs Safari.
3. `web/src/components/Chat.tsx:56-78`, the composer has fixed bottom padding `p-3` and no `pb-[calc(...+env(safe-area-inset-bottom))]`; on notched/home-indicator iPhones, especially if installed or with `viewport-fit=cover`, the textarea/send button can sit too close to or under the home indicator. Suggested fix: add safe-area-aware padding to the composer container, e.g. `pb-[calc(0.75rem+env(safe-area-inset-bottom))]`, and keep the send button reachable. Confidence: high.
4. `web/src/components/ui/button.tsx:24-34`, default shadcn-nova button heights are 32px, `sm` is 28px, and icon buttons are 28-36px; Apple HIG recommends roughly 44pt touch targets. This affects primary actions in `web/src/components/Chat.tsx:72-76`, sidebar controls in `web/src/components/Sidebar.tsx:42-49`, task actions in `web/src/components/TaskCard.tsx:116-120`, and the dialog close button in `web/src/components/ui/dialog.tsx:70-73`. Suggested fix: introduce mobile-friendly sizing via Tailwind classes at call sites (`min-h-11 px-3`, `size-11` for icon-only) or adjust the app’s Button defaults while preserving desktop density with responsive variants. Confidence: high.
5. `web/src/components/Settings.tsx:56-64`, Settings dialog has `DialogContent className="max-w-2xl"` but no `max-h` or `overflow-y-auto`; it contains a 12-row persona textarea plus model and schedules sections. On shorter iPhones or when the keyboard is open, content/actions may become unreachable. Suggested fix: use mobile-first dialog sizing such as `max-h-[calc(100dvh-2rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] overflow-y-auto`, or make it full-screen/bottom-sheet style on small screens. Confidence: medium-high.
6. `web/src/components/Settings.tsx:63` and `web/src/components/Settings.tsx:73`, Settings overrides form controls to `text-sm` including the persona textarea and native `select`; iOS can zoom focused controls below 16px. Suggested fix: keep mobile form controls at `text-base md:text-sm`, e.g. `className="font-mono text-base md:text-sm"` and `className="... text-base md:text-sm"`. Confidence: high.
7. `web/index.html:5-7` and `web/public/` contents, there is no web app manifest, `apple-touch-icon`, `theme-color`, or iOS status-bar meta; only `favicon.svg`/`icons.svg` are present. Suggested fix: add a minimal manifest, app icons, `<link rel="apple-touch-icon" ...>`, and light/dark `theme-color` tags matching semantic background tokens. Confidence: high.

## Medium Priority (rough edges)
1. `web/src/components/Sidebar.tsx:66-72`, delete is a plain `button` hidden until `group-hover`; touch devices have no reliable hover, so session deletion may be undiscoverable or inaccessible on iPhone, and the tap target is far below 44px. Suggested fix: show a visible overflow/menu or swipe/action button on mobile, using an existing dropdown/dialog primitive rather than a custom gesture system. Confidence: high.
2. `web/src/components/Sidebar.tsx:57-58` and `web/src/components/ui/button.tsx:12-20`, several interactive states rely on `hover:`; iOS Safari can leave hover styles sticky after taps. Suggested fix: make selected/pressed states explicit (`aria-current`, `data-state`, `active:`) and avoid hover-only affordances for required actions. Confidence: medium.
3. `web/src/components/Message.tsx:86`, markdown is always rendered with `prose prose-invert` while `web/src/index.css:57-98` defines both light and dark themes. The current HTML forces dark, so this is not visible now, but it will render incorrectly if light/system theme is enabled later. Suggested fix: use typography variables or `dark:prose-invert` only when a light theme is actually possible. Confidence: medium.
4. `web/src/components/Message.tsx:86` and `web/src/components/Message.tsx:43-47`, markdown and tool output mostly have good `max-w-none`/`overflow` handling, but there is no explicit wrapping policy for long URLs/inline code generated by `react-markdown`. Suggested fix: add a wrapper class like `[overflow-wrap:anywhere] prose-pre:max-w-full prose-code:break-words` or component overrides for links/code. Confidence: medium.
5. `web/src/components/TaskCard.tsx:101-120`, task cards are a single horizontal row with `Cancel` and `View` buttons that do not shrink; in narrow dialogs or chat bubbles they can crowd the label/status area. Suggested fix: on small screens use `flex-wrap` or a responsive `flex-col sm:flex-row` action area with 44px minimum target heights. Confidence: medium.
6. `web/src/components/TasksDialog.tsx:20` and `web/src/components/TaskCard.tsx:69`, task dialogs use centered `max-h-[80vh]` panels rather than full-height mobile sheets and do not account for safe-area insets. Suggested fix: add mobile-specific full-screen/bottom-sheet classes or safe-area-aware max-height/padding. Confidence: medium.
7. `web/index.html:2`, the app is hard-coded to `<html class="dark">`; iOS dark mode does not trigger theme changes automatically because there is no `prefers-color-scheme` handling. This is acceptable if the product intentionally always uses dark mode, but it is not system-adaptive. Suggested fix: either document “dark-only” or add a tiny theme bootstrap that follows `prefers-color-scheme` while preserving the CLAUDE.md portal guidance. Confidence: high.

## iPhone-Specific Concerns
- Notched iPhones: no `viewport-fit=cover` in `index.html:6` and no `env(safe-area-inset-*)` usage in `src/index.css` or app shells, so top/bottom spacing is not explicitly safe-area-aware.
- Home indicator: the chat composer at `Chat.tsx:56` uses plain `p-3`; it should add bottom safe-area padding before iPhone/PWA use is considered first-class.
- iOS Safari viewport quirks: `h-screen` at `App.tsx:24` and `Login.tsx:21` maps to 100vh behavior, which can be wrong with dynamic browser bars and virtual keyboard.
- Input zoom: core `Input` and `Textarea` primitives default to `text-base` on mobile (`ui/input.tsx:11`, `ui/textarea.tsx:10`), which is good, but Settings overrides some controls to `text-sm` (`Settings.tsx:63`, `Settings.tsx:73`).
- Touch targets: Button defaults are 28-36px tall (`ui/button.tsx:24-34`), below the 44pt iPhone target; small task buttons and dialog close buttons are the most obvious misses.
- Sticky hover: required affordances such as session delete are hover-gated (`Sidebar.tsx:66-68`), which is a known mismatch for touch.
- PWA/install: there is no manifest or Apple metadata, so “add to Home Screen” will be generic and not status-bar/theme aware.

## What I Could NOT Verify Without a Browser
- Actual rendered screenshots at 375px, 390px, and 430px, including whether flex min-content sizing produces horizontal scroll or just extreme squeezing.
- iOS Safari behavior when the software keyboard opens over the chat composer and Settings persona textarea.
- Whether Radix Dialog body scroll locking, focus trapping, and centered transforms behave acceptably on iPhone Safari with the current content lengths.
- Computed Tailwind v4 output for all arbitrary classes and any class conflict resolution beyond code inspection of `twMerge` usage.
- Real PWA standalone behavior, status-bar color, and safe-area overlap, because the app currently lacks PWA metadata to test.

## Strengths
- Semantic theme tokens are used consistently in app components; I did not see raw Tailwind palette colors in the audited app files.
- The `dark` class is placed on `<html>` (`index.html:2`), which is correct for Radix portals, and `color-scheme` is declared for both theme blocks (`index.css:57-99`).
- Core `Input` and `Textarea` primitives use `text-base` on mobile (`ui/input.tsx:11`, `ui/textarea.tsx:10`), avoiding iOS focus zoom in the main login/chat composer paths.
- Several data rows correctly use `min-w-0` with truncation (`Settings.tsx:100-112`, `TaskCard.tsx:103-112`), reducing overflow risk in list content.
- Tool output uses scrollable/wrapping `pre` elements (`Message.tsx:43-47`), so large tool payloads are at least partially constrained.

## Suggested Next Steps
1. Fix the mobile shell first: hide/collapse the 18rem sidebar below `md`, add a hamburger + shadcn/Radix Sheet drawer, and give chat a full-width `min-w-0` mobile layout.
2. Replace `h-screen` app/login shells with dynamic viewport units and add safe-area-aware padding to the chat composer and dialogs.
3. Raise mobile touch targets for primary buttons, icon buttons, task actions, and dialog close controls to at least 44px using responsive Tailwind classes.
4. Make Settings/Tasks dialogs mobile-safe: scrollable max-height using `100dvh` and safe-area env vars, or full-screen/bottom-sheet behavior below `sm`.
5. Add minimal iPhone/PWA metadata: `viewport-fit=cover`, manifest, Apple touch icon, theme-color, and status-bar style; then run an actual Safari/iPhone smoke test at 375/390/430 widths.
