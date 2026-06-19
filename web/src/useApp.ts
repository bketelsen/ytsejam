import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "./lib/api";
import { watchdogDelayMs } from "./lib/approvalWatchdog";
import { connectWs } from "./lib/ws";
import type {
  ApprovalDecision,
  ApprovalMode,
  ApprovalRequest,
  ChatMessage,
  HealthState,
  LostApproval,
  PendingApprovalsSnapshot,
  ServerEvent,
  SessionRow,
  TaskRow,
} from "./lib/types";

const LTM_UNHEALTHY_THRESHOLD = 3;
const LTM_POLL_MS = 10_000;

export function useApp() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<ChatMessage | null>(null);
  const [wsState, setWsState] = useState<HealthState>("unknown");
  const [ltmState, setLtmState] = useState<HealthState>("unknown");
  const [ltmLastError, setLtmLastError] = useState<string | undefined>(undefined);
  const [tasks, setTasks] = useState<Record<string, TaskRow>>({});
  const [pendingApprovals, setPendingApprovals] = useState<Record<string, ApprovalRequest>>({});
  const [lostApprovals, setLostApprovals] = useState<Record<string, LostApproval>>({});
  // Working directory for the currently-open session. Loaded from getSession;
  // the listSessions endpoint does not include it. Undefined while no session
  // is selected or before the per-session fetch resolves.
  const [currentCwd, setCurrentCwd] = useState<string | undefined>(undefined);
  const wsRef = useRef<ReturnType<typeof connectWs> | null>(null);
  const currentIdRef = useRef<string | null>(null);
  const pendingApprovalsRef = useRef<Record<string, ApprovalRequest>>({});
  const approvalTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  currentIdRef.current = currentId;
  // Held in a ref so onEvent (memoized once with []) can reach the latest
  // closure — needed for session_unarchived's refresh.
  const refreshSessionsRef = useRef<(() => Promise<void>) | null>(null);

  const refreshSessions = useCallback(async () => {
    setSessions((await client.listSessions()).sessions);
  }, []);
  refreshSessionsRef.current = refreshSessions;

  const clearApprovalTimer = useCallback((approvalId: string) => {
    const timer = approvalTimersRef.current[approvalId];
    if (timer !== undefined) {
      clearTimeout(timer);
      delete approvalTimersRef.current[approvalId];
    }
  }, []);

  const clearAllApprovalTimers = useCallback(() => {
    for (const timer of Object.values(approvalTimersRef.current)) {
      clearTimeout(timer);
    }
    approvalTimersRef.current = {};
  }, []);

  const replacePendingApprovals = useCallback((next: Record<string, ApprovalRequest>) => {
    pendingApprovalsRef.current = next;
    setPendingApprovals(next);
  }, []);

  const removeLostApproval = useCallback((approvalId: string) => {
    setLostApprovals((prev) => {
      if (!(approvalId in prev)) return prev;
      const next = { ...prev };
      delete next[approvalId];
      return next;
    });
  }, []);

  const armApprovalWatchdog = useCallback(
    (request: ApprovalRequest) => {
      clearApprovalTimer(request.approvalId);
      const delay = watchdogDelayMs(request.createdAt, Date.now());
      approvalTimersRef.current[request.approvalId] = setTimeout(() => {
        delete approvalTimersRef.current[request.approvalId];
        const existing = pendingApprovalsRef.current[request.approvalId];
        if (!existing) return;
        const next = { ...pendingApprovalsRef.current };
        delete next[request.approvalId];
        replacePendingApprovals(next);
        const { approvalId, toolName, toolLabel } = existing;
        setLostApprovals((prev) => ({
          ...prev,
          [approvalId]: { approvalId, toolName, toolLabel },
        }));
        wsRef.current?.reconcile();
      }, delay);
    },
    [clearApprovalTimer, replacePendingApprovals],
  );

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
    if (event.type === "compaction_start") {
      setSessions((prev) =>
        prev.map((s) => (s.id === event.sessionId ? { ...s, compacting: true } : s)),
      );
      return;
    }
    if (event.type === "compaction_end") {
      setSessions((prev) =>
        prev.map((s) => (s.id === event.sessionId ? { ...s, compacting: false } : s)),
      );
      return;
    }
    if (event.type === "approval_request") {
      const request: ApprovalRequest = {
        approvalId: event.approvalId,
        createdAt: event.createdAt,
        sessionId: event.sessionId,
        toolName: event.toolName,
        toolLabel: event.toolLabel,
        params: event.params,
      };
      replacePendingApprovals({ ...pendingApprovalsRef.current, [request.approvalId]: request });
      removeLostApproval(request.approvalId);
      armApprovalWatchdog(request);
      return;
    }
    if (event.type === "approval_resolved") {
      clearApprovalTimer(event.approvalId);
      const next = { ...pendingApprovalsRef.current };
      delete next[event.approvalId];
      replacePendingApprovals(next);
      return;
    }
    if (event.type === "approval_mode_changed") {
      setSessions((prev) =>
        prev.map((s) => (s.id === event.sessionId ? { ...s, approvalMode: event.mode } : s)),
      );
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
  }, [armApprovalWatchdog, clearApprovalTimer, removeLostApproval, replacePendingApprovals]);

  const onPendingApprovals = useCallback((snapshot: PendingApprovalsSnapshot) => {
    const next = Object.fromEntries(snapshot.approvals.map((a) => [a.approvalId, a]));
    const nextIds = new Set(Object.keys(next));
    for (const approvalId of Object.keys(approvalTimersRef.current)) {
      if (!nextIds.has(approvalId)) clearApprovalTimer(approvalId);
    }
    replacePendingApprovals(next);
    setLostApprovals((prev) => {
      let changed = false;
      const remaining = { ...prev };
      for (const approvalId of nextIds) {
        if (approvalId in remaining) {
          delete remaining[approvalId];
          changed = true;
        }
      }
      return changed ? remaining : prev;
    });
    for (const approval of snapshot.approvals) armApprovalWatchdog(approval);
  }, [armApprovalWatchdog, clearApprovalTimer, replacePendingApprovals]);

  useEffect(() => {
    wsRef.current = connectWs({
      onEvent,
      onStatus: (c) => setWsState(c ? "ok" : "bad"),
      onPendingApprovals,
    });
    void refreshSessions();
    void client.listTasks().then((r) => {
      setTasks(Object.fromEntries(r.tasks.map((t) => [t.id, t])));
    });
    if ("Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }
    return () => {
      clearAllApprovalTimers();
      wsRef.current?.close();
    };
  }, [clearAllApprovalTimers, onEvent, onPendingApprovals, refreshSessions]);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const r = await client.getMemoryHealth();
        if (cancelled) return;
        if (!r.ltm) {
          setLtmState("unknown");
          setLtmLastError(undefined);
          return;
        }
        const ltm = r.ltm;
        const bad = !ltm.reachable || ltm.consecutiveFailures >= LTM_UNHEALTHY_THRESHOLD;
        setLtmState(bad ? "bad" : "ok");
        setLtmLastError(ltm.lastError?.message);
      } catch {
        if (!cancelled) setLtmState("unknown");
      }
    }
    void tick();
    const id = setInterval(tick, LTM_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

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
    async (model?: string, cwd?: string) => {
      const { session } = await client.createSession(model);
      setSessions((prev) => [session, ...prev]);
      if (cwd) {
        try {
          const res = await client.setSessionCwd(session.id, cwd);
          // setCurrentCwd is set inside selectSession, so pass the resolved
          // path down and apply it after selectSession resolves below.
          await selectSession(session.id);
          setCurrentCwd(res.cwd);
        } catch {
          await selectSession(session.id);
        }
      } else {
        await selectSession(session.id);
      }
      return session;
    },
    [selectSession],
  );

  // Whether the workdir picker is open for the pending new-chat request.
  const [workdirPickerOpen, setWorkdirPickerOpen] = useState(false);
  // Pending new-chat model selection while the picker is open.
  const pendingNewSessionModelRef = useRef<string | undefined>(undefined);

  // Called by UI new-chat buttons. Opens the workdir picker instead of
  // immediately creating a session.
  const requestNewSession = useCallback((model?: string) => {
    pendingNewSessionModelRef.current = model;
    setWorkdirPickerOpen(true);
  }, []);

  // Called by the WorkdirPicker onConfirm callback.
  const confirmNewSession = useCallback(
    async (cwd: string) => {
      setWorkdirPickerOpen(false);
      await newSession(pendingNewSessionModelRef.current, cwd);
    },
    [newSession],
  );

  const send = useCallback(
    async (text: string) => {
      let id = currentIdRef.current;
      if (!id) id = (await newSession()).id;
      await client.sendMessage(id, text);
    },
    [newSession],
  );

  const respondToApproval = useCallback(
    (approvalId: string, decision: Exclude<ApprovalDecision, "timeout">) => {
      wsRef.current?.respondToApproval(approvalId, decision);
    },
    [],
  );

  const setApprovalMode = useCallback(async (sessionId: string, mode: ApprovalMode) => {
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, approvalMode: mode } : s)));
    await client.setSessionApprovalMode(sessionId, mode);
  }, []);

  return {
    sessions,
    currentId,
    messages,
    streaming,
    wsState,
    ltmState,
    ltmLastError,
    tasks,
    pendingApprovals,
    lostApprovals,
    currentCwd,
    setCurrentCwd,
    selectSession,
    newSession,
    requestNewSession,
    confirmNewSession,
    workdirPickerOpen,
    setWorkdirPickerOpen,
    send,
    respondToApproval,
    dismissLostApproval: removeLostApproval,
    setApprovalMode,
    refreshSessions,
  };
}

function notify(title: string, body: string) {
  if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
    new Notification(title, { body });
  }
}
