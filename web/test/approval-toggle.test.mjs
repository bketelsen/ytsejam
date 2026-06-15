import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const src = readFileSync(join(root, "src/components/ApprovalToggle.tsx"), "utf8");
const app = readFileSync(join(root, "src/App.tsx"), "utf8");

test("ApprovalToggle exports a named React component", () => {
  assert.match(src, /export\s+function\s+ApprovalToggle\s*\(/);
});

test("ApprovalToggle props interface types mode/onChange/disabled", () => {
  const propsDecl = src.match(/interface\s+ApprovalToggleProps\s*\{([\s\S]*?)\n\}/);
  assert.ok(propsDecl, "expected an ApprovalToggleProps interface");
  assert.match(propsDecl[1], /\bmode:\s*ApprovalMode/);
  assert.match(propsDecl[1], /\bonChange:\s*\(mode:\s*ApprovalMode\)\s*=>\s*void/);
  assert.match(propsDecl[1], /\bdisabled\??:\s*boolean/);
});

test("ApprovalToggle imports ApprovalMode type from ../lib/types", () => {
  assert.match(src, /import\s+type\s*\{[^}]*\bApprovalMode\b[^}]*\}\s*from\s*["']\.\.\/lib\/types["']/);
});

test("ApprovalToggle uses switch semantics with ask as checked state", () => {
  assert.match(src, /role=["']switch["']/);
  assert.match(src, /aria-checked=\{isAsk\}/);
  assert.match(src, /const\s+isAsk\s*=\s*mode\s*===\s*["']ask["']/);
});

test("ApprovalToggle click sends the opposite mode via onChange(next)", () => {
  assert.match(src, /const\s+next:\s*ApprovalMode\s*=\s*isAsk\s*\?\s*["']yolo["']\s*:\s*["']ask["']/);
  assert.match(src, /onClick=\{\(\)\s*=>\s*onChange\(next\)\}/);
});

test("ApprovalToggle uses warning-tinted classes for YOLO state", () => {
  assert.match(src, /bg-warning\/15/);
  assert.match(src, /border-warning\/60/);
  assert.match(src, /hover:bg-warning\/25/);
});

test("ApprovalToggle uses subdued non-yellow classes for ASK state", () => {
  assert.match(src, /\?\s*["']border-border\s+text-muted-foreground\s+hover:bg-accent["']/);
});

test("ApprovalToggle wires disabled prop through to the button", () => {
  assert.match(src, /disabled=\{disabled\}/);
  assert.match(src, /disabled:opacity-50/);
  assert.match(src, /disabled:pointer-events-none/);
});

test("App renders ApprovalToggle in headerRight and persists changes with setApprovalMode", () => {
  assert.match(app, /import\s+\{\s*ApprovalToggle\s*\}\s+from\s+["']\.\/components\/ApprovalToggle["']/);
  assert.match(app, /const\s+currentSession\s*=\s*useMemo\([\s\S]*?app\.sessions\.find\(\(s\)\s*=>\s*s\.id\s*===\s*app\.currentId\)/);
  assert.match(app, /const\s+currentMode:\s*ApprovalMode\s*=\s*currentSession\?\.approvalMode\s*\?\?\s*["']ask["']/);
  assert.match(app, /headerRight=\{[\s\S]*?<ApprovalToggle[\s\S]*?mode=\{currentMode\}[\s\S]*?onChange=\{\(m\)\s*=>\s*app\.currentId\s*&&\s*app\.setApprovalMode\(app\.currentId,\s*m\)\}/);
});
