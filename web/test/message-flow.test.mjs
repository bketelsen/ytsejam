import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const useApp = readFileSync(join(root, "src/useApp.ts"), "utf8");

function functionBody(name) {
  const start = useApp.indexOf(`const ${name} = useCallback(`);
  assert.notEqual(start, -1, `missing ${name} callback`);
  const end = useApp.indexOf(`\n  return {`, start);
  assert.notEqual(end, -1, `could not find end of ${name} callback`);
  return useApp.slice(start, end);
}

test("send relies on websocket message_end instead of appending an optimistic user copy", () => {
  const sendBody = functionBody("send");

  assert.doesNotMatch(sendBody, /setMessages\s*\(/);
  assert.doesNotMatch(sendBody, /role:\s*["']user["']/);
  assert.match(sendBody, /client\.sendMessage\(id,\s*text\)/);
});
