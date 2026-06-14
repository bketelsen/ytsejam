import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const src = readFileSync(join(root, "src/components/Chat.tsx"), "utf8");

test("Chat imports the slash-menu hook and overlay", () => {
  assert.match(
    src,
    /import\s*\{[^}]*\buseSlashMenu\b[^}]*\}\s*from\s*["']\.\/useSlashMenu["']/,
  );
  assert.match(
    src,
    /import\s*\{[^}]*\bSlashOverlay\b[^}]*\}\s*from\s*["']\.\/SlashOverlay["']/,
  );
});

test("Chat fetches the skills list once via client.listSkills", () => {
  // Loaded into state on mount; the overlay reads from this. Allow chained
  // multi-line style: `client\n  .listSkills()`.
  assert.match(src, /client\s*\.\s*listSkills\s*\(\s*\)/);
  // The catch handler exists so a failed fetch silently degrades (overlay just stays empty).
  assert.match(src, /\.catch\(/);
});

test("Chat invokes useSlashMenu(draft, skills)", () => {
  assert.match(src, /useSlashMenu\s*\(\s*draft\s*,\s*skills\s*\)/);
});

test("Chat renders <SlashOverlay/> guarded on slash.open", () => {
  // The overlay only renders when the menu is open — keeps the DOM clean.
  // Allow an optional `(` and whitespace between `&&` and `<SlashOverlay`
  // because the standard React idiom is `{slash.open && (\n  <SlashOverlay`.
  assert.match(src, /slash\.open\s*&&\s*\(?\s*<SlashOverlay/);
});

test("Chat passes the slash menu state into SlashOverlay", () => {
  assert.match(src, /items=\{slash\.items\}/);
  assert.match(src, /activeIndex=\{slash\.activeIndex\}/);
  assert.match(src, /onSelect=\{/);
  assert.match(src, /onActiveChange=\{slash\.setActiveIndex\}/);
});

test("Chat's textarea container is position-relative so the overlay can absolute-position above it", () => {
  assert.match(src, /className=["']relative["']/);
});

test("Chat onKeyDown intercepts ArrowDown/ArrowUp/Enter/Tab/Escape when slash.open", () => {
  assert.match(src, /slash\.open/);
  for (const key of ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"]) {
    assert.match(src, new RegExp(`["']${key}["']`), `missing key handler for ${key}`);
  }
});

test("Chat Enter while overlay open accepts the active item and prevents send", () => {
  assert.match(src, /slash\.accept\s*\(/);
  assert.match(src, /void\s+submit\s*\(\s*\)/);
});

test("Chat respects e.nativeEvent.isComposing so IME input doesn't accept early", () => {
  assert.match(src, /isComposing/);
});
