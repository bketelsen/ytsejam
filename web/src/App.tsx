import { useState } from "react";
import { Login } from "./components/Login";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { Settings } from "./components/Settings";
import { TasksDialog } from "./components/TasksDialog";
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
  const runningTasks = Object.values(app.tasks).filter(
    (t) => t.status === "running" || t.status === "pending",
  ).length;
  return (
    <div className="dark flex h-screen bg-background text-foreground">
      <Sidebar
        sessions={app.sessions}
        currentId={app.currentId}
        onSelect={(id) => void app.selectSession(id)}
        onNew={() => void app.newSession()}
        onDeleted={() => void app.refreshSessions()}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenTasks={() => setTasksOpen(true)}
        runningTasks={runningTasks}
      />
      <Chat
        sessionId={app.currentId}
        messages={app.messages}
        streaming={app.streaming}
        running={app.sessions.find((s) => s.id === app.currentId)?.running ?? false}
        tasks={app.tasks}
        onSend={app.send}
      />
      <Settings open={settingsOpen} onOpenChange={setSettingsOpen} currentSessionId={app.currentId} />
      <TasksDialog open={tasksOpen} onOpenChange={setTasksOpen} tasks={app.tasks} />
    </div>
  );
}
