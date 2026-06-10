import { useState } from "react";
import { Login } from "./components/Login";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { Settings } from "./components/Settings";
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
  return (
    <div className="flex h-screen bg-neutral-950 text-neutral-100">
      <Sidebar
        sessions={app.sessions}
        currentId={app.currentId}
        onSelect={(id) => void app.selectSession(id)}
        onNew={() => void app.newSession()}
        onDeleted={() => void app.refreshSessions()}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <Chat
        sessionId={app.currentId}
        messages={app.messages}
        streaming={app.streaming}
        running={app.sessions.find((s) => s.id === app.currentId)?.running ?? false}
        onSend={app.send}
      />
      <Settings open={settingsOpen} onOpenChange={setSettingsOpen} currentSessionId={app.currentId} />
    </div>
  );
}
