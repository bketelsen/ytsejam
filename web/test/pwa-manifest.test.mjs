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

test("App.tsx handleAction useEffect handles exactly the shortcut action set", () => {
  // SSOT bridge between manifest shortcuts and the App.tsx interpreter.
  // We pull the action set from the manifest, then assert App.tsx's
  // handleAction has a branch matching each one. Mutation-tested: if you
  // add a shortcut to the manifest without wiring its branch, this fails.
  const appSrc = readFileSync(join(root, "src/App.tsx"), "utf8");
  // Extract the handleAction function body (between `const handleAction = () => {` and the matching `};`).
  const handlerMatch = appSrc.match(/const handleAction = \(\) => \{([\s\S]*?)\n {4}\};/);
  assert.ok(handlerMatch, "App.tsx must define a `const handleAction = () => { ... };` for PWA shortcuts");
  const handlerBody = handlerMatch[1];
  // Pull manifest actions and assert each one has an `action === "X"` branch in the handler.
  const actions = manifest.shortcuts
    .map((s) => new URL(s.url, "https://example.test").searchParams.get("action"))
    .filter(Boolean);
  for (const action of actions) {
    const branchRe = new RegExp(`action === ["']${action}["']`);
    assert.match(
      handlerBody,
      branchRe,
      `App.tsx handleAction missing a branch for action='${action}' (manifest declares it)`,
    );
  }
});

test("App.tsx clears the action param after firing (so refresh doesn't re-trigger)", () => {
  // Without this, refreshing the page after the OS deep-link would re-fire
  // the action (re-open a dialog, re-create a new session). The contract
  // is one-shot.
  const appSrc = readFileSync(join(root, "src/App.tsx"), "utf8");
  const handlerMatch = appSrc.match(/const handleAction = \(\) => \{([\s\S]*?)\n {4}\};/);
  assert.ok(handlerMatch, "handleAction not found");
  assert.match(
    handlerMatch[1],
    /history\.replaceState\(/,
    "App.tsx handleAction must call history.replaceState to clear the ?action= param after firing",
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
