import { getToken } from "./api";
import type { ServerEvent } from "./types";

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
}): { subscribe: (sessionId: string | null) => void; close: () => void } {
  let ws: WebSocket | null = null;
  let subscribed: string | null = null;
  let closed = false;
  let retryMs = 500;
  let watchdog: ReturnType<typeof setTimeout> | null = null;

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
    };
    ws.onmessage = (e) => handlers.onEvent(JSON.parse(String(e.data)));
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
    close() {
      closed = true;
      clearWatchdog();
      ws?.close();
    },
  };
}
