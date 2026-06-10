import type { ChatMessage, ModelInfo, SessionRow } from "./types";

const TOKEN_KEY = "ytsejam-token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token === null) localStorage.removeItem(TOKEN_KEY);
  else localStorage.setItem(TOKEN_KEY, token);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${getToken()}`,
      ...init?.headers,
    },
  });
  if (res.status === 401) {
    setToken(null);
    window.location.reload();
    throw new Error("unauthorized");
  }
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const client = {
  login: async (token: string): Promise<boolean> => {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    return res.ok;
  },
  listSessions: () => api<{ sessions: SessionRow[] }>("/api/sessions"),
  createSession: (model?: string) =>
    api<{ session: SessionRow }>("/api/sessions", { method: "POST", body: JSON.stringify({ model }) }),
  getSession: (id: string) => api<{ session: SessionRow; messages: ChatMessage[] }>(`/api/sessions/${id}`),
  sendMessage: (id: string, text: string) =>
    api<{ ok: true }>(`/api/sessions/${id}/messages`, { method: "POST", body: JSON.stringify({ text }) }),
  abort: (id: string) => api<{ ok: true }>(`/api/sessions/${id}/abort`, { method: "POST" }),
  patchSession: (id: string, patch: { title?: string; unread?: false; model?: string }) =>
    api<{ ok: true }>(`/api/sessions/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteSession: (id: string) => api<{ ok: true }>(`/api/sessions/${id}`, { method: "DELETE" }),
  getPersona: () => api<{ content: string }>("/api/persona"),
  savePersona: (content: string) =>
    api<{ ok: true }>("/api/persona", { method: "PUT", body: JSON.stringify({ content }) }),
  getModels: () => api<{ models: ModelInfo[]; defaultModel: string }>("/api/models"),
};
