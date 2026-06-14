import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

// Pure-derivation behavior tests — direct .ts import (Node 22+ strips types).
const { slashMenuState, acceptSlash } = await import(
  "../src/components/slashMenu.ts"
);

const SKILLS = [
  { name: "reflect", description: "Reflect", triggers: ["reflect", "memory", "consolidate"] },
  { name: "ship", description: "Ship", triggers: ["ship", "ship it"] },
  { name: "review", description: "Review", triggers: ["review", "code review"] },
  { name: "housekeeping", description: "HK", triggers: ["housekeeping", "memory", "archive"] },
];

test("slashMenuState: empty draft → closed", () => {
  const s = slashMenuState("", SKILLS);
  assert.equal(s.open, false);
  assert.deepEqual(s.items, []);
});

test("slashMenuState: draft without leading / → closed", () => {
  const s = slashMenuState("hello", SKILLS);
  assert.equal(s.open, false);
});

test("slashMenuState: bare '/' opens with all skills alphabetically", () => {
  const s = slashMenuState("/", SKILLS);
  assert.equal(s.open, true);
  assert.deepEqual(
    s.items.map((i) => i.skill.name),
    ["housekeeping", "reflect", "review", "ship"],
  );
  assert.ok(s.items.every((i) => i.reason === "all"));
});

test("slashMenuState: name-prefix ranks above trigger-substring", () => {
  const s = slashMenuState("/re", SKILLS);
  assert.deepEqual(
    s.items.map((i) => i.skill.name),
    ["reflect", "review"],
  );
  assert.ok(s.items.every((i) => i.reason === "name"));
});

test("slashMenuState: trigger-substring matches surfaced with reason + matchedTrigger", () => {
  const s = slashMenuState("/memory", SKILLS);
  assert.deepEqual(
    s.items.map((i) => i.skill.name),
    ["housekeeping", "reflect"],
  );
  assert.ok(s.items.every((i) => i.reason === "trigger"));
  assert.ok(s.items.every((i) => i.matchedTrigger === "memory"));
});

test("slashMenuState: case-insensitive (multi-match)", () => {
  // /RE matches both reflect and review by name-prefix, same as /re.
  const upper = slashMenuState("/RE", SKILLS);
  const lower = slashMenuState("/re", SKILLS);
  assert.deepEqual(
    upper.items.map((i) => i.skill.name),
    ["reflect", "review"],
  );
  assert.deepEqual(
    upper.items.map((i) => i.skill.name),
    lower.items.map((i) => i.skill.name),
  );
});

test("slashMenuState: case-insensitive (single-match)", () => {
  // /REF only matches reflect — review does NOT start with "ref" in any case.
  const s = slashMenuState("/REF", SKILLS);
  assert.deepEqual(
    s.items.map((i) => i.skill.name),
    ["reflect"],
  );
});

test("slashMenuState: whitespace in draft closes the menu", () => {
  assert.equal(slashMenuState("/ref hello", SKILLS).open, false);
});

test("slashMenuState: newline in draft closes the menu", () => {
  assert.equal(slashMenuState("/ref\n", SKILLS).open, false);
});

test("acceptSlash: returns '/<name> ' (trailing space)", () => {
  assert.equal(acceptSlash("reflect"), "/reflect ");
});

// Source-inspection: the React wrapper exists and uses the pure derivation.
const hookSrc = readFileSync(
  join(root, "src/components/useSlashMenu.ts"),
  "utf8",
);

test("useSlashMenu wrapper imports the pure derivation from ./slashMenu", () => {
  assert.match(
    hookSrc,
    /import\s*\{[^}]*\bslashMenuState\b[^}]*\}\s*from\s*["']\.\/slashMenu["']/,
  );
});

test("useSlashMenu wrapper manages activeIndex with useState", () => {
  assert.match(hookSrc, /useState<number>\(0\)|useState\(0\)/);
});

test("useSlashMenu wrapper clamps activeIndex when items shrink", () => {
  assert.match(hookSrc, /useEffect\(/);
  assert.match(hookSrc, /items\.length/);
});
