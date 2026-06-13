import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const sidebar = readFileSync(join(root, "src/components/Sidebar.tsx"), "utf8");
const chat = readFileSync(join(root, "src/components/Chat.tsx"), "utf8");
const app = readFileSync(join(root, "src/App.tsx"), "utf8");
const useApp = readFileSync(join(root, "src/useApp.ts"), "utf8");
const types = readFileSync(join(root, "src/lib/types.ts"), "utf8");

test("ServerEvent union includes compaction_start and compaction_end variants", () => {
  assert.match(types, /type:\s*["']compaction_start["']/);
  assert.match(types, /type:\s*["']compaction_end["']/);
  assert.match(types, /trigger:\s*["']proactive["']\s*\|\s*["']reactive["']/);
  assert.match(
    types,
    /status:\s*["']succeeded["']\s*\|\s*["']surrendered["']\s*\|\s*["']failed["']/,
  );
});

test("SessionRow exposes a compacting field", () => {
  assert.match(types, /compacting\??:\s*boolean/);
});

test("useApp reducer handles compaction_start / compaction_end", () => {
  assert.match(useApp, /event\.type\s*===\s*["']compaction_start["']/);
  assert.match(useApp, /event\.type\s*===\s*["']compaction_end["']/);
  assert.match(useApp, /compacting:\s*true/);
  assert.match(useApp, /compacting:\s*false/);
});

test("Sidebar renders amber bg-warning dot when compacting, prefers it over running", () => {
  assert.match(sidebar, /s\.compacting/);
  assert.match(sidebar, /bg-warning/);
  const compactingIdx = sidebar.indexOf("s.compacting");
  const runningIdx = sidebar.indexOf("s.running");
  assert.ok(
    compactingIdx !== -1 && runningIdx !== -1,
    "expected both s.compacting and s.running references",
  );
  assert.ok(
    compactingIdx < runningIdx,
    "compacting branch must appear before running branch (priority)",
  );
});

test("Chat declares a compacting prop and renders the compacting… pill", () => {
  assert.match(chat, /compacting:\s*boolean/);
  assert.match(chat, /\{compacting\s*&&/);
  assert.match(chat, /compacting…/);
  assert.match(chat, /text-warning/);
});

test("App.tsx passes compacting to <Chat>", () => {
  assert.match(app, /compacting=\{app\.sessions\.find/);
});
