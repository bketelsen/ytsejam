import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const src = readFileSync(
  join(root, "src/components/SlashOverlay.tsx"),
  "utf8",
);

test("SlashOverlay exports a named React component", () => {
  assert.match(src, /export\s+function\s+SlashOverlay\s*\(/);
});

test("SlashOverlay accepts items/activeIndex/onSelect/onActiveChange props", () => {
  const propsDecl = src.match(/SlashOverlayProps\s*\{([\s\S]*?)\}/);
  assert.ok(propsDecl, "expected a SlashOverlayProps interface/type");
  assert.match(propsDecl[1], /\bitems\b/);
  assert.match(propsDecl[1], /\bactiveIndex\b/);
  assert.match(propsDecl[1], /\bonSelect\b/);
  assert.match(propsDecl[1], /\bonActiveChange\b/);
});

test("SlashOverlay imports RankedSkill from ./useSlashMenu", () => {
  assert.match(
    src,
    /import\s+type\s*\{[^}]*\bRankedSkill\b[^}]*\}\s*from\s*["']\.\/useSlashMenu["']/,
  );
});

test("SlashOverlay returns null when items is empty (no DOM noise)", () => {
  assert.match(src, /items\.length\s*===\s*0/);
  assert.match(src, /return\s+null/);
});

test("SlashOverlay container declares role='listbox'", () => {
  assert.match(src, /role=\{?["']listbox["']/);
});

test("SlashOverlay container is absolute-positioned above the composer", () => {
  assert.match(src, /\babsolute\b/);
  assert.match(src, /\bbottom-full\b/);
});

test("SlashOverlay rows render with role='option' and data-active reflecting activeIndex", () => {
  assert.match(src, /role=\{?["']option["']/);
  assert.match(src, /data-active=/);
  assert.match(src, /activeIndex/);
});

test("SlashOverlay row click path fires onSelect via onMouseDown (not onClick) to avoid blur race", () => {
  assert.match(src, /onMouseDown=/);
  assert.match(src, /onSelect\s*\(/);
  assert.match(src, /preventDefault\s*\(\s*\)/);
});

test("SlashOverlay row hover path fires onActiveChange via onMouseEnter", () => {
  assert.match(src, /onMouseEnter=/);
  assert.match(src, /onActiveChange\s*\(/);
});

test("SlashOverlay renders the matched trigger label for trigger-reason rows", () => {
  assert.match(src, /reason\s*===\s*["']trigger["']/);
  assert.match(src, /matchedTrigger/);
  assert.match(src, /match:/);
});
