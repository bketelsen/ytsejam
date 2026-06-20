import { getToken } from "./api";
import type { ApprovalDecision, PendingApprovalsSnapshot, ServerEvent } from "./types";

// If a WebSocket connect attempt is still in `CONNECTING` after this window, the
// watchdog forces a close() — which fires onclose → onStatus(false) → the existing
// backoff reconnect loop takes over. This catches the indefinite-pending case
// (black-hole proxy / captive portal that swallows the SYN), where the browser
// would otherwise never fire onopen/onclose/onerror and the plug icon would
// stay gray forever. (See issue #116.)
const CONNECT_WATCHDOG_MS = 5_000;

export function connectWs(handlers: {
  onEvent: (event: ServerEvent) => void;
  onStatus: (connected: boolean) => void;
  onPendingApprovals?: (snapshot: PendingApprovalsSnapshot) => void;
  /**
   * Fired when the socket (re)connects AFTER the first successful connect.
   * The EventBus has no replay buffer (server/src/events.ts), so every event
   * emitted while the socket was down is lost. The consumer uses this to
   * refetch authoritative state (session list, tasks, open transcript) so the
   * UI doesn't sit on stale data after a sleep/Wi-Fi blip or server restart.
   * NOT fired on the very first connect — initial state is bootstrapped by the
   * mount effect.
   */
  onReconnect?: () => void;
}): {
  subscribe: (sessionId: string | null) => void;
  reconcile: () => void;
  close: () => void;
  respondToApproval: (approvalId: string, decision: Exclude<ApprovalDecision, "timeout">) => void;
} {
  let ws: WebSocket | null = null;
  let subscribed: string | null = null;
  let closed = false;
  let retryMs = 500;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  // Distinguishes the first successful connect (bootstrapped by the mount
  // effect) from later reconnects (which must refetch — onReconnect).
  let hasConnected = false;

  function clearWatchdog() {
    if (watchdog !== null) { clearTimeout(watchdog); watchdog = null; }
  }

  function open() {
    if (closed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/api/ws?token=${encodeURIComponent(getToken() ?? "")}`);
    watchdog = setTimeout(() => {
      // Only act if we're still pending. A successful onopen will have cleared
      // this timer; this guard protects against the race where the timer fires
      // between onopen scheduling and clearTimeout running.
      if (ws?.readyState === WebSocket.CONNECTING) ws.close();
    }, CONNECT_WATCHDOG_MS);
    ws.onopen = () => {
      clearWatchdog(); // clearTimeout(...) lives in clearWatchdog()
      retryMs = 500;
      handlers.onStatus(true);
      if (subscribed) ws?.send(JSON.stringify({ type: "subscribe", sessionId: subscribed }));
      // First connect is bootstrapped by the mount effect; only a RE-connect
      // needs to refetch the state missed during the disconnect window.
      if (hasConnected) handlers.onReconnect?.();
      hasConnected = true;
    };
    ws.onmessage = (e) => {
      // A malformed frame (non-JSON) or an unexpected shape must not throw out
      // of onmessage — that would drop the frame AND log an uncaught error.
      // The server's own inbound handler is equally defensive (server.ts).
      let msg: unknown;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return; // ignore unparseable frame
      }
      if (typeof msg !== "object" || msg === null || typeof (msg as { type?: unknown }).type !== "string") {
        return; // ignore frames without a string discriminant
      }
      if ((msg as { type: string }).type === "pending_approvals") {
        handlers.onPendingApprovals?.(msg as PendingApprovalsSnapshot);
        return;
      }
      try {
        handlers.onEvent(msg as ServerEvent);
      } catch (err) {
        // A handler bug or an unrecognized frame shape must not kill the socket.
        console.error("ws onEvent failed for frame", msg, err);
      }
    };
    ws.onclose = () => {
      clearWatchdog(); // clearTimeout(...) lives in clearWatchdog()
      handlers.onStatus(false);
      if (!closed) setTimeout(open, (retryMs = Math.min(retryMs * 2, 10_000)));
    };
  }
  open();

  return {
    subscribe(sessionId) {
      subscribed = sessionId;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(sessionId ? { type: "subscribe", sessionId } : { type: "unsubscribe" }));
      }
    },
    reconcile() {
      if (ws?.readyState === WebSocket.OPEN && subscribed) {
        ws.send(JSON.stringify({ type: "subscribe", sessionId: subscribed }));
      }
    },
    close() {
      closed = true;
      clearWatchdog();
      ws?.close();
    },
    respondToApproval(approvalId, decision) {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "approval_response", approvalId, decision }));
      }
    },
  };
}
