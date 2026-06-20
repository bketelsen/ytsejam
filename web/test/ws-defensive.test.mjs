import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { transform } from "esbuild";

// Executing test for the defensive ws.ts behaviors (PR 3): malformed-frame
// guard, unknown-shape guard, pending_approvals routing, and the
// first-connect-vs-reconnect distinction that drives onReconnect refetch.
//
// We compile the REAL ws.ts with esbuild (proper TS transpile, not a regex
// strip), neutralize its `./api` import, and drive connectWs() with a fake
// global WebSocket. This exercises the actual control flow.

const root = new URL("..", import.meta.url).pathname;
const wsSrc = readFileSync(join(root, "src/lib/ws.ts"), "utf8")
  // Replace the getToken import with a stub so the module has no external deps.
  .replace(/import\s+\{\s*getToken\s*\}\s+from\s+["']\.\/api["'];?/, 'const getToken = () => "tok";');

const { code } = await transform(wsSrc, { loader: "ts", format: "esm" });
const mod = await import(`data:text/javascript,${encodeURIComponent(code)}`);
const { connectWs } = mod;

// --- Fake WebSocket harness ------------------------------------------------

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

let sockets = [];

class FakeWebSocket {
  static CONNECTING = CONNECTING;
  static OPEN = OPEN;
  static CLOSED = CLOSED;
  constructor(url) {
    this.url = url;
    this.readyState = CONNECTING;
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    sockets.push(this);
  }
  send(data) { this.sent.push(data); }
  close() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.onclose?.();
  }
  _open() { this.readyState = OPEN; this.onopen?.(); }
  _message(data) { this.onmessage?.({ data }); }
}

function withFakeWs(fn) {
  const prevWs = globalThis.WebSocket;
  const prevLoc = globalThis.location;
  sockets = [];
  globalThis.WebSocket = FakeWebSocket;
  globalThis.location = { protocol: "http:", host: "localhost:3000" };
  try {
    return fn();
  } finally {
    globalThis.WebSocket = prevWs;
    globalThis.location = prevLoc;
  }
}

// --- Tests -----------------------------------------------------------------

test("malformed (non-JSON) frame is ignored, does not throw or reach onEvent", () => {
  withFakeWs(() => {
    let events = 0;
    const handle = connectWs({ onEvent: () => { events++; }, onStatus: () => {} });
    const sock = sockets[0];
    sock._open();
    assert.doesNotThrow(() => sock._message("this is not json{"));
    assert.equal(events, 0, "malformed frame must not reach onEvent");
    handle.close();
  });
});

test("frame without a string `type` discriminant is ignored", () => {
  withFakeWs(() => {
    let events = 0;
    const handle = connectWs({ onEvent: () => { events++; }, onStatus: () => {} });
    const sock = sockets[0];
    sock._open();
    sock._message(JSON.stringify({ no: "type" }));
    sock._message(JSON.stringify({ type: 42 }));
    sock._message(JSON.stringify(null));
    assert.equal(events, 0, "shapeless frames must not reach onEvent");
    handle.close();
  });
});

test("a throwing onEvent does not kill the socket (next frame still delivered)", () => {
  withFakeWs(() => {
    const seen = [];
    const handle = connectWs({
      onEvent: (e) => {
        seen.push(e.type);
        if (e.type === "boom") throw new Error("handler bug");
      },
      onStatus: () => {},
    });
    const sock = sockets[0];
    sock._open();
    const prevErr = console.error;
    console.error = () => {}; // silence expected error log
    try {
      assert.doesNotThrow(() => sock._message(JSON.stringify({ type: "boom" })));
      sock._message(JSON.stringify({ type: "task" }));
    } finally {
      console.error = prevErr;
    }
    assert.deepEqual(seen, ["boom", "task"], "socket survives a throwing handler");
    handle.close();
  });
});

test("pending_approvals frames route to onPendingApprovals, not onEvent", () => {
  withFakeWs(() => {
    let events = 0;
    let snapshots = 0;
    const handle = connectWs({
      onEvent: () => { events++; },
      onStatus: () => {},
      onPendingApprovals: () => { snapshots++; },
    });
    const sock = sockets[0];
    sock._open();
    sock._message(JSON.stringify({ type: "pending_approvals", approvals: [] }));
    assert.equal(snapshots, 1);
    assert.equal(events, 0);
    handle.close();
  });
});

test("onReconnect fires on a reconnect but NOT on the first connect", (t) => {
  withFakeWs(() => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let reconnects = 0;
    const handle = connectWs({
      onEvent: () => {},
      onStatus: () => {},
      onReconnect: () => { reconnects++; },
    });
    const first = sockets[0];
    first._open();
    assert.equal(reconnects, 0, "first connect must not trigger refetch");

    first.close(); // backoff schedules a reconnect open() via setTimeout
    t.mock.timers.tick(1000); // first backoff is min(500*2, 10000) = 1000ms
    const second = sockets[1];
    assert.ok(second, "a reconnect socket should have been created");
    second._open();
    assert.equal(reconnects, 1, "reconnect must trigger exactly one refetch");
    handle.close();
  });
});

test("reconnect re-sends the active subscribe", (t) => {
  withFakeWs(() => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const handle = connectWs({ onEvent: () => {}, onStatus: () => {}, onReconnect: () => {} });
    const first = sockets[0];
    first._open();
    handle.subscribe("sess-1");
    assert.ok(first.sent.some((m) => m.includes("subscribe") && m.includes("sess-1")));
    first.close();
    t.mock.timers.tick(1000);
    const second = sockets[1];
    assert.ok(second, "a reconnect socket should have been created");
    second._open();
    assert.ok(
      second.sent.some((m) => m.includes("subscribe") && m.includes("sess-1")),
      "reconnect must re-subscribe the active session",
    );
    handle.close();
  });
});
