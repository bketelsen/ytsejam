import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const src = readFileSync(join(root, "src/components/Sidebar.tsx"), "utf8");

const activeSessionRender = src.match(/\{sessions\.map\(\(s\)\s*=>\s*\([\s\S]*?\n\s*\)\)\}/)?.[0] ?? "";
const archivedSessionRender = src.match(/\{archivedRows\.map\(\(s\)\s*=>\s*\([\s\S]*?\n\s*\)\)\}/)?.[0] ?? "";

test("Sidebar active session rows check for YOLO approval mode", () => {
  assert.match(activeSessionRender, /s\.approvalMode\s*===\s*["']yolo["']/);
});

test("Sidebar active session rows use warning-themed left rail accent for YOLO", () => {
  assert.match(activeSessionRender, /\bborder-l-2\b/);
  assert.match(activeSessionRender, /\bborder-warning\b/);
});

test("Sidebar YOLO warning tint is scoped to the active session list", () => {
  assert.ok(activeSessionRender, "expected to find sessions.map render block");
  assert.ok(archivedSessionRender, "expected to find archivedRows.map render block");
  assert.doesNotMatch(archivedSessionRender, /approvalMode\s*===\s*["']yolo["']|\bborder-warning\b/);
});

test("Sidebar yolo tint/announce must never leak to read_only sessions", () => {
  // The warning rail + '(approvals off)' note must stay gated on a STRICT yolo
  // equality. Guard against (a) a broadened check like `!== "ask"` that would also
  // catch read_only, and (b) explicitly styling/announcing read_only as yolo —
  // either would mislabel a SECURITY mode in the session list.
  assert.doesNotMatch(activeSessionRender, /approvalMode\s*!==\s*["']ask["']/);
  assert.doesNotMatch(
    activeSessionRender,
    /approvalMode\s*===\s*["']read_only["'][\s\S]*?(border-warning|approvals off)/,
  );
});

test("YOLO row exposes state to assistive tech via sr-only", () => {
  assert.ok(activeSessionRender, "expected to find sessions.map render block");
  assert.ok(
    /s\.approvalMode\s*===\s*["']yolo["'][\s\S]*?sr-only[\s\S]*?\(approvals off\)/.test(activeSessionRender),
    "expected sr-only '(approvals off)' under YOLO condition",
  );
});
