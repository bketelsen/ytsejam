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

test("ApprovalToggle models all three modes (read_only, ask, yolo) as labels", () => {
  // A label map (or equivalent) must distinctly name every mode the server can emit.
  assert.match(src, /read_only/);
  assert.match(src, /\bask\b/);
  assert.match(src, /\byolo\b/);
  assert.match(src, /READ-ONLY/i);
  assert.match(src, /ASK/);
  assert.match(src, /YOLO/);
});

test("ApprovalToggle read_only renders as Read-only, NOT as YOLO", () => {
  // Guard against the regression where a runtime read_only value fell through to YOLO.
  assert.match(src, /read_only["']?\s*:\s*["']READ-ONLY["']/);
  assert.doesNotMatch(src, /read_only["']?\s*:\s*["']YOLO["']/i);
});

test("ApprovalToggle cycles in escalation order, wrapping yolo -> read_only", () => {
  // Clicking advances to the next mode; the safest -> most permissive -> wrap cycle.
  assert.match(src, /read_only["']?\s*:\s*["']ask["']/);
  assert.match(src, /ask["']?\s*:\s*["']yolo["']/);
  assert.match(src, /yolo["']?\s*:\s*["']read_only["']/);
});

test("ApprovalToggle click advances to the next mode via onChange(next)", () => {
  assert.match(src, /const\s+next:\s*ApprovalMode\s*=/);
  assert.match(src, /onClick=\{\(\)\s*=>\s*onChange\(next\)\}/);
});

test("ApprovalToggle uses warning-tinted classes for the YOLO state", () => {
  assert.match(src, /bg-warning\/15/);
  assert.match(src, /border-warning\/60/);
  assert.match(src, /hover:bg-warning\/25/);
});

test("ApprovalToggle uses success-tinted classes + a lock affordance for read_only", () => {
  assert.match(src, /bg-success\/15/);
  assert.match(src, /border-success\/60/);
  assert.match(src, /\bLock\b/); // lucide lock icon signals the locked / read-only state
});

test("ApprovalToggle uses subdued neutral classes for the ASK state", () => {
  assert.match(src, /border-border\s+text-muted-foreground\s+hover:bg-accent/);
});

test("ApprovalToggle exposes an accessible name reflecting the current mode", () => {
  assert.match(src, /aria-label=\{[^}]*\}/);
  assert.match(src, /title=\{[^}]*\}/);
  // The visible label text is decorative; AT reads the aria-label.
  assert.match(src, /aria-hidden=["']true["']/);
});

test("ApprovalToggle wires disabled prop through to the button", () => {
  assert.match(src, /disabled=\{disabled\}/);
  assert.match(src, /disabled:opacity-50/);
  assert.match(src, /disabled:pointer-events-none/);
});

test("ApprovalToggle uses the house focus-visible ring classes", () => {
  assert.match(src, /outline-none/);
  assert.match(src, /focus-visible:border-ring/);
  assert.match(src, /focus-visible:ring-3/);
  assert.match(src, /focus-visible:ring-ring\/50/);
});

test("App renders ApprovalToggle in headerRight and persists changes with setApprovalMode", () => {
  assert.match(app, /import\s+\{\s*ApprovalToggle\s*\}\s+from\s+["']\.\/components\/ApprovalToggle["']/);
  assert.match(app, /const\s+currentSession\s*=\s*useMemo\([\s\S]*?app\.sessions\.find\(\(s\)\s*=>\s*s\.id\s*===\s*app\.currentId\)/);
  assert.match(app, /const\s+currentMode:\s*ApprovalMode\s*=\s*currentSession\?\.approvalMode\s*\?\?\s*["']ask["']/);
  assert.match(app, /headerRight=\{[\s\S]*?<ApprovalToggle[\s\S]*?mode=\{currentMode\}[\s\S]*?onChange=\{\(m\)\s*=>\s*app\.currentId\s*&&\s*app\.setApprovalMode\(app\.currentId,\s*m\)\}/);
});
