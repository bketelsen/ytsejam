import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const app = readFileSync(join(root, "src/App.tsx"), "utf8");
const sidebar = readFileSync(join(root, "src/components/Sidebar.tsx"), "utf8");
const quakeTerminal = readFileSync(join(root, "src/components/QuakeTerminal.tsx"), "utf8");
const terminalWs = readFileSync(join(root, "src/lib/terminal-ws.ts"), "utf8");

test("App imports and renders QuakeTerminal with terminalOpen state", () => {
  assert.match(app, /import\s*\{\s*QuakeTerminal\s*\}\s*from\s*["']\.\/components\/QuakeTerminal["']/);
  assert.match(app, /const\s*\[\s*terminalOpen\s*,\s*setTerminalOpen\s*\]\s*=\s*useState\s*\(\s*false\s*\)/);
  assert.match(app, /<QuakeTerminal\s+open=\{terminalOpen\}\s+onOpenChange=\{setTerminalOpen\}/);
});

test("App registers Ctrl+backtick and Ctrl+tilde hotkey with preventDefault", () => {
  assert.match(app, /addEventListener\s*\(\s*["']keydown["']/);
  assert.match(app, /e\.ctrlKey/);
  assert.match(app, /e\.key\s*===\s*["']`["']/);
  assert.match(app, /e\.key\s*===\s*["']~["']/);
  assert.match(app, /e\.preventDefault\s*\(\s*\)/);
  assert.match(app, /setTerminalOpen\s*\(\s*\(\s*open\s*\)\s*=>\s*!open\s*\)/);
});

test("Sidebar exposes an Open terminal icon button", () => {
  assert.match(sidebar, /import\s*\{[^}]*\bTerminal\b[^}]*\}\s*from\s*["']lucide-react["']/);
  assert.match(sidebar, /onOpenTerminal:\s*\(\)\s*=>\s*void/);
  assert.match(sidebar, /onClick=\{onOpenTerminal\}/);
  assert.match(sidebar, /aria-label=["']Open terminal["']/);
  assert.match(sidebar, /<Terminal\s+className=["']size-4["']/);
});

test("QuakeTerminal uses a top Sheet with xterm and FitAddon", () => {
  assert.match(quakeTerminal, /import\s*\{\s*FitAddon\s*\}\s*from\s*["']@xterm\/addon-fit["']/);
  assert.match(quakeTerminal, /import\s*\{\s*Terminal\s*\}\s*from\s*["']@xterm\/xterm["']/);
  assert.match(quakeTerminal, /@xterm\/xterm\/css\/xterm\.css/);
  assert.match(quakeTerminal, /<Sheet\s+open=\{open\}\s+onOpenChange=\{onOpenChange\}/);
  assert.match(quakeTerminal, /<SheetContent[\s\S]*side=["']top["']/);
  assert.match(quakeTerminal, /new\s+Terminal\s*\(/);
  assert.match(quakeTerminal, /new\s+FitAddon\s*\(/);
  assert.match(quakeTerminal, /connectTerminalWs\s*\(/);
  assert.match(quakeTerminal, /terminal\.onData/);
  assert.match(quakeTerminal, /terminal\.onResize/);
});

test("QuakeTerminal keeps sheet padding outside the xterm fit target", () => {
  assert.match(quakeTerminal, /className=["']h-\[min\(70dvh,42rem\)\] gap-0 overflow-hidden/);
  assert.match(quakeTerminal, /<div className=["']min-h-0 flex-1 overflow-hidden px-3 pb-3 pt-12["']>/);
  assert.match(quakeTerminal, /<div ref=\{setContainerElement\} className=["']h-full min-h-0 overflow-hidden["'] \/>/);
  assert.doesNotMatch(quakeTerminal, /ref=\{setContainerElement\}[^\n]*className=["'][^"']*(?:\bpx-|\bpy-|\bpt-|\bpb-|\bpl-|\bpr-)/);
});

test("terminal-ws connects to the terminal endpoint and forwards output and exit frames", () => {
  assert.match(terminalWs, /\/api\/terminal\/ws\?token=/);
  assert.match(terminalWs, /encodeURIComponent\s*\(\s*getToken\(\)\s*\?\?\s*["']["']\s*\)/);
  assert.match(terminalWs, /msg\.type\s*===\s*["']output["']/);
  assert.match(terminalWs, /handlers\.onOutput\s*\(\s*msg\.data\s*\)/);
  assert.match(terminalWs, /msg\.type\s*===\s*["']exit["']/);
  assert.match(terminalWs, /handlers\.onExit\s*\(/);
  assert.match(terminalWs, /type:\s*["']input["']/);
  assert.match(terminalWs, /type:\s*["']resize["']/);
});
