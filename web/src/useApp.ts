import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "./lib/api";
import { connectWs } from "./lib/ws";
import type { ChatMessage, ServerEvent, SessionRow } from "./lib/types";

export function useApp() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<ChatMessage | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<ReturnType<typeof connectWs> | null>(null);
  const currentIdRef = useRef<string | null>(null);
  currentIdRef.current = currentId;

  const refreshSessions = useCallback(async () => {
    setSessions((await client.listSessions()).sessions);
  }, []);

  const onEvent = useCallback((event: ServerEvent) => {
    if (event.type === "session_meta") {
      setSessions((prev) => {
        const rest = prev.filter((s) => s.id !== event.session.id);
        const unread = event.session.id === currentIdRef.current ? false : event.session.unread;
        return [{ ...event.session, unread }, ...rest].sort((a, b) =>
          b.updatedAt.localeCompare(a.updatedAt),
        );
      });
      if (event.session.unread && event.session.id !== currentIdRef.current) {
        notify(event.session.title ?? "New message", event.session.preview);
      }
      if (event.session.id === currentIdRef.current && event.session.unread) {
        void client.patchSession(event.session.id, { unread: false });
      }
      return;
    }
    if (event.type === "session_deleted") {
      setSessions((prev) => prev.filter((s) => s.id !== event.sessionId));
      if (event.sessionId === currentIdRef.current) setCurrentId(null);
      return;
    }
    // agent events
    if (event.sessionId !== currentIdRef.current) {
      if (event.event.type === "agent_start" || event.event.type === "agent_end") {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === event.sessionId ? { ...s, running: event.event.type === "agent_start" } : s,
          ),
        );
      }
      return;
    }
    const e = event.event;
    if (e.type === "message_start" || e.type === "message_update") {
      setStreaming(e.message ?? null);
    } else if (e.type === "message_end" && e.message) {
      setStreaming(null);
      setMessages((prev) => [...prev, e.message!]);
    } else if (e.type === "agent_start" || e.type === "agent_end") {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === event.sessionId ? { ...s, running: e.type === "agent_start" } : s,
        ),
      );
      if (e.type === "agent_end") setStreaming(null);
    }
  }, []);

  useEffect(() => {
    wsRef.current = connectWs({ onEvent, onStatus: setConnected });
    void refreshSessions();
    if ("Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }
    return () => wsRef.current?.close();
  }, [onEvent, refreshSessions]);

  const selectSession = useCallback(async (id: string | null) => {
    setCurrentId(id);
    setMessages([]);
    setStreaming(null);
    wsRef.current?.subscribe(id);
    if (id) {
      const { messages } = await client.getSession(id);
      // user may have switched again while the transcript loaded
      if (currentIdRef.current !== id) return;
      // note: a message_end arriving during the fetch can be clobbered by this
      // snapshot; it self-heals on reselect (messages have no stable id to merge by)
      setMessages(messages);
      void client.patchSession(id, { unread: false });
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, unread: false } : s)));
    }
  }, []);

  const newSession = useCallback(
    async (model?: string) => {
      const { session } = await client.createSession(model);
      setSessions((prev) => [session, ...prev]);
      await selectSession(session.id);
      return session;
    },
    [selectSession],
  );

  const send = useCallback(
    async (text: string) => {
      let id = currentIdRef.current;
      if (!id) id = (await newSession()).id;
      await client.sendMessage(id, text);
    },
    [newSession],
  );

  return {
    sessions,
    currentId,
    messages,
    streaming,
    connected,
    selectSession,
    newSession,
    send,
    refreshSessions,
  };
}

function notify(title: string, body: string) {
  if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
    new Notification(title, { body });
  }
}
