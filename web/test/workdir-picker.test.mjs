import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;

const apiSrc = readFileSync(join(root, "src/lib/api.ts"), "utf8");
const useAppSrc = readFileSync(join(root, "src/useApp.ts"), "utf8");
const appSrc = readFileSync(join(root, "src/App.tsx"), "utf8");
const pickerSrc = readFileSync(join(root, "src/components/WorkdirPicker.tsx"), "utf8");

// API client

test("api.ts exposes client.workdirSuggestions calling GET /api/workdirs/suggestions", () => {
  assert.match(
    apiSrc,
    /workdirSuggestions\s*:\s*\(\)\s*=>\s*api</,
  );
  assert.match(apiSrc, /\/api\/workdirs\/suggestions/);
});

test("api.ts workdirSuggestions return type includes knownProjects and recent", () => {
  assert.match(apiSrc, /knownProjects/);
  assert.match(apiSrc, /recent\s*:\s*string\[\]/);
});

// useApp.ts

test("useApp exports requestNewSession that opens the workdir picker", () => {
  assert.match(useAppSrc, /requestNewSession/);
  assert.match(useAppSrc, /setWorkdirPickerOpen\(true\)/);
});

test("useApp exports confirmNewSession that creates session with cwd", () => {
  assert.match(useAppSrc, /confirmNewSession/);
  assert.match(useAppSrc, /newSession\(pendingNewSessionModelRef\.current,\s*cwd\)/);
});

test("useApp.newSession accepts an optional cwd parameter and calls setSessionCwd", () => {
  assert.match(useAppSrc, /async\s*\(model\?\s*:\s*string,\s*cwd\?\s*:\s*string\)/);
  assert.match(useAppSrc, /client\.setSessionCwd\(session\.id,\s*cwd\)/);
});

test("useApp return value exposes workdirPickerOpen, setWorkdirPickerOpen, requestNewSession, confirmNewSession", () => {
  assert.match(useAppSrc, /workdirPickerOpen/);
  assert.match(useAppSrc, /setWorkdirPickerOpen/);
  assert.match(useAppSrc, /requestNewSession/);
  assert.match(useAppSrc, /confirmNewSession/);
});

// App.tsx

test("App.tsx imports WorkdirPicker", () => {
  assert.match(appSrc, /import\s*\{[^}]*WorkdirPicker[^}]*\}\s*from/);
});

test("App.tsx renders WorkdirPicker with open, onOpenChange, onConfirm props", () => {
  assert.match(appSrc, /<WorkdirPicker/);
  assert.match(appSrc, /app\.workdirPickerOpen/);
  assert.match(appSrc, /app\.setWorkdirPickerOpen/);
  assert.match(appSrc, /app\.confirmNewSession/);
});

test("App.tsx onNew uses requestNewSession (not newSession directly)", () => {
  assert.match(appSrc, /onNew:\s*\(\)\s*=>\s*app\.requestNewSession\(\)/);
});

test("App.tsx URL-action new uses requestNewSession (not newSession)", () => {
  assert.match(appSrc, /requestNewSession/);
  // Should NOT have `void s.newSession()` or `void app.newSession()` in action handler context
  // The handler now calls s.requestNewSession()
  assert.match(appSrc, /s\.requestNewSession\(\)/);
});

// WorkdirPicker component

test("WorkdirPicker is a named React component export", () => {
  assert.match(pickerSrc, /export\s+function\s+WorkdirPicker/);
});

test("WorkdirPicker calls client.workdirSuggestions on open", () => {
  assert.match(pickerSrc, /workdirSuggestions\(\)/);
});

test("WorkdirPicker pre-selects the most-recent entry from suggestions", () => {
  // The component sets value to recent[0] when available
  assert.match(pickerSrc, /data\.recent\[0\]/);
});

test("WorkdirPicker degrades gracefully when suggestions API fails (catch handler present)", () => {
  // Must have a .catch() so a failing endpoint doesn't block the dialog
  assert.match(pickerSrc, /\.catch\(/);
});

test("WorkdirPicker renders a free-form Input for path entry", () => {
  assert.match(pickerSrc, /<Input/);
  assert.match(pickerSrc, /placeholder=.*absolute.*path/);
});

test("WorkdirPicker uses only semantic theme color tokens (no raw palette)", () => {
  // Spot-check: no direct color palette class
  assert.doesNotMatch(pickerSrc, /\b(bg|text|border)-(red|blue|green|neutral|slate|gray|zinc|stone|amber|yellow|orange|purple|pink|indigo|cyan|teal|lime|emerald|violet|fuchsia|rose|sky)-\d+/);
});
