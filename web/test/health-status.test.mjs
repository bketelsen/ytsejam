import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const useApp = readFileSync(join(root, "src/useApp.ts"), "utf8");
const ws     = readFileSync(join(root, "src/lib/ws.ts"), "utf8");
const types  = readFileSync(join(root, "src/lib/types.ts"), "utf8");
const api    = readFileSync(join(root, "src/lib/api.ts"), "utf8");
const chat   = readFileSync(join(root, "src/components/Chat.tsx"), "utf8");
const app    = readFileSync(join(root, "src/App.tsx"), "utf8");

test("types.ts exports LtmHealth with reachable, consecutiveFailures, and optional lastError", () => {
  assert.match(types, /export\s+interface\s+LtmHealth\s*\{/);
  assert.match(types, /reachable:\s*boolean/);
  assert.match(types, /consecutiveFailures:\s*number/);
  assert.match(types, /lastError\?:\s*\{\s*message:\s*string;\s*at:\s*string;?\s*\}/);
});

test("api.ts adds client.getMemoryHealth returning { ltm: LtmHealth | null }", () => {
  assert.match(api, /getMemoryHealth\s*:\s*\(\s*\)\s*=>/);
  assert.match(api, /\/api\/memory\/health/);
  assert.match(api, /\{\s*ltm:\s*LtmHealth\s*\|\s*null\s*\}/);
});

test("ws.ts onStatus signature is unchanged (still passes boolean)", () => {
  assert.match(ws, /onStatus:\s*\(\s*connected:\s*boolean\s*\)\s*=>\s*void/);
});

test("types.ts owns the HealthState union (single source of truth — issue #117)", () => {
  // The component (HealthIcon) and the hook (useApp) used to declare HealthState
  // independently; both now import from here so adding a fourth state takes one
  // edit, not two. health-icon.test.mjs + the useApp import assertion below
  // verify both consumers actually consume from lib/types.
  assert.match(types, /export\s+type\s+HealthState\s*=\s*["']unknown["']\s*\|\s*["']ok["']\s*\|\s*["']bad["']/);
});

test("useApp imports HealthState from ./lib/types and declares the LTM threshold + poll interval constants", () => {
  assert.match(useApp, /import\s+type\s*\{[^}]*\bHealthState\b[^}]*\}\s*from\s*["']\.\/lib\/types["']/);
  // Local re-declaration must be gone.
  assert.doesNotMatch(useApp, /export\s+type\s+HealthState\b/);
  assert.match(useApp, /const\s+LTM_UNHEALTHY_THRESHOLD\s*=\s*3/);
  assert.match(useApp, /const\s+LTM_POLL_MS\s*=\s*10_?000/);
});

test("useApp tracks wsState (replaces the old boolean `connected`) and seeds it to 'unknown'", () => {
  assert.match(useApp, /useState<HealthState>\(["']unknown["']\)/);
  assert.match(useApp, /setWsState\(c\s*\?\s*["']ok["']\s*:\s*["']bad["']\)/);
  // The old `setConnected` callback wiring must be gone.
  assert.doesNotMatch(useApp, /setConnected/);
});

test("useApp tracks ltmState + ltmLastError and runs a polling effect", () => {
  assert.match(useApp, /\[ltmState,\s*setLtmState\]/);
  assert.match(useApp, /\[ltmLastError,\s*setLtmLastError\]/);
  // tri-state derivation: reachable=false OR consecutiveFailures >= threshold => bad
  assert.match(useApp, /!\s*[A-Za-z_$][A-Za-z0-9_$]*\.reachable/);
  assert.match(useApp, /consecutiveFailures\s*>=\s*LTM_UNHEALTHY_THRESHOLD/);
  // null branch -> unknown
  assert.match(useApp, /setLtmState\(["']unknown["']\)/);
  // poll interval wired up
  assert.match(useApp, /setInterval\([^,]+,\s*LTM_POLL_MS\)/);
  // in-flight cancellation guard around state sets (catches post-unmount writes
  // / stale-overwrite regressions if a future refactor deletes the guard)
  assert.match(useApp, /if\s*\(\s*cancelled\s*\)\s*return/);
  assert.match(useApp, /if\s*\(\s*!cancelled\s*\)/);
  // cleanup
  assert.match(useApp, /clearInterval/);
});

test("useApp return value exposes wsState, ltmState, ltmLastError (and drops `connected`)", () => {
  // The returned object literal must list the three new fields.
  assert.match(useApp, /\bwsState\b/);
  assert.match(useApp, /\bltmState\b/);
  assert.match(useApp, /\bltmLastError\b/);
  // The old boolean is gone from the return statement.
  assert.doesNotMatch(useApp, /^\s*connected,?\s*$/m);
});

test("Chat declares a headerRight prop and renders it in an always-visible header strip", () => {
  assert.match(chat, /headerRight\?\:\s*React\.ReactNode/);
  // The <header> element no longer hides at desktop (md:hidden was removed from <header>).
  const headerOpen = chat.match(/<header\b[^>]*>/);
  assert.ok(headerOpen, "Chat must still render a <header>");
  assert.doesNotMatch(headerOpen[0], /md:hidden/);
  // Burger button keeps md:hidden so it stays mobile-only.
  assert.match(
    chat,
    /<Button[^>]*onClick=\{onMenuClick\}[^>]*className=["'][^"']*\bmd:hidden\b[^"']*["']/
  );
  // headerRight slot rendered ml-auto
  assert.match(chat, /\{headerRight\s*&&\s*<div\s+className=["'][^"']*\bml-auto\b/);
});

test("App.tsx renders both HealthIcons and passes them via headerRight", () => {
  assert.match(app, /import\s*\{\s*HealthIcon\s*\}\s*from\s*["']\.\/components\/HealthIcon["']/);
  assert.match(app, /<HealthIcon\s+kind=["']ws["']/);
  assert.match(app, /<HealthIcon\s+kind=["']ltm["']/);
  assert.match(app, /headerRight=\{/);
  // Tooltip strings present in App.tsx
  assert.match(app, /WebSocket:\s*connecting/);
  assert.match(app, /WebSocket:\s*connected/);
  assert.match(app, /WebSocket:\s*disconnected/);
  assert.match(app, /LTM:\s*status unknown/);
  assert.match(app, /LTM:\s*healthy/);
});
