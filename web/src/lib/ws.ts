import { getToken } from "./api";
import type { ServerEvent } from "./types";

export function connectWs(handlers: {
  onEvent: (event: ServerEvent) => void;
  onStatus: (connected: boolean) => void;
}): { subscribe: (sessionId: string | null) => void; close: () => void } {
  let ws: WebSocket | null = null;
  let subscribed: string | null = null;
  let closed = false;
  let retryMs = 500;

  function open() {
    if (closed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/api/ws?token=${encodeURIComponent(getToken() ?? "")}`);
    ws.onopen = () => {
      retryMs = 500;
      handlers.onStatus(true);
      if (subscribed) ws?.send(JSON.stringify({ type: "subscribe", sessionId: subscribed }));
    };
    ws.onmessage = (e) => handlers.onEvent(JSON.parse(String(e.data)));
    ws.onclose = () => {
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
      ws?.close();
    },
  };
}
