import { useEffect, useMemo, useRef, useState } from "react";
import { Login } from "./components/Login";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { HealthIcon } from "./components/HealthIcon";
import { ApprovalToggle } from "./components/ApprovalToggle";
import { Settings } from "./components/Settings";
import { TasksDialog } from "./components/TasksDialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { getToken } from "./lib/api";
import { useApp } from "./useApp";
import type { ApprovalMode } from "./lib/types";

export default function App() {
  const [loggedIn, setLoggedIn] = useState(() => getToken() !== null);
  if (!loggedIn) return <Login onLoggedIn={() => setLoggedIn(true)} />;
  return <Main />;
}

function Main() {
  const app = useApp();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // PWA manifest shortcuts (manifest.webmanifest > shortcuts) deep-link via
  // URL params (?action=new|tasks|settings). The OS launcher tap navigates
  // the installed PWA window — either by reusing an existing instance (Chrome
  // desktop fires popstate on the same-origin URL change) or by mounting a
  // fresh one. We handle both paths through one handler and clear the param
  // after firing so a refresh doesn't re-trigger the action.
  //
  // The handler is registered ONCE on mount via the empty dep array, and
  // reads the latest `app`/setters through a ref so we don't re-register
  // (and re-fire) on every render. `useApp()` returns a fresh object
  // literal per render and `Main` re-renders on every streamed token, so a
  // `[app]` dep would churn add/removeEventListener + re-invoke the handler
  // body per token — wasteful today, and a re-fire trap if any future
  // branch ever fails to clear the URL synchronously.
  const handlerStateRef = useRef({
    newSession: app.newSession,
    openTasks: () => setTasksOpen(true),
    openSettings: () => setSettingsOpen(true),
  });
  handlerStateRef.current.newSession = app.newSession;
  useEffect(() => {
    const handleAction = () => {
      const action = new URLSearchParams(window.location.search).get("action");
      if (!action) return;
      const s = handlerStateRef.current;
      if (action === "new") void s.newSession();
      else if (action === "tasks") s.openTasks();
      else if (action === "settings") s.openSettings();
      else return; // unknown action -> leave URL untouched for debugging
      // Clear the param so refresh / share-URL doesn't re-fire.
      window.history.replaceState(null, "", window.location.pathname);
    };
    handleAction();
    window.addEventListener("popstate", handleAction);
    return () => window.removeEventListener("popstate", handleAction);
  }, []);

  const runningTasks = Object.values(app.tasks).filter(
    (t) => t.status === "running" || t.status === "pending",
  ).length;
  const wsTitle =
    app.wsState === "unknown"
      ? "WebSocket: connecting…"
      : app.wsState === "ok"
        ? "WebSocket: connected"
        : "WebSocket: disconnected";
  const ltmTitle =
    app.ltmState === "unknown"
      ? "LTM: status unknown"
      : app.ltmState === "ok"
        ? "LTM: healthy"
        : `LTM: ${app.ltmLastError ?? "unhealthy"}`;

  const currentSession = useMemo(
    () => app.sessions.find((s) => s.id === app.currentId),
    [app.sessions, app.currentId],
  );
  const currentMode: ApprovalMode = currentSession?.approvalMode ?? "ask";

  const sidebarProps = {
    sessions: app.sessions,
    currentId: app.currentId,
    onNew: () => void app.newSession(),
    onArchived: () => void app.refreshSessions(),
    onOpenSettings: () => setSettingsOpen(true),
    onOpenTasks: () => setTasksOpen(true),
    runningTasks,
  };

  return (
    <div className="flex h-dvh bg-background text-foreground">
      {/* Desktop: permanent flex sibling. `md:contents` lets the inner aside be
          the direct flex child at md+, so the desktop layout is unchanged. */}
      <div className="hidden md:contents">
        <Sidebar {...sidebarProps} onSelect={(id) => void app.selectSession(id)} />
      </div>

      {/* Mobile: same Sidebar inside a slide-over drawer. */}
      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent side="left" className="w-72 max-w-[85vw] p-0" showCloseButton={false}>
          <SheetTitle className="sr-only">Sessions</SheetTitle>
          <Sidebar
            {...sidebarProps}
            onSelect={(id) => {
              setSidebarOpen(false);
              void app.selectSession(id);
            }}
          />
        </SheetContent>
      </Sheet>

      <Chat
        sessionId={app.currentId}
        messages={app.messages}
        streaming={app.streaming}
        running={currentSession?.running ?? false}
        compacting={app.sessions.find((s) => s.id === app.currentId)?.compacting ?? false}
        tasks={app.tasks}
        pendingApprovals={app.pendingApprovals}
        wsState={app.wsState}
        cwd={app.currentCwd}
        onCwdChange={app.setCurrentCwd}
        onSend={app.send}
        respondToApproval={app.respondToApproval}
        onMenuClick={() => setSidebarOpen(true)}
        headerRight={
          <>
            <ApprovalToggle
              mode={currentMode}
              onChange={(m) => app.currentId && app.setApprovalMode(app.currentId, m)}
              disabled={!app.currentId || !currentSession}
            />
            <HealthIcon kind="ws" state={app.wsState} title={wsTitle} />
            <HealthIcon kind="ltm" state={app.ltmState} title={ltmTitle} />
          </>
        }
      />
      <Settings open={settingsOpen} onOpenChange={setSettingsOpen} currentSessionId={app.currentId} />
      <TasksDialog open={tasksOpen} onOpenChange={setTasksOpen} tasks={app.tasks} />
    </div>
  );
}
