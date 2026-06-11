# UI Audit — Gemini 3.5 Flash

## Verdict
NEEDS-WORK — While the codebase is extremely well-factored and cleanly styled using Tailwind v4 and semantic theme tokens, it is built exclusively for desktop layouts and completely lacks responsive mechanics or iPhone viewport adjustments.

## Critical Issues (mobile-breaks-the-app)
1. **`src/App.tsx:24` (Main layout locks desktop side-by-side with no mobile visibility toggle)**
   * **Problem:** The root container uses `flex h-screen bg-background text-foreground` and embeds both the `<Sidebar>` (fixed width of `w-72 shrink-0`) and the `<Chat>` (using `flex flex-1 flex-col`) side-by-side. On any mobile breakpoint (375px to 430px), the sidebar takes up `288px` (77% to 67% of screen width), leaving only `87px` to `142px` for the chat column. It is completely unusable on mobile and breaks layout immediately.
   * **Suggested Fix:** Make the `<Sidebar>` a responsive drawer/sheet on mobile, or conditionally render it using state. Alternatively, introduce a state `sidebarOpen` in `App.tsx` and hide the sidebar off-screen or overlay it using tailwind utility classes (`hidden md:flex`, or transition classes with absolute positioning). Adding a simple mobile-responsive toggle button in the header of `<Chat>` to slide the sidebar open is essential.
   * **Confidence:** High (code explicitly renders them side-by-side on all screen widths).

2. **`index.html:6` (Missing `viewport-fit=cover` and iOS viewport safety declarations)**
   * **Problem:** The viewport meta tag is currently defined as `<meta name="viewport" content="width=device-width, initial-scale=1.0" />`. It lacks the `viewport-fit=cover` instruction required to render page content edge-to-edge behind the notch and home indicator on modern iPhones.
   * **Suggested Fix:** Update the tag to `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />`.
   * **Confidence:** High (explicitly inspected `index.html` line 6).

3. **`src/components/Login.tsx:21` and `src/App.tsx:24` (The use of `h-screen` causes content truncation in iOS Safari)**
   * **Problem:** Both containers use `h-screen` (which resolves to standard `100vh`). On iOS Safari, `100vh` doesn't account for the dynamic top address bar and bottom navigation bar, leading to the bottom of the chat composer, send button, or dialog footer being clipped or hidden beneath the browser UI.
   * **Suggested Fix:** Replace `h-screen` with `h-dvh` (Dynamic Viewport Height, fully supported in Tailwind v4 and modern iOS Safari).
   * **Confidence:** High (code uses raw `h-screen` which is a known iOS viewport anti-pattern).

4. **`src/components/ui/dialog.tsx:62` (Modals use awkward centered box styling instead of drawer-style bottom sheet or full-screen on mobile)**
   * **Problem:** The default dialog primitive relies on `max-w-[calc(100%-2rem)]` and positions itself exactly at the center (`top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2`). For complex content like the Settings persona block or Task transcripts on narrow mobile viewports, this small centered rectangle is extremely cramped, hard to scroll, and cuts off key content.
   * **Suggested Fix:** Modify `DialogContent` layout for mobile: use `sm:max-w-2xl sm:top-1/2 sm:left-1/2` while defaulting on mobile to a bottom-sheet styled layout or full-screen overlay (`bottom-0 top-auto translate-y-0 left-0 right-0 max-w-full rounded-b-none rounded-t-xl h-[85vh]` or similar).
   * **Confidence:** High (code uses standard centered fixed alignment for all viewports).

## High Priority (degrades mobile UX significantly)
1. **`src/components/ui/textarea.tsx:10` (Draft chat composer triggers automatic iOS browser zoom on focus)**
   * **Problem:** Under Tailwind v4, the input and textarea primitives specify `text-base md:text-sm`. While `text-base` is `16px` (avoiding iOS zoom), the Vite/Tailwind build can resolve desktop styles incorrectly or target tablet viewports. More importantly, the select element in `Settings.tsx:73` uses `text-sm` (14px) unconditionally. When any input under `16px` is focused on iOS Safari, the browser forces a zoom, breaking layout scaling and requiring users to manually pinch-zoom back out.
   * **Suggested Fix:** Ensure all interactive input elements (including `<select>` dropdown, `<textarea>`, and `<input>`) have a minimum text size of `16px` (`text-base`) on mobile viewports. Change `<select>` in `Settings.tsx:73` from `text-sm` to `text-base md:text-sm`.
   * **Confidence:** High.

2. **`src/components/Sidebar.tsx:57` (Delete session hover trigger is unreachable on touch devices)**
   * **Problem:** The session delete action is a button (`×`) that is hidden by default and only shown on hover: `className="hidden ... group-hover:block"`. Since iOS touch devices do not have a true "hover" state, users cannot easily trigger the delete button without awkward tap behaviors, or they may find hover states getting "stuck" when tapping items.
   * **Suggested Fix:** Provide an alternative touch-friendly action trigger for mobile, or make the delete button always visible on mobile viewports (using `block md:hidden group-hover:block`).
   * **Confidence:** High (explicit css class layout checked).

3. **`src/components/ui/button.tsx:31` (Touch targets are below Apple HIG 44pt standard)**
   * **Problem:** Default buttons are sized with `h-8` (`32px`) and small icons are `size-8` (`32px`). This makes the critical action buttons (e.g. New Chat, cancel buttons, settings cog, and task view links) small and difficult to hit accurately with thumbs, violating the Apple Human Interface Guidelines.
   * **Suggested Fix:** Increase minimum target size on touch devices or mobile breakpoints. We can adjust the default size of buttons on mobile to be `h-10` or `h-11` (or apply padding to increase touch target bounds to a minimum of 44px without changing background visual size).
   * **Confidence:** High (explicit code dimensions measured).

## Medium Priority (rough edges)
1. **`src/components/Message.tsx:43` (Preformatted blocks overflow and break chat boundaries)**
   * **Problem:** `ToolCallCard` renders arguments and results inside `<pre className="overflow-x-auto whitespace-pre-wrap ...">`. However, long continuous strings, unconstrained JSON properties, or non-wrapping URLs inside user markdown and tool results can push past the parent container bounds if flexbox wrapping is missing `min-w-0` on container columns.
   * **Suggested Fix:** Ensure the enclosing layout wrappers have `min-w-0` to force flex layout calculation boundaries, and ensure markdown renders code blocks with `break-all` or safe wrapping.
   * **Confidence:** Medium (flex containers lack `min-w-0` in some nodes, which commonly causes horizontal overflow issues with markdown text contents).

2. **`src/index.css` (No dark mode automatic system sync)**
   * **Problem:** The system does not auto-toggle dark mode because `<html>` is hardcoded with `class="dark"` in `index.html`. It doesn't query media features or dynamically bind theme based on system states.
   * **Suggested Fix:** In `App.tsx` or a theme manager script, listen to `(prefers-color-scheme: dark)` and update the `document.documentElement.classList` accordingly to enable native system theme sync.
   * **Confidence:** High (hardcoded in `index.html` as `<html lang="en" class="dark">`).

## iPhone-Specific Concerns
* **Safe-Area Insets:** The layout has no handling of safety zones (`env(safe-area-inset-top)`, `env(safe-area-inset-bottom)`). This means content inside `<Chat>` (especially the absolute/relative bottom composer area) or lists inside the sidebar will overlap with the iPhone notch when in landscape mode, and collide with the Home Indicator bar at the bottom in portrait mode. Add padding adjustments like `pb-[calc(12px+env(safe-area-inset-bottom))]` to the message composer container in `Chat.tsx`.
* **PWA / Standalone Presence:** There is no Web App Manifest (`manifest.json` / `manifest.webmanifest`), no `apple-mobile-web-app-capable` meta tags, and no dedicated Apple Touch Icons. If Brian installs the site to his Home Screen, it will render within a standard Safari tab controller container with top and bottom chrome, degrading the dedicated "assistant harness" appearance.
* **Sticky hover styles on iOS:** Tap gestures on elements with `hover:bg-sidebar-accent` or buttons with `hover:bg-primary/80` will trigger a persistent hover style that remains active until the user taps somewhere else, making the interface look sluggish or unresponsive.

## What I Could NOT Verify Without a Browser
* **Keyboard adjustment and layout resizing on focus:** When focusing the `<textarea>` draft field on iOS Safari, the on-screen keyboard slides up. We cannot verify without a live browser session whether the page accurately collapses heights or if the scroll view stays pinned to the bottom.
* **Exact layout rendering at 375px:** The sidebar is guaranteed to conflict on 375px viewports based on the static widths, but the exact visual collision of content inside `<Message>` columns (the markdown bubble wrapping and tool outcome tables) needs a real screen render to fine-tune spacing and margin overlaps.
* **Scroll bounce physics:** iOS has native inertial scrolling. Scroll containers (`overflow-y-auto`) may need explicit `-webkit-overflow-scrolling: touch` testing to guarantee smooth momentum, though standard CSS handles this better in modern iOS versions.

## Strengths
* **Fluid styling tokens:** Uses standard oklch CSS theme tokens natively mapped in v4. This is clean, makes adaptive coloring simple, and has passed contrast validation tests.
* **Clean layout hierarchy:** The React component tree is beautifully organized and leverages single-directional state propagation. Converting it to a responsive mobile app requires zero business logic changes—only CSS adjustments.
* **Flexible text resizing:** The shadcn primitives use `field-sizing-content` on `<Textarea>`, which natively grows with the text size instead of relying on legacy height-calculation scripts.

## Suggested Next Steps
1. **Viewport and layout modernization:** Update `index.html` viewport meta tags to support `viewport-fit=cover`, change `h-screen` to `h-dvh` in `App.tsx` and `Login.tsx`, and map safe area paddings onto the layout.
2. **Mobile Sidebar responsive behavior:** Introduce a hamburger header to the Chat panel on viewports `< md` (under 768px wide). Turn the sidebar into a collapsible panel, an absolute drawer overlay, or use a tab bar layout.
3. **PWA Assets and Meta config:** Add a simple manifest file, configure the theme color meta tags matching the oklch variable values, and add apple-mobile-web-app headers to make Home Screen launches seamless.
4. **Interactive element refinement:** Swap touch hover triggers to explicit actions, ensure input text fields are styled with a baseline `16px` font size, and expand touch target zones on critical buttons.
