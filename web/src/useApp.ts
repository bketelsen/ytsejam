import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "./lib/api";
import { connectWs } from "./lib/ws";
import type { ChatMessage, ServerEvent, SessionRow, TaskRow } from "./lib/types";

export function useApp() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<ChatMessage | null>(null);
  const [connected, setConnected] = useState(false);
  const [tasks, setTasks] = useState<Record<string, TaskRow>>({});
  // Working directory for the currently-open session. Loaded from getSession;
  // the listSessions endpoint does not include it. Undefined while no session
  // is selected or before the per-session fetch resolves.
  const [currentCwd, setCurrentCwd] = useState<string | undefined>(undefined);
  const wsRef = useRef<ReturnType<typeof connectWs> | null>(null);
  const currentIdRef = useRef<string | null>(null);
  currentIdRef.current = currentId;
  // Held in a ref so onEvent (memoized once with []) can reach the latest
  // closure — needed for session_unarchived's refresh.
  const refreshSessionsRef = useRef<(() => Promise<void>) | null>(null);

  const refreshSessions = useCallback(async () => {
    setSessions((await client.listSessions()).sessions);
  }, []);
  refreshSessionsRef.current = refreshSessions;

  const onEvent = useCallback((event: ServerEvent) => {
    if (event.type === "task") {
      setTasks((prev) => ({ ...prev, [event.task.id]: event.task }));
      return;
    }
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
    if (event.type === "session_archived") {
      // Remove from the active list. The session row stays in the indexer
      // (archived=1); the Sidebar's "Show archived" view fetches it fresh
      // via listSessions({includeArchived:true}) when opened.
      setSessions((prev) => prev.filter((s) => s.id !== event.sessionId));
      if (event.sessionId === currentIdRef.current) setCurrentId(null);
      return;
    }
    if (event.type === "session_unarchived") {
      // Re-add to the active list. We don't have the full row in this event,
      // so refresh the list — cheap and authoritative.
      void refreshSessionsRef.current?.();
      return;
    }
    if (event.type === "schedule") return; // Settings refetches on open
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
    void client.listTasks().then((r) => {
      setTasks(Object.fromEntries(r.tasks.map((t) => [t.id, t])));
    });
    if ("Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }
    return () => wsRef.current?.close();
  }, [onEvent, refreshSessions]);

  const selectSession = useCallback(async (id: string | null) => {
    setCurrentId(id);
    setMessages([]);
    setStreaming(null);
    setCurrentCwd(undefined);
    wsRef.current?.subscribe(id);
    if (id) {
      const { session, messages } = await client.getSession(id);
      // user may have switched again while the transcript loaded
      if (currentIdRef.current !== id) return;
      // note: a message_end arriving during the fetch can be clobbered by this
      // snapshot; it self-heals on reselect (messages have no stable id to merge by)
      setMessages(messages);
      setCurrentCwd(session.cwd);
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
    tasks,
    currentCwd,
    setCurrentCwd,
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
