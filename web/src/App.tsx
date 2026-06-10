import { useState } from "react";
import { Login } from "./components/Login";
import { getToken } from "./lib/api";
import { useApp } from "./useApp";

export default function App() {
  const [loggedIn, setLoggedIn] = useState(() => getToken() !== null);
  if (!loggedIn) return <Login onLoggedIn={() => setLoggedIn(true)} />;
  return <Main />;
}

function Main() {
  const app = useApp();
  return (
    <div className="flex h-screen bg-neutral-950 text-neutral-100">
      <aside className="w-72 shrink-0 border-r border-neutral-800 p-3">
        <p className="text-sm text-neutral-400">
          {app.connected ? "connected" : "reconnecting…"} · {app.sessions.length} sessions
        </p>
      </aside>
      <main className="flex flex-1 items-center justify-center text-neutral-500">
        chat UI coming in next task
      </main>
    </div>
  );
}
