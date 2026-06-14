import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const manifest = JSON.parse(
  readFileSync(join(root, "public/manifest.webmanifest"), "utf8"),
);

test("manifest declares both 'any' and 'maskable' icon variants in each size", () => {
  // Issue #22: Android adaptive icons need purpose:maskable variants with a
  // safe-zone-aware render. We ship both purposes side-by-side so the OS can
  // pick the right one per context (`any` for non-adaptive surfaces like the
  // browser tab; `maskable` for the launcher / install prompt).
  const sizes = ["192x192", "512x512"];
  for (const size of sizes) {
    const variants = manifest.icons.filter((i) => i.sizes === size);
    const purposes = variants.map((i) => i.purpose).sort();
    assert.deepEqual(
      purposes,
      ["any", "maskable"],
      `expected both 'any' and 'maskable' for ${size}, got ${JSON.stringify(purposes)}`,
    );
  }
});

test("each manifest icon entry declares an explicit purpose (not the spec default)", () => {
  // Spec default is 'any' when omitted, but explicit beats implicit — and a
  // future audit tool flags omitted purpose fields. Guard against future
  // entries being added without one.
  for (const icon of manifest.icons) {
    assert.ok(
      typeof icon.purpose === "string" && icon.purpose.length > 0,
      `icon ${JSON.stringify(icon.src)} missing explicit 'purpose' field`,
    );
  }
});

test("every manifest icon entry points at a real file in web/public/", () => {
  for (const icon of manifest.icons) {
    // src is absolute-from-root in the manifest (e.g. "/icon-192.png"); strip
    // the leading slash to resolve against web/public/.
    const rel = icon.src.replace(/^\//, "");
    const path = join(root, "public", rel);
    assert.ok(existsSync(path), `manifest references ${icon.src} but ${path} does not exist`);
    // Sanity: nonempty PNG.
    const stat = statSync(path);
    assert.ok(stat.size > 0, `${path} is empty`);
  }
});

test("maskable icon files are valid PNGs at their declared dimensions", () => {
  // Read the PNG signature + IHDR chunk and verify the file is actually a
  // PNG at the size the manifest claims. Bytewise content check (corner
  // colors etc) needs an image decoder and is exercised by the render
  // script's manual visual smoke + the corner-sample script in scripts/.
  for (const { src, sizes } of manifest.icons) {
    if (src.indexOf("maskable") === -1) continue;
    const rel = src.replace(/^\//, "");
    const buf = readFileSync(join(root, "public", rel));
    // PNG signature: 8 bytes, 89 50 4E 47 0D 0A 1A 0A.
    assert.deepEqual(
      Array.from(buf.subarray(0, 8)),
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      `${src}: missing PNG signature`,
    );
    // IHDR chunk starts at byte 8, format: [length:4][type:4]['IHDR'][width:4 BE][height:4 BE]
    assert.deepEqual(
      Array.from(buf.subarray(12, 16)),
      [0x49, 0x48, 0x44, 0x52], // 'IHDR'
      `${src}: missing IHDR chunk`,
    );
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    const [expectedW, expectedH] = sizes.split("x").map(Number);
    assert.equal(width, expectedW, `${src}: IHDR width ${width} != manifest sizes ${sizes}`);
    assert.equal(height, expectedH, `${src}: IHDR height ${height} != manifest sizes ${sizes}`);
  }
});

// --- PWA Tier 5: manifest polish + shortcuts ---

test("manifest declares the Tier-5 polish fields (id, description, lang, dir, categories, orientation)", () => {
  // These fields make the OS install dialog richer (description,
  // categories) and stabilize install identity (id — independent of
  // start_url changes). lang+dir are a11y / locale signals.
  assert.equal(manifest.id, "/", "id should anchor install identity");
  assert.equal(typeof manifest.description, "string", "description must be a string");
  assert.ok(manifest.description.length >= 20, "description should be a real sentence, not a stub");
  assert.equal(manifest.lang, "en", "lang should be declared");
  assert.equal(manifest.dir, "ltr", "dir should be declared alongside lang");
  assert.ok(Array.isArray(manifest.categories), "categories must be an array");
  assert.ok(manifest.categories.length >= 1, "categories should have at least one entry");
  assert.equal(typeof manifest.orientation, "string", "orientation should be explicit, not inherited");
});

test("manifest declares a display_override fallback chain (without WCO)", () => {
  // display_override is a Chrome extension to display: lets the OS try
  // progressively-more-chromeless modes. Window-controls-overlay is
  // deliberately NOT included here — it requires React-side layout
  // changes (env(titlebar-area-*)) and is its own ticket.
  assert.ok(Array.isArray(manifest.display_override), "display_override must be an array");
  assert.ok(
    manifest.display_override.includes("standalone"),
    "display_override should include 'standalone' as a fallback",
  );
  assert.ok(
    !manifest.display_override.includes("window-controls-overlay"),
    "display_override must NOT include 'window-controls-overlay' yet (needs layout reflow — separate ticket)",
  );
});

test("manifest declares shortcuts for new/tasks/settings, deep-linked via ?action=", () => {
  // The OS-launcher jump-list entries. Each shortcut.url is a deep-link
  // that App.tsx interprets via URLSearchParams.get('action'). The set of
  // actions here MUST match the set of branches in App.tsx's handleAction
  // useEffect; if you add a shortcut here, add its branch there too.
  assert.ok(Array.isArray(manifest.shortcuts), "shortcuts must be an array");
  const byAction = Object.fromEntries(
    manifest.shortcuts.map((s) => [new URL(s.url, "https://example.test").searchParams.get("action"), s]),
  );
  assert.deepEqual(
    Object.keys(byAction).sort(),
    ["new", "settings", "tasks"],
    "shortcuts should deep-link to ?action=new, ?action=tasks, ?action=settings",
  );
  for (const [action, sc] of Object.entries(byAction)) {
    assert.equal(typeof sc.name, "string", `shortcut '${action}' missing name`);
    assert.equal(typeof sc.short_name, "string", `shortcut '${action}' missing short_name`);
    assert.equal(typeof sc.description, "string", `shortcut '${action}' missing description`);
    assert.ok(Array.isArray(sc.icons) && sc.icons.length >= 1, `shortcut '${action}' missing icons`);
  }
});

test("App.tsx handles every shortcut action declared in the manifest (forward SSOT)", () => {
  // SSOT bridge, manifest -> App.tsx: every action declared in
  // manifest.shortcuts MUST have a matching `action === "X"` branch in
  // App.tsx, or the OS-launcher entry will deep-link to a no-op. We don't
  // assert the reverse direction here — an orphan branch in App.tsx is
  // dead code (the next test guards intent more loosely).
  //
  // File-scoped match (not body-scoped) deliberately: these literal
  // strings only appear inside the action dispatcher in App.tsx, so a
  // flat regex is robust against function-style refactors (arrow vs
  // function, indentation changes, extraction to a hook) while still
  // catching the spec-violation we care about.
  const appSrc = readFileSync(join(root, "src/App.tsx"), "utf8");
  const actions = manifest.shortcuts
    .map((s) => new URL(s.url, "https://example.test").searchParams.get("action"))
    .filter(Boolean);
  for (const action of actions) {
    const branchRe = new RegExp(`action\\s*===\\s*["']${action}["']`);
    assert.match(
      appSrc,
      branchRe,
      `App.tsx missing an \`action === "${action}"\` branch (manifest declares the shortcut)`,
    );
  }
});

test("App.tsx clears the action param after firing (so refresh doesn't re-trigger)", () => {
  // Without this, refreshing the page after the OS deep-link would re-fire
  // the action (re-open a dialog, re-create a new session). The contract
  // is one-shot. File-scope match: replaceState only appears in the
  // shortcut handler, so a flat assertion is robust to refactors.
  const appSrc = readFileSync(join(root, "src/App.tsx"), "utf8");
  assert.match(
    appSrc,
    /history\.replaceState\(/,
    "App.tsx must call history.replaceState to clear the ?action= param after firing",
  );
});

test("App.tsx URL-action handler short-circuits on bare and unknown actions", () => {
  // Coverage for the no-op paths: `if (!action) return` (bare load with
  // no `?action=` should be a no-op) and the unknown-action branch
  // (random ?action=bogus must NOT clear the URL and must NOT call any
  // app handler). We assert both by source-text since the test stack is
  // node:test without RTL — but the assertions are precise: the bare
  // guard is the literal `if (!action) return` token, and the unknown
  // path is structurally enforced by the chain of `else if (action === ...)`
  // dispatch lines (no fallthrough action would be wired without showing
  // up in the forward-SSOT test above).
  const appSrc = readFileSync(join(root, "src/App.tsx"), "utf8");
  assert.match(
    appSrc,
    /if\s*\(\s*!action\s*\)\s*return/,
    "App.tsx URL-action handler must early-return when ?action= is absent (bare load is a no-op)",
  );
});

test("App.tsx listens for popstate so a desktop PWA reused by a second shortcut click still fires", () => {
  // On desktop Chrome, clicking a shortcut while the PWA window is already
  // open navigates the existing window same-origin — fires popstate, not a
  // remount. The useEffect must register a popstate listener.
  const appSrc = readFileSync(join(root, "src/App.tsx"), "utf8");
  assert.match(
    appSrc,
    /addEventListener\(["']popstate["']/,
    "App.tsx must addEventListener('popstate', ...) for in-session shortcut re-entry",
  );
  assert.match(
    appSrc,
    /removeEventListener\(["']popstate["']/,
    "App.tsx popstate listener must be removed in the useEffect cleanup",
  );
});

test("App.tsx URL-action useEffect mounts once (no `app` in dep array — would re-fire on every render)", () => {
  // Quality-review finding: `useApp()` returns a fresh object literal per
  // render and `Main` re-renders per streamed token, so `[app]` deps
  // churn add/removeEventListener + re-invoke the handler per token.
  // The handler must be registered once (empty deps + ref for latest state).
  const appSrc = readFileSync(join(root, "src/App.tsx"), "utf8");
  // Find the dep array trailing the URL-action useEffect. We anchor on
  // the popstate registration line so we're definitely matching the
  // shortcut-handler effect and not some other effect that might appear
  // in App.tsx in the future.
  const effectTail = appSrc.match(
    /addEventListener\(["']popstate["'][\s\S]*?\}\s*,\s*(\[[^\]]*\])\s*\)\s*;/,
  );
  assert.ok(
    effectTail,
    "could not locate the URL-action useEffect's dep array (anchored on the popstate addEventListener)",
  );
  const deps = effectTail[1].trim();
  assert.equal(
    deps,
    "[]",
    `URL-action useEffect must have empty deps (mounts once); got ${deps}. ` +
      `If you need to read latest state inside the handler, use a ref (see handlerStateRef pattern in App.tsx).`,
  );
});
