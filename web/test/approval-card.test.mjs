import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const src = readFileSync(join(root, "src/components/ApprovalCard.tsx"), "utf8");
const chat = readFileSync(join(root, "src/components/Chat.tsx"), "utf8");
const app = readFileSync(join(root, "src/App.tsx"), "utf8");

test("ApprovalCard exports a named React component", () => {
  assert.match(src, /export\s+function\s+ApprovalCard\s*\(/);
});

test("ApprovalCard accepts request/onRespond/disabled/ttlSeconds props", () => {
  const propsDecl = src.match(/interface\s+ApprovalCardProps\s*\{([\s\S]*?)\n\}/);
  assert.ok(propsDecl, "expected an ApprovalCardProps interface");
  assert.match(propsDecl[1], /\brequest:\s*ApprovalRequest/);
  assert.match(propsDecl[1], /\bonRespond:\s*\(decision:\s*["']approve["']\s*\|\s*["']deny["']\)\s*=>\s*void/);
  assert.match(propsDecl[1], /\bdisabled\??:\s*boolean/);
  assert.match(propsDecl[1], /\bttlSeconds\??:\s*number/);
  assert.match(src, /ttlSeconds\s*=\s*300/);
});

test("ApprovalCard imports ApprovalRequest type from ../lib/types", () => {
  assert.match(src, /import\s+type\s*\{[^}]*\bApprovalRequest\b[^}]*\}\s*from\s*["']\.\.\/lib\/types["']/);
});

test("ApprovalCard renders tool name and label from the request", () => {
  assert.match(src, /request\.toolName/);
  assert.match(src, /request\.toolLabel/);
  assert.match(src, /approval required/);
});

test("ApprovalCard renders request params as formatted JSON in a pre block", () => {
  assert.match(src, /<pre\b[\s\S]*?JSON\.stringify\(request\.params,\s*null,\s*2\)[\s\S]*?<\/pre>/);
  assert.match(src, /max-h-72/);
  assert.match(src, /overflow-auto/);
});

test("ApprovalCard approve and deny buttons call the response handler with explicit decisions", () => {
  assert.match(src, /data-testid=["']approval-approve["'][\s\S]*?>\s*Approve\s*<\/Button>/);
  assert.match(src, /data-testid=["']approval-deny["'][\s\S]*?>\s*Deny\s*<\/Button>/);
  assert.match(src, /onClick=\{\(\)\s*=>\s*handleClick\(["']approve["']\)\}/);
  assert.match(src, /onClick=\{\(\)\s*=>\s*handleClick\(["']deny["']\)\}/);
  assert.match(src, /onRespond\(decision\)/);
});

test("ApprovalCard countdown uses setInterval, decrements, and cleans up", () => {
  assert.match(src, /useState\(ttlSeconds\)/);
  assert.match(src, /setInterval\(\(\)\s*=>\s*setRemaining\(\(r\)\s*=>\s*Math\.max\(0,\s*r\s*-\s*1\)\)/);
  assert.match(src, /clearInterval\(t\)/);
  assert.match(src, /data-testid=["']approval-countdown["']/);
});

test("ApprovalCard buttons disable after a response or when parent disables", () => {
  assert.match(src, /useState<\s*["']approve["']\s*\|\s*["']deny["']\s*\|\s*null\s*>\(null\)/);
  assert.match(src, /setResponded\(decision\)/);
  assert.match(src, /disabled=\{!!responded\s*\|\|\s*disabled\}/);
  assert.match(src, /if \(responded \|\| disabled\) return/);
});

test("Chat appends ApprovalCard components from pendingApprovals after the message stream", () => {
  assert.match(chat, /import\s+\{\s*ApprovalCard\s*\}\s+from\s+["']\.\/ApprovalCard["']/);
  assert.match(chat, /pendingApprovals:\s*Record<string, ApprovalRequest>/);
  assert.match(chat, /Object\.values\(pendingApprovals\)/);
  const messagesIdx = chat.indexOf("{messages.map");
  const approvalsIdx = chat.indexOf("{approvalRequests.map");
  assert.ok(messagesIdx !== -1 && approvalsIdx !== -1, "expected messages and approval card maps");
  assert.ok(approvalsIdx > messagesIdx, "approval cards should be appended after transcript messages");
});

test("Chat wires approval responses and disables cards when WebSocket is bad", () => {
  assert.match(chat, /disabled=\{wsState\s*!==\s*["']ok["']\}/);
  assert.match(chat, /onRespond=\{\(decision\)\s*=>\s*respondToApproval\(request\.approvalId,\s*decision\)\}/);
  assert.match(app, /pendingApprovals=\{app\.pendingApprovals\}/);
  assert.match(app, /wsState=\{app\.wsState\}/);
  assert.match(app, /respondToApproval=\{app\.respondToApproval\}/);
});
