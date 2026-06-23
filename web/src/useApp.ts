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
  // Clobber guard for selectSession: while a transcript snapshot is in flight,
  // `loadingSessionRef` holds that session id and `loadBufferRef` collects any
  // `message_end` messages that stream in during the fetch window. After the
  // snapshot lands we append the buffered ones the snapshot didn't include, so
  // a message that arrives mid-fetch is no longer overwritten by the snapshot.
  const loadingSessionRef = useRef<string | null>(null);
  const loadBufferRef = useRef<ChatMessage[]>([]);
  currentIdRef.current = currentId;
  // Held in a ref so onEvent (memoized once with []) can reach the latest
  // closure — needed for session_unarchived's refresh.
  const refreshSessionsRef = useRef<(() => Promise<void>) | null>(null);
  // Held in a ref so the WS onReconnect handler (wired once at mount) can reach
  // the latest selectSession closure to reload the open transcript.
  const selectSessionRef = useRef<((id: string | null) => Promise<void>) | null>(null);

  const refreshSessions = useCallback(async () => {
    setSessions((await client.listSessions()).sessions);
  }, []);
  refreshSessionsRef.current = refreshSessions;

  const loadTasks = useCallback(async () => {
    const r = await client.listTasks();
    setTasks(Object.fromEntries(r.tasks.map((t) => [t.id, t])));
  }, []);

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
    // Defensive: the `agent` variant must carry a nested `event` with a string
    // `type`. A malformed/partial frame (or a future event type we don't model)
    // must not throw a TypeError out of onEvent and drop the frame silently.
    if (event.type !== "agent" || typeof event.event?.type !== "string") return;
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
      // If a transcript snapshot for this session is mid-flight, also stash the
      // message so selectSession can re-append it after the snapshot lands —
      // otherwise setMessages(snapshot) would clobber it (the snapshot was
      // materialized before this message was persisted server-side).
      if (loadingSessionRef.current === event.sessionId) {
        loadBufferRef.current.push(e.message);
      }
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
      onReconnect: () => {
        // The EventBus has no replay buffer, so anything emitted while we were
        // disconnected is gone. Refetch authoritative state: session list (titles,
        // previews, unread, running/compacting flags), tasks, and — if a session
        // is open — its transcript + cwd (which also re-subscribes via selectSession).
        void refreshSessionsRef.current?.();
        void loadTasks();
        const openId = currentIdRef.current;
        if (openId) void selectSessionRef.current?.(openId);
      },
    });
    void refreshSessions();
    void loadTasks();
    if ("Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }
    return () => {
      clearAllApprovalTimers();
      wsRef.current?.close();
    };
  }, [clearAllApprovalTimers, loadTasks, onEvent, onPendingApprovals, refreshSessions]);

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
    // Arm the clobber guard BEFORE subscribe so any message_end that streams in
    // during the fetch window is captured in the buffer (see onEvent).
    loadingSessionRef.current = id;
    loadBufferRef.current = [];
    wsRef.current?.subscribe(id);
    if (id) {
      try {
        const { session, messages } = await client.getSession(id);
        // user may have switched again while the transcript loaded
        if (currentIdRef.current !== id) return;
        // Merge any message_end that arrived during the fetch and isn't already
        // in the snapshot, so a message streamed mid-load isn't clobbered by the
        // snapshot. Messages have no stable id, so dedup structurally.
        const buffered = loadingSessionRef.current === id ? loadBufferRef.current : [];
        const merged = buffered.length
          ? [...messages, ...buffered.filter((b) => !messages.some((m) => sameMessage(m, b)))]
          : messages;
        setMessages(merged);
        setCurrentCwd(session.cwd);
        void client.patchSession(id, { unread: false });
        setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, unread: false } : s)));
      } finally {
        // Disarm the guard only if we're still the active load (a newer
        // selectSession may have re-armed it for a different session).
        if (loadingSessionRef.current === id) {
          loadingSessionRef.current = null;
          loadBufferRef.current = [];
        }
      }
    } else {
      loadingSessionRef.current = null;
      loadBufferRef.current = [];
    }
  }, []);
  selectSessionRef.current = selectSession;

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
    // Optimistically apply, capturing the prior mode so we can roll back if the
    // PATCH fails. approvalMode is a SECURITY control: when the request fails the
    // server keeps the old mode and never emits approval_mode_changed, so without
    // a revert the UI would silently show a mode the server isn't actually in
    // (e.g. read_only while the server is still yolo) until a reload.
    let previous: ApprovalMode | undefined;
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== sessionId) return s;
        previous = s.approvalMode;
        return { ...s, approvalMode: mode };
      }),
    );
    try {
      await client.setSessionApprovalMode(sessionId, mode);
    } catch (err) {
      if (previous !== undefined) {
        const reverted = previous;
        setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, approvalMode: reverted } : s)));
      }
      console.error(`setApprovalMode(${sessionId}, ${mode}) failed; reverted to ${previous}`, err);
    }
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

/**
 * Structural equality for the selectSession clobber-merge. Messages have no
 * stable server id, so we compare the fields that identify a turn output:
 * role, timestamp, tool-call id, and a cheap content fingerprint. Used only to
 * avoid double-inserting a buffered message_end that the snapshot already
 * contains — a false "not equal" at worst shows a transient duplicate that
 * self-heals on reselect, a false "equal" at worst drops the duplicate (the
 * snapshot copy wins), so erring toward the snapshot is safe.
 */
function sameMessage(a: ChatMessage, b: ChatMessage): boolean {
  if (a.role !== b.role) return false;
  if (a.toolCallId !== b.toolCallId) return false;
  if (a.timestamp !== undefined && b.timestamp !== undefined) {
    return a.timestamp === b.timestamp;
  }
  return contentFingerprint(a) === contentFingerprint(b);
}

function contentFingerprint(m: ChatMessage): string {
  if (typeof m.content === "string") return m.content;
  return m.content
    .map((c) => c.text ?? c.thinking ?? c.id ?? c.name ?? c.type)
    .join("\u0000");
}
