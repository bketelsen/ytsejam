import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const watchdogSrc = readFileSync(join(root, "src/lib/approvalWatchdog.ts"), "utf8");
const useApp = readFileSync(join(root, "src/useApp.ts"), "utf8");
const ws = readFileSync(join(root, "src/lib/ws.ts"), "utf8");
const types = readFileSync(join(root, "src/lib/types.ts"), "utf8");
const chat = readFileSync(join(root, "src/components/Chat.tsx"), "utf8");
const app = readFileSync(join(root, "src/App.tsx"), "utf8");
const notice = readFileSync(join(root, "src/components/LostApprovalNotice.tsx"), "utf8");

const watchdogModule = await import(
  `data:text/javascript,${encodeURIComponent(
    watchdogSrc
      .replace(/export\s+const\s+/g, "const ")
      .replace(
        /export\s+function\s+watchdogDelayMs\(createdAt:\s*number,\s*now:\s*number\):\s*number/,
        "function watchdogDelayMs(createdAt, now)",
      ) + "\nexport { APPROVAL_TTL_MS, WATCHDOG_GRACE_MS, watchdogDelayMs };",
  )}`
);

const { APPROVAL_TTL_MS, WATCHDOG_GRACE_MS, watchdogDelayMs } = watchdogModule;

function makeRequest(createdAt) {
  return {
    approvalId: "approval-1",
    sessionId: "session-1",
    toolName: "bash",
    toolLabel: "npm test",
    params: { cmd: "npm test" },
    createdAt,
  };
}

function makeHarness() {
  let pending = {};
  let lost = {};
  let reconciles = 0;
  const timers = {};

  function clear(approvalId) {
    if (timers[approvalId] !== undefined) {
      clearTimeout(timers[approvalId]);
      delete timers[approvalId];
    }
  }

  function add(request) {
    pending = { ...pending, [request.approvalId]: request };
    clear(request.approvalId);
    timers[request.approvalId] = setTimeout(() => {
      delete timers[request.approvalId];
      const existing = pending[request.approvalId];
      if (!existing) return;
      const next = { ...pending };
      delete next[request.approvalId];
      pending = next;
      lost = {
        ...lost,
        [existing.approvalId]: {
          approvalId: existing.approvalId,
          toolName: existing.toolName,
          toolLabel: existing.toolLabel,
        },
      };
      reconciles += 1;
    }, watchdogDelayMs(request.createdAt, Date.now()));
  }

  function resolve(approvalId) {
    clear(approvalId);
    const next = { ...pending };
    delete next[approvalId];
    pending = next;
  }

  return {
    add,
    resolve,
    get pending() { return pending; },
    get lost() { return lost; },
    get reconciles() { return reconciles; },
  };
}

test("watchdogDelayMs returns approval TTL plus grace for a fresh approval", () => {
  assert.equal(watchdogDelayMs(1_000, 1_000), 330_000);
});

test("watchdogDelayMs clamps stale or invalid approvals to zero", () => {
  assert.equal(watchdogDelayMs(1_000, 400_001), 0);
  assert.equal(watchdogDelayMs(Number.NaN, 1_000), 0);
  assert.equal(watchdogDelayMs(Number.POSITIVE_INFINITY, 1_000), 0);
});

test("approval added but never resolved clears after 5 minutes plus 30 seconds", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const harness = makeHarness();
  harness.add(makeRequest(Date.now()));

  t.mock.timers.tick(329_999);
  assert.ok(harness.pending["approval-1"], "approval should remain before watchdog deadline");
  assert.deepEqual(harness.lost, {});
  assert.equal(harness.reconciles, 0);

  t.mock.timers.tick(1);
  assert.deepEqual(harness.pending, {});
  assert.deepEqual(harness.lost, {
    "approval-1": {
      approvalId: "approval-1",
      toolName: "bash",
      toolLabel: "npm test",
    },
  });
  assert.equal(harness.reconciles, 1);
});

test("resolved approvals clear their watchdog before it can mark them lost", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const harness = makeHarness();
  harness.add(makeRequest(Date.now()));
  harness.resolve("approval-1");

  t.mock.timers.tick(330_000);
  assert.deepEqual(harness.pending, {});
  assert.deepEqual(harness.lost, {});
  assert.equal(harness.reconciles, 0);
});

test("approval watchdog helper declares the shared TTL and grace constants", () => {
  assert.equal(APPROVAL_TTL_MS, 5 * 60 * 1000);
  assert.equal(WATCHDOG_GRACE_MS, 30_000);
  assert.match(watchdogSrc, /APPROVAL_TTL_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/);
  assert.match(watchdogSrc, /WATCHDOG_GRACE_MS\s*=\s*30_000/);
  assert.match(watchdogSrc, /Math\.max\(0,\s*createdAt\s*\+\s*APPROVAL_TTL_MS\s*\+\s*WATCHDOG_GRACE_MS\s*-\s*now\)/);
});

test("types.ts exposes LostApproval for the dismissible notice", () => {
  assert.match(types, /export\s+interface\s+LostApproval\s*\{/);
  assert.match(types, /approvalId:\s*string/);
  assert.match(types, /toolName:\s*string/);
  assert.match(types, /toolLabel:\s*string/);
});

test("ws.ts exposes reconcile() and re-sends the active subscribe message", () => {
  assert.match(ws, /reconcile:\s*\(\)\s*=>\s*void/);
  const body = ws.match(/reconcile\(\)\s*\{([\s\S]*?)\n\s*\},/);
  assert.ok(body, "expected reconcile method in returned handle");
  assert.match(body[1], /readyState\s*===\s*WebSocket\.OPEN/);
  assert.match(body[1], /\bsubscribed\b/);
  assert.match(body[1], /type:\s*["']subscribe["']/);
  assert.match(body[1], /sessionId:\s*subscribed/);
});

test("useApp arms watchdog timers for approval requests and clears them on resolution", () => {
  assert.match(useApp, /import\s+\{\s*watchdogDelayMs\s*\}\s+from\s+["']\.\/lib\/approvalWatchdog["']/);
  assert.match(useApp, /lostApprovals,\s*setLostApprovals/);
  assert.match(useApp, /approvalTimersRef/);
  assert.match(useApp, /setTimeout\(\(\)\s*=>\s*\{/);
  assert.match(useApp, /watchdogDelayMs\(request\.createdAt,\s*Date\.now\(\)\)/);
  assert.match(useApp, /if \(event\.type === ["']approval_request["']\)[\s\S]*armApprovalWatchdog\(request\)/);
  assert.match(useApp, /if \(event\.type === ["']approval_resolved["']\)[\s\S]*clearApprovalTimer\(event\.approvalId\)/);
  assert.match(useApp, /wsRef\.current\?\.reconcile\(\)/);
  assert.match(useApp, /clearAllApprovalTimers\(\)/);
});

test("useApp reconciles snapshot timers without marking dropped snapshot entries lost", () => {
  assert.match(useApp, /onPendingApprovals[\s\S]*Object\.fromEntries\(snapshot\.approvals/);
  assert.match(useApp, /for \(const approvalId of Object\.keys\(approvalTimersRef\.current\)\)[\s\S]*clearApprovalTimer\(approvalId\)/);
  assert.match(useApp, /for \(const approval of snapshot\.approvals\) armApprovalWatchdog\(approval\)/);
});

test("Chat renders dismissible lost approval notices after approval cards", () => {
  assert.match(notice, /export\s+function\s+LostApprovalNotice/);
  assert.match(notice, /data-testid=["']approval-lost["']/);
  assert.match(notice, /Resolution lost — please retry/);
  assert.match(notice, /onDismiss/);
  assert.match(chat, /import\s+\{\s*LostApprovalNotice\s*\}\s+from\s+["']\.\/LostApprovalNotice["']/);
  assert.match(chat, /lostApprovals:\s*Record<string, LostApproval>/);
  assert.match(chat, /dismissLostApproval:\s*\(approvalId:\s*string\)\s*=>\s*void/);
  const approvalsIdx = chat.indexOf("{approvalRequests.map");
  const lostIdx = chat.indexOf("{lostApprovalNotices.map");
  assert.ok(approvalsIdx !== -1 && lostIdx !== -1, "expected approval and lost-notice maps");
  assert.ok(lostIdx > approvalsIdx, "lost notices should render after approval cards");
  assert.match(app, /lostApprovals=\{app\.lostApprovals\}/);
  assert.match(app, /dismissLostApproval=\{app\.dismissLostApproval\}/);
});
