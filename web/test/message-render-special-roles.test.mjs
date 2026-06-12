import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

// Source-inspection style, matching message-flow.test.mjs. We assert on the
// text of blocks() rather than executing it, because web/test/* runs under
// plain node without JSX/TSX transform or React in scope.

const root = new URL("..", import.meta.url).pathname;
const source = readFileSync(join(root, "src/components/Message.tsx"), "utf8");

function blocksBody() {
  const sig = "function blocks(";
  const start = source.indexOf(sig);
  assert.notEqual(start, -1, "could not find blocks() declaration");
  // Walk braces from the first '{' after the signature to find the matching close.
  const openIdx = source.indexOf("{", start);
  assert.notEqual(openIdx, -1, "could not find blocks() opening brace");
  let depth = 0;
  let i = openIdx;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  assert.notEqual(i, source.length, "could not find blocks() closing brace");
  return source.slice(openIdx, i + 1);
}

test("Message blocks() handles compactionSummary special role", () => {
  const body = blocksBody();
  assert.match(body, /compactionSummary/);
  // Renders a "[compacted]" italic divider followed by the summary text.
  assert.match(body, /compacted/);
});

test("Message blocks() handles branchSummary special role", () => {
  const body = blocksBody();
  assert.match(body, /branchSummary/);
  assert.match(body, /branch summary/);
});

test("Message blocks() handles bashExecution special role", () => {
  const body = blocksBody();
  assert.match(body, /bashExecution/);
  // bashExecution should pull command/output/exitCode off the message and emit
  // a fenced code block. We check for the literal field accesses and fence.
  assert.match(body, /command/);
  assert.match(body, /output/);
  assert.match(body, /exitCode/);
  assert.match(body, /```/);
});

test("Message blocks() degrades unknown content shapes to [] instead of crashing", () => {
  const body = blocksBody();
  // String and array paths are explicit; the fallback is a bare `return [];`.
  assert.match(body, /typeof c === "string"/);
  assert.match(body, /Array\.isArray\(c\)/);
  assert.match(body, /return \[\];/);
});

test("Message copyableText() defends against blocks() callers via .filter/.map", () => {
  // Regression guard: copyableText feeds blocks() output into .filter().map().
  // If blocks() ever returns undefined again the whole pane blanks. Make sure
  // the contract (always returns an array) is visible in the source.
  const copyStart = source.indexOf("function copyableText(");
  assert.notEqual(copyStart, -1, "missing copyableText()");
  const copyBody = source.slice(copyStart, source.indexOf("\n}", copyStart) + 2);
  assert.match(copyBody, /blocks\(message\)/);
  assert.match(copyBody, /\.filter\(/);
  assert.match(copyBody, /\.map\(/);
});
