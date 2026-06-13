import { useState } from "react";
import { Login } from "./components/Login";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { Settings } from "./components/Settings";
import { TasksDialog } from "./components/TasksDialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { getToken } from "./lib/api";
import { useApp } from "./useApp";

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
  const runningTasks = Object.values(app.tasks).filter(
    (t) => t.status === "running" || t.status === "pending",
  ).length;

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
        running={app.sessions.find((s) => s.id === app.currentId)?.running ?? false}
        compacting={app.sessions.find((s) => s.id === app.currentId)?.compacting ?? false}
        tasks={app.tasks}
        cwd={app.currentCwd}
        onCwdChange={app.setCurrentCwd}
        onSend={app.send}
        onMenuClick={() => setSidebarOpen(true)}
      />
      <Settings open={settingsOpen} onOpenChange={setSettingsOpen} currentSessionId={app.currentId} />
      <TasksDialog open={tasksOpen} onOpenChange={setTasksOpen} tasks={app.tasks} />
    </div>
  );
}
