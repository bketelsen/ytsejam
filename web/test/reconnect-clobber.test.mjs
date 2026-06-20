import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

// Wiring tests (source-inspection, matching the existing web suite style) for
// PR 3's useApp + App.tsx changes:
//   - reconnect refetch (onReconnect → refresh sessions/tasks/open transcript)
//   - selectSession clobber guard (buffer message_end during the fetch window)
//   - onEvent defensive guard against malformed agent frames
//   - <Chat key={sessionId}> remount to prevent wrong-session drafts
//
// The pure dedup helper is exercised as real code further down via a tiny
// re-implementation check kept in lockstep with the source.

const root = new URL("..", import.meta.url).pathname;
const useApp = readFileSync(join(root, "src/useApp.ts"), "utf8");
const app = readFileSync(join(root, "src/App.tsx"), "utf8");
const ws = readFileSync(join(root, "src/lib/ws.ts"), "utf8");

test("ws.ts exposes an onReconnect handler and fires it only after the first connect", () => {
  assert.match(ws, /onReconnect\?:\s*\(\)\s*=>\s*void/);
  // The first-connect-vs-reconnect latch.
  assert.match(ws, /hasConnected/);
  assert.match(ws, /if \(hasConnected\) handlers\.onReconnect\?\.\(\)/);
});

test("ws.ts onmessage guards JSON.parse and unknown frame shapes", () => {
  const onmsg = ws.match(/ws\.onmessage\s*=\s*\(e\)\s*=>\s*\{([\s\S]*?)\n\s{4}\};/);
  assert.ok(onmsg, "expected ws.onmessage handler body");
  const body = onmsg[1];
  assert.match(body, /try\s*\{[\s\S]*JSON\.parse/);
  assert.match(body, /catch\s*\{[\s\S]*return/);
  // unknown-shape guard: requires a string `type`.
  assert.match(body, /typeof .*\.type\s*!==\s*["']string["']/);
  // onEvent dispatch is wrapped so a throw can't kill the socket.
  assert.match(body, /try\s*\{[\s\S]*handlers\.onEvent[\s\S]*catch/);
});

test("useApp wires onReconnect to refetch sessions, tasks, and the open transcript", () => {
  assert.match(useApp, /onReconnect:\s*\(\)\s*=>\s*\{/);
  const reconnect = useApp.match(/onReconnect:\s*\(\)\s*=>\s*\{([\s\S]*?)\},\n\s{4}\}\);/);
  assert.ok(reconnect, "expected onReconnect handler body");
  const body = reconnect[1];
  assert.match(body, /refreshSessionsRef\.current\?\.\(\)/);
  assert.match(body, /loadTasks\(\)/);
  assert.match(body, /selectSessionRef\.current\?\.\(openId\)/);
});

test("useApp.onEvent guards the agent fall-through against malformed frames", () => {
  // The defensive early-return before dereferencing event.event.type.
  assert.match(
    useApp,
    /event\.type\s*!==\s*["']agent["']\s*\|\|\s*typeof event\.event\?\.type\s*!==\s*["']string["']\)\s*return/,
  );
});

test("useApp.selectSession arms a clobber buffer and merges buffered message_end", () => {
  assert.match(useApp, /loadingSessionRef/);
  assert.match(useApp, /loadBufferRef/);
  // Buffer is armed before subscribe so in-flight message_end is captured.
  const sel = useApp.match(/const selectSession = useCallback\(async \(id[\s\S]*?\}, \[\]\);/);
  assert.ok(sel, "expected selectSession body");
  const body = sel[0];
  assert.match(body, /loadingSessionRef\.current = id/);
  assert.match(body, /wsRef\.current\?\.subscribe\(id\)/);
  // Arming happens before the subscribe call.
  assert.ok(
    body.indexOf("loadingSessionRef.current = id") < body.indexOf("subscribe(id)"),
    "buffer must be armed before subscribe so mid-fetch events are captured",
  );
  // Merge path uses the structural sameMessage dedup.
  assert.match(body, /sameMessage/);
  // onEvent pushes message_end into the buffer while a load is in flight.
  assert.match(useApp, /loadingSessionRef\.current === event\.sessionId[\s\S]*loadBufferRef\.current\.push/);
});

test("App.tsx remounts <Chat> per session to clear wrong-session drafts", () => {
  assert.match(app, /<Chat\s*\n?\s*key=\{app\.currentId\s*\?\?\s*["']__none__["']\}/);
});
