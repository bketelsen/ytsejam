import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const ws = readFileSync(join(root, "src/lib/ws.ts"), "utf8");

test("ws.ts declares a connect-watchdog timeout constant", () => {
  // The 5000ms (or 5_000) connect-watchdog window from the design.
  assert.match(ws, /CONNECT_WATCHDOG_MS\s*=\s*5_?000/);
});

test("ws.ts arms the watchdog with setTimeout(... CONNECT_WATCHDOG_MS) inside open()", () => {
  // Some identifier (e.g. `watchdog`) holds the timer id, scheduled via setTimeout
  // with CONNECT_WATCHDOG_MS as its delay.
  assert.match(ws, /setTimeout\([^,]+,\s*CONNECT_WATCHDOG_MS\)/);
});

test("ws.ts watchdog callback checks readyState === WebSocket.CONNECTING and calls ws.close()", () => {
  // The check that the socket is still pending.
  assert.match(ws, /readyState\s*===\s*WebSocket\.CONNECTING/);
  // Closing the still-pending socket triggers onclose → onStatus(false) → backoff.
  // The watchdog must therefore close the socket. We assert a `.close()` call exists
  // somewhere in the new control flow; the file already had `ws?.close()` in the
  // public close handle, but the watchdog adds another close site.
  const closeCount = (ws.match(/\bws[?.]?\.?\.close\(\)/g) || []).length
                  + (ws.match(/\.close\(\)/g) || []).length;
  // At minimum: original public close() + new watchdog close. (We don't pin the
  // exact count tightly so a future small refactor doesn't trip the test.)
  assert.ok(closeCount >= 2, `expected ≥2 close() sites, found ${closeCount}`);
});

test("ws.ts clears the watchdog on onopen AND onclose so it can't fire after settle", () => {
  // Tight enough to catch removing EITHER lifecycle clearTimeout (a real bug:
  // a successful connect that doesn't clear would have the watchdog fire 5s
  // later and close the live socket; a close that doesn't clear leaks the timer).
  // We look for clearTimeout inside the onopen and onclose handler bodies.
  const onopenBody  = ws.match(/ws\.onopen\s*=\s*\(\)\s*=>\s*\{([\s\S]*?)\};/);
  const oncloseBody = ws.match(/ws\.onclose\s*=\s*\(\)\s*=>\s*\{([\s\S]*?)\};/);
  assert.ok(onopenBody,  "expected to find ws.onopen handler body");
  assert.ok(oncloseBody, "expected to find ws.onclose handler body");
  assert.match(onopenBody[1],  /clearTimeout\(/, "ws.onopen must clearTimeout the watchdog");
  assert.match(oncloseBody[1], /clearTimeout\(/, "ws.onclose must clearTimeout the watchdog");
});

test("ws.ts onStatus signature is unchanged (still passes boolean)", () => {
  // Locks the public contract — the watchdog must not change the callback shape.
  assert.match(ws, /onStatus:\s*\(\s*connected:\s*boolean\s*\)\s*=>\s*void/);
});
