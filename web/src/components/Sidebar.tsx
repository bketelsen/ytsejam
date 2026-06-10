import { Button } from "@/components/ui/button";
import { client } from "@/lib/api";
import type { SessionRow } from "@/lib/types";

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / 1440)}d`;
}

export function Sidebar({
  sessions,
  currentId,
  onSelect,
  onNew,
  onDeleted,
  onOpenSettings,
}: {
  sessions: SessionRow[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDeleted: (id: string) => void;
  onOpenSettings: () => void;
}) {
  async function remove(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm("Delete this session?")) return;
    await client.deleteSession(id);
    onDeleted(id);
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-neutral-800">
      <div className="flex items-center gap-2 p-3">
        <Button onClick={onNew} className="flex-1">
          New chat
        </Button>
        <Button variant="outline" onClick={onOpenSettings}>
          ⚙
        </Button>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {sessions.map((s) => (
          <div
            key={s.id}
            onClick={() => onSelect(s.id)}
            className={`group cursor-pointer rounded-md p-2 ${
              s.id === currentId ? "bg-neutral-800" : "hover:bg-neutral-900"
            }`}
          >
            <div className="flex items-center gap-2">
              {s.running && <span className="size-2 shrink-0 animate-pulse rounded-full bg-green-400" />}
              {s.unread && !s.running && <span className="size-2 shrink-0 rounded-full bg-blue-400" />}
              <span className="flex-1 truncate text-sm">{s.title ?? "New session"}</span>
              <span className="text-xs text-neutral-500">{timeAgo(s.updatedAt)}</span>
              <button
                onClick={(e) => remove(s.id, e)}
                className="hidden text-neutral-500 hover:text-red-400 group-hover:block"
                title="Delete"
              >
                ×
              </button>
            </div>
            <p className="truncate text-xs text-neutral-500">{s.preview}</p>
          </div>
        ))}
        {sessions.length === 0 && <p className="p-2 text-sm text-neutral-600">No sessions yet</p>}
      </nav>
    </aside>
  );
}
