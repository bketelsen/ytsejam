import { getToken } from "./api";

export type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export interface TerminalWs {
  send(message: TerminalClientMessage): void;
  close(): void;
}

export function connectTerminalWs(handlers: {
  onOutput: (data: string) => void;
  onExit: (code: number | undefined) => void;
  onClose?: () => void;
}): TerminalWs {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/api/terminal/ws?token=${encodeURIComponent(getToken() ?? "")}`);
  const pending: TerminalClientMessage[] = [];
  let closed = false;

  ws.onopen = () => {
    while (pending.length > 0 && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(pending.shift()));
    }
  };
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.type === "output" && typeof msg.data === "string") {
      handlers.onOutput(msg.data);
    } else if (msg.type === "exit") {
      handlers.onExit(typeof msg.code === "number" ? msg.code : undefined);
    }
  };
  ws.onclose = () => {
    handlers.onClose?.();
  };

  return {
    send(message) {
      if (closed) return;
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      else pending.push(message);
    },
    close() {
      closed = true;
      pending.length = 0;
      ws.close();
    },
  };
}
