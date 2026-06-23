import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const types = readFileSync(join(root, "src/lib/types.ts"), "utf8");
const useApp = readFileSync(join(root, "src/useApp.ts"), "utf8");
const api = readFileSync(join(root, "src/lib/api.ts"), "utf8");
const message = readFileSync(join(root, "src/components/Message.tsx"), "utf8");

test("ApprovalMode type matches the server: yolo | ask | read_only", () => {
  const decl = types.match(/export\s+type\s+ApprovalMode\s*=\s*([^;]+);/);
  assert.ok(decl, "expected an ApprovalMode type alias");
  assert.match(decl[1], /["']yolo["']/);
  assert.match(decl[1], /["']ask["']/);
  assert.match(decl[1], /["']read_only["']/);
});

test("approval_mode_changed ServerEvent carries an ApprovalMode", () => {
  assert.match(
    types,
    /type:\s*["']approval_mode_changed["'];\s*sessionId:\s*string;\s*mode:\s*ApprovalMode/,
  );
});

test("useApp handles approval_mode_changed by setting the session approvalMode from the event", () => {
  // A runtime change from any client (or the server) must update the displayed mode live.
  assert.match(
    useApp,
    /event\.type\s*===\s*["']approval_mode_changed["'][\s\S]*?approvalMode:\s*event\.mode/,
  );
});

test("setApprovalMode optimistically updates then PATCHes the session (any of the 3 modes)", () => {
  assert.match(useApp, /setApprovalMode\s*=\s*useCallback\(async\s*\(sessionId:\s*string,\s*mode:\s*ApprovalMode\)/);
  assert.match(useApp, /client\.setSessionApprovalMode\(sessionId,\s*mode\)/);
});

test("api setSessionApprovalMode sends the mode to the server over the typed endpoint", () => {
  assert.match(api, /setSessionApprovalMode:\s*\(id:\s*string,\s*approvalMode:\s*ApprovalMode\)/);
  assert.match(api, /JSON\.stringify\(\{\s*approvalMode\s*\}\)/);
});

test("tool card flags an auto-denied (read-only) call so it does not read as success", () => {
  // The read_only denial result carries details.approval === "deny" but is NOT isError.
  assert.match(message, /details\s*as\s*\{\s*approval\?:\s*string\s*\}/);
  assert.match(message, /approval\s*===\s*["']deny["']/);
  assert.match(message, /deniedApproval\b/);
  assert.match(message, />denied<\/span>/);
});
